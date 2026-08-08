import { AUDIO_CHANNEL_COUNT, AUDIO_SAMPLE_RATE } from "@/constants";
import {
  LlmStatus,
  MicStatus,
  RuntimeStatus,
  SpeakingStatus,
  TtsStatus,
} from "@/enums";
import { Microphone, rootMeanSquare } from "@/hearing";
import { base64ToInt16 } from "@/protocol";
import { SpeakerPlayer } from "@/speaking";
import { TransportClient } from "@/transport";
import { float32ToInt16 } from "@/utils";
import { EventBus } from "./EventBus";
import type { RuntimeEvents } from "./RuntimeEvents";
import { RuntimeState } from "./RuntimeState";

export type TurnPhase =
  | "listening"
  | "thinking"
  | "preparing"
  | "speaking"
  | "echo_hold";

/** Wait after speaker stops before opening the mic again. */
const ECHO_SETTLE_MS = 400;

/**
 * Half-duplex speech-to-speech runtime.
 *
 * Mic audio is sent only while listening/thinking. While the assistant is
 * preparing or speaking there is no barge-in.
 */
export class RealtimeVoiceRuntime {
  readonly events = new EventBus<RuntimeEvents>();
  readonly state = new RuntimeState();

  private readonly mic = new Microphone({
    sampleRate: AUDIO_SAMPLE_RATE,
    channelCount: AUDIO_CHANNEL_COUNT,
  });
  private readonly transport = new TransportClient();
  private readonly speaker = new SpeakerPlayer();

  private started = false;
  private bound = false;
  private levelEmitAt = 0;
  private userSpeaking = false;
  private responseDone = true;
  private currentAssistantItemId = "";
  private interruptedItemId = "";
  private gate: TurnPhase = "listening";
  private listenEpoch = 0;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.setRuntime(RuntimeStatus.Starting);

    try {
      this.bindOnce();
      this.setLlm(LlmStatus.Connecting);
      this.setTts(TtsStatus.Connecting);

      // Unlock AudioContext + mic inside the Start click gesture (mobile).
      await Promise.all([
        this.speaker.enqueue({
          pcm: new Int16Array(240),
          sampleRate: AUDIO_SAMPLE_RATE,
          timestamp: performance.now(),
        }),
        this.mic.start(),
        this.transport.connect(),
      ]);

      this.setMic(MicStatus.Capturing);
      this.setLlm(LlmStatus.Idle);
      this.setTts(TtsStatus.Idle);
      this.setGate("listening");
      this.setRuntime(RuntimeStatus.Running);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.state.setError(err);
      this.events.emit("runtime:error", err);
      this.setRuntime(RuntimeStatus.Error);
      this.started = false;
      await this.teardown();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.started && this.state.get().runtime === RuntimeStatus.Idle) return;
    this.setRuntime(RuntimeStatus.Stopping);
    this.transport.stop();
    await this.teardown();
    this.state.reset();
    this.started = false;
    this.setRuntime(RuntimeStatus.Idle);
  }

  private bindOnce(): void {
    if (this.bound) return;
    this.bound = true;

    this.mic.onFrame((frame) => {
      if (!this.isMicOpen()) {
        this.emitMicLevel(0);
        return;
      }

      const level = Math.min(1, rootMeanSquare(frame.samples) * 8);
      this.emitMicLevel(level);
      this.transport.sendAudio(float32ToInt16(frame.samples));
    });

    this.speaker.on("speaker_started", () => {
      this.setGate("speaking");
      this.setSpeaking(SpeakingStatus.Playing);
      this.setTts(TtsStatus.Streaming);
      this.state.setThinking(false);
      this.events.emit("runtime:thinking", { thinking: false, message: "" });
    });

    this.speaker.on("speaker_finished", () => {
      this.setSpeaking(SpeakingStatus.Idle);
      this.maybeResumeListening();
    });

    this.transport.setHandler({
      control: (message) => {
        switch (message.action) {
          case "session_started":
            this.setLlm(LlmStatus.Idle);
            this.setTts(TtsStatus.Idle);
            break;
          case "speech_started": {
            if (!this.isMicOpen()) break;
            this.userSpeaking = true;
            this.setGate("listening");
            break;
          }
          case "speech_stopped":
            if (!this.isMicOpen()) break;
            this.userSpeaking = false;
            this.setGate("thinking");
            this.setLlm(LlmStatus.Streaming);
            this.state.setThinking(true, "WALL-E đang nghe và suy nghĩ...");
            this.events.emit("runtime:thinking", {
              thinking: true,
              message: "WALL-E đang nghe và suy nghĩ...",
            });
            break;
          case "response_started":
            this.listenEpoch += 1;
            this.responseDone = false;
            this.interruptedItemId = "";
            this.currentAssistantItemId = "";
            this.userSpeaking = false;
            this.setGate("preparing");
            this.emitMicLevel(0);
            this.setLlm(LlmStatus.Streaming);
            this.setTts(TtsStatus.Streaming);
            this.setSpeaking(SpeakingStatus.Buffering);
            break;
          case "audio_end":
            if (
              !message.itemId ||
              message.itemId !== this.interruptedItemId
            ) {
              this.speaker.pushStreamFrame({
                pcm: new Int16Array(0),
                sampleRate: AUDIO_SAMPLE_RATE,
                phraseId: message.phraseId ?? 0,
                frameIndex: Number.MAX_SAFE_INTEGER,
                isLast: true,
                turnId: message.turnId,
              });
            }
            break;
          case "tts_finished":
            this.responseDone = true;
            this.setLlm(LlmStatus.Idle);
            this.setTts(TtsStatus.Idle);
            this.state.setThinking(false);
            this.events.emit("runtime:thinking", {
              thinking: false,
              message: "",
            });
            this.maybeResumeListening();
            break;
          case "error": {
            const error = new Error(message.message ?? "Realtime voice error");
            this.state.setError(error);
            this.events.emit("runtime:error", error);
            this.setRuntime(RuntimeStatus.Error);
            break;
          }
          default:
            break;
        }
      },
      audio: (message) => {
        if (
          message.itemId &&
          this.interruptedItemId &&
          message.itemId === this.interruptedItemId
        ) {
          return;
        }
        if (message.itemId) this.currentAssistantItemId = message.itemId;
        this.setSpeaking(SpeakingStatus.Buffering);
        this.setTts(TtsStatus.Streaming);
        this.speaker.pushStreamFrame({
          pcm: base64ToInt16(message.data),
          sampleRate: message.sampleRate,
          phraseId: message.phraseId ?? 0,
          frameIndex: message.frameIndex ?? message.sequence,
          isLast: message.isLast ?? false,
          turnId: message.turnId,
        });
      },
      transcript: (message) => {
        if (!message.itemId || !message.text.trim()) return;
        this.events.emit("user:transcript", {
          itemId: message.itemId,
          text: message.text,
          isFinal: message.isFinal,
        });
      },
      ai: (message) => {
        if (message.phase === "delta" && message.delta) {
          this.events.emit("llm:token", {
            text: message.delta,
            done: false,
          });
        } else if (message.phase === "done") {
          this.events.emit("llm:token", { text: "", done: true });
        }
      },
    });
  }

  private isMicOpen(): boolean {
    return this.gate === "listening" || this.gate === "thinking";
  }

  private emitMicLevel(level: number): void {
    this.state.setMicLevel(level);
    const now = performance.now();
    if (level === 0 || now - this.levelEmitAt >= 80) {
      this.levelEmitAt = now;
      this.events.emit("mic:level", level);
    }
  }

  private maybeResumeListening(): void {
    if (!this.responseDone || this.speaker.isPlaying || this.userSpeaking) return;
    if (this.gate === "listening" || this.gate === "thinking") return;

    const epoch = ++this.listenEpoch;
    this.setGate("echo_hold");
    this.emitMicLevel(0);
    setTimeout(() => {
      if (!this.started || epoch !== this.listenEpoch) return;
      this.transport.listenResume();
      this.returnToListening();
    }, ECHO_SETTLE_MS);
  }

  private returnToListening(): void {
    this.setGate("listening");
    this.setSpeaking(SpeakingStatus.Idle);
    this.setLlm(LlmStatus.Idle);
    this.setTts(TtsStatus.Idle);
  }

  private async teardown(): Promise<void> {
    this.listenEpoch += 1;
    this.userSpeaking = false;
    this.responseDone = true;
    this.currentAssistantItemId = "";
    this.interruptedItemId = "";
    this.gate = "listening";
    await Promise.allSettled([
      this.mic.stop(),
      Promise.resolve(this.transport.disconnect()),
      this.speaker.stop(),
    ]);
  }

  private setGate(phase: TurnPhase): void {
    this.gate = phase;
    this.state.setTurnPhase(phase);
    this.events.emit("runtime:turn", phase);
  }

  private setRuntime(status: RuntimeStatus): void {
    this.state.setRuntime(status);
    this.events.emit("runtime:status", status);
  }

  private setMic(status: MicStatus): void {
    this.state.setMic(status);
    this.events.emit("mic:status", status);
  }

  private setLlm(status: LlmStatus): void {
    this.state.setLlm(status);
    this.events.emit("llm:status", status);
  }

  private setTts(status: TtsStatus): void {
    this.state.setTts(status);
    this.events.emit("tts:status", status);
  }

  private setSpeaking(status: SpeakingStatus): void {
    this.state.setSpeaking(status);
    this.events.emit("speaking:status", status);
  }
}
