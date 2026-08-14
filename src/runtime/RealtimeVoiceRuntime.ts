import { AUDIO_CHANNEL_COUNT, AUDIO_SAMPLE_RATE } from "@/constants";
import {
  LlmStatus,
  MicStatus,
  RuntimeStatus,
  SpeakingStatus,
  TtsStatus,
} from "@/enums";
import {
  findInputById,
  listAudioDevices,
  Microphone,
  pickMatchingOutput,
  pickPreferredInput,
  rootMeanSquare,
  type AudioDeviceInfo,
  type AudioDeviceLists,
} from "@/hearing";
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

export type AudioRouteSelection = {
  inputId?: string;
  outputId?: string;
};

/**
 * Half-duplex speech-to-speech runtime.
 *
 * Mic audio is sent only while listening/thinking. While the assistant is
 * preparing or speaking there is no barge-in.
 *
 * Bluetooth: capture without forcing sampleRate, resample to 24 kHz uplink,
 * and route playback to the output that shares groupId with the mic.
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
  private preferredInputId: string | undefined;
  private preferredOutputId: string | undefined;
  private deviceChangeHandler: (() => void) | null = null;
  private routing = false;

  getAudioDevices(): Promise<AudioDeviceLists> {
    return listAudioDevices();
  }

  /** Remember user picks; applies immediately if the session is already running. */
  async setAudioDevices(selection: AudioRouteSelection): Promise<void> {
    this.preferredInputId = selection.inputId;
    this.preferredOutputId = selection.outputId;
    if (!this.started) return;
    await this.applyAudioRouting({ forceInput: true });
  }

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
        this.mic.start(this.preferredInputId),
        this.transport.connect(),
      ]);

      await this.applyAudioRouting({ forceInput: false });
      this.watchDeviceChanges();

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

  /**
   * Prefer Bluetooth (or user pick), keep mic + speaker on the same headset
   * via MediaDeviceInfo.groupId, and setSinkId for playback.
   */
  private async applyAudioRouting(opts: {
    forceInput: boolean;
  }): Promise<void> {
    if (this.routing) return;
    this.routing = true;
    try {
      const { inputs, outputs } = await listAudioDevices();
      const preferredInput = pickPreferredInput(inputs, this.preferredInputId);
      const activeId = this.mic.activeDeviceId;
      const shouldSwitchInput =
        Boolean(preferredInput) &&
        (opts.forceInput ||
          (preferredInput &&
            preferredInput.deviceId !== activeId &&
            // Auto-switch to BT when OS still held the built-in mic.
            (Boolean(this.preferredInputId) ||
              /bluetooth|airpods|buds|headset/i.test(preferredInput.label))));

      if (shouldSwitchInput && preferredInput) {
        await this.mic.setDevice(preferredInput.deviceId);
      }

      const inputAfter =
        findInputById(inputs, this.mic.activeDeviceId) ?? preferredInput;
      const output = pickMatchingOutput(
        outputs,
        inputAfter,
        this.preferredOutputId,
      );

      await this.speaker.setOutputDevice(output?.deviceId);
      this.emitAudioRoute(inputAfter, output);
    } catch (error) {
      console.warn("[runtime] audio routing failed", error);
    } finally {
      this.routing = false;
    }
  }

  private emitAudioRoute(
    input?: AudioDeviceInfo,
    output?: AudioDeviceInfo,
  ): void {
    this.events.emit("audio:route", {
      inputId: input?.deviceId,
      inputLabel: input?.label,
      outputId: output?.deviceId,
      outputLabel: output?.label,
    });
  }

  private watchDeviceChanges(): void {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
    this.unwatchDeviceChanges();
    this.deviceChangeHandler = () => {
      if (!this.started) return;
      void this.applyAudioRouting({ forceInput: false });
    };
    navigator.mediaDevices.addEventListener(
      "devicechange",
      this.deviceChangeHandler,
    );
  }

  private unwatchDeviceChanges(): void {
    if (!this.deviceChangeHandler || typeof navigator === "undefined") return;
    navigator.mediaDevices.removeEventListener(
      "devicechange",
      this.deviceChangeHandler,
    );
    this.deviceChangeHandler = null;
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
    this.unwatchDeviceChanges();
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
