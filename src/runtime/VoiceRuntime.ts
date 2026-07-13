import {
  AUDIO_CHANNEL_COUNT,
  AUDIO_SAMPLE_RATE,
} from "@/constants";
import {
  BrowserCaption,
  Microphone,
  UtteranceDetector,
  isMeaningfulCaption,
  rootMeanSquare,
} from "@/hearing";
import { base64ToBytes } from "@/protocol";
import { SpeakerPlayer } from "@/speaking";
import { TransportClient } from "@/transport";
import {
  LlmStatus,
  MicStatus,
  RuntimeStatus,
  SpeakingStatus,
  SttStatus,
  TtsStatus,
} from "@/enums";
import { float32ToInt16 } from "@/utils";
import { EventBus } from "./EventBus";
import type { RuntimeEvents } from "./RuntimeEvents";
import { RuntimeState } from "./RuntimeState";

/**
 * Mic → caption idle ~1.2s → auto call → backend speech → Speaker.
 * End-of-turn uses caption gap, not mic level → 0.
 */
export class VoiceRuntime {
  readonly events = new EventBus<RuntimeEvents>();
  readonly state = new RuntimeState();

  private readonly mic = new Microphone({
    sampleRate: AUDIO_SAMPLE_RATE,
    channelCount: AUDIO_CHANNEL_COUNT,
  });
  private readonly caption = new BrowserCaption();
  private readonly transport = new TransportClient();
  private readonly speaker = new SpeakerPlayer();
  private readonly utterance = new UtteranceDetector();

  private started = false;
  private bound = false;
  /** False while waiting for / playing AI response. */
  private acceptingSpeech = true;
  private levelEmitAt = 0;

  async start(): Promise<void> {
    if (this.started) return;

    this.started = true;
    this.setRuntime(RuntimeStatus.Starting);

    try {
      this.bindOnce();

      this.setStt(SttStatus.Connecting);
      this.setLlm(LlmStatus.Connecting);
      this.setTts(TtsStatus.Connecting);

      await this.transport.connect();
      // Unlock speaker AudioContext on the same user gesture as Start.
      await this.speaker.enqueue({
        pcm: new Int16Array(160),
        sampleRate: AUDIO_SAMPLE_RATE,
        timestamp: performance.now(),
      });

      this.setStt(SttStatus.Streaming);
      this.setLlm(LlmStatus.Idle);
      this.setTts(TtsStatus.Idle);

      await this.mic.start();
      try {
        if (this.caption.supported) this.caption.start("vi-VN");
      } catch {
        // Captions are optional — audio path must keep working.
      }

      this.utterance.reset();
      this.acceptingSpeech = true;
      this.setMic(MicStatus.Capturing);
      this.setRuntime(RuntimeStatus.Running);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.state.setError(err);
      this.setRuntime(RuntimeStatus.Error);
      this.events.emit("runtime:error", err);
      this.started = false;
      await this.teardown();
      throw err;
    }
  }

  /** Manual trigger kept for debugging; normal path is auto after silence. */
  call(): void {
    this.beginAssistantTurn();
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

  private beginAssistantTurn(): void {
    if (!this.started || !this.transport.isOpen) return;
    if (!this.acceptingSpeech) return;

    const caption =
      this.utterance.lastText ||
      this.state.get().partialTranscript ||
      this.state.get().finalTranscript;

    // Hard gate: noise / no caption / meaningless crumbs → stay listening.
    if (!isMeaningfulCaption(caption)) {
      this.utterance.reset();
      return;
    }

    this.acceptingSpeech = false;
    this.utterance.reset();
    this.state.clearAssistantText();
    this.setLlm(LlmStatus.Streaming);
    this.caption.stop();
    this.transport.call(caption);
  }

  private bindOnce(): void {
    if (this.bound) return;
    this.bound = true;

    this.caption.onCaption((text, isFinal) => {
      if (!this.acceptingSpeech) return;

      // Ignore noise hallucinations like "Phẩy. Phẩy." entirely.
      if (!isMeaningfulCaption(text)) return;

      this.utterance.noteCaption(text);

      if (isFinal) {
        const previous = this.state.get().finalTranscript;
        const merged = previous ? `${previous} ${text}`.trim() : text;
        this.state.setFinalTranscript(merged);
        this.state.setPartialTranscript("");
        this.events.emit("stt:transcript", { text: merged, isFinal: true });
      } else {
        this.state.setPartialTranscript(text);
        this.events.emit("stt:transcript", { text, isFinal: false });
      }

      if (this.utterance.tick()) {
        this.beginAssistantTurn();
      }
    });

    this.mic.onFrame((frame) => {
      this.events.emit("mic:frame", frame);

      const level = Math.min(1, rootMeanSquare(frame.samples) * 8);
      this.state.setMicLevel(level);
      const now = performance.now();
      if (now - this.levelEmitAt > 80) {
        this.levelEmitAt = now;
        this.events.emit("mic:level", level);
      }

      if (!this.acceptingSpeech) return;

      this.transport.sendAudio(float32ToInt16(frame.samples));

      // End turn when caption has been idle — ignore mic floor noise.
      if (this.utterance.tick(now)) {
        this.beginAssistantTurn();
      }
    });

    this.transport.setHandler({
      transcript: () => undefined,
      ai: (message) => {
        if (message.phase === "started") {
          this.setLlm(LlmStatus.Streaming);
          this.state.clearAssistantText();
          return;
        }
        if (message.phase === "delta" && message.delta) {
          this.state.appendAssistantText(message.delta);
          this.events.emit("llm:token", { text: message.delta, done: false });
          return;
        }
        if (message.phase === "done") {
          this.events.emit("llm:token", { text: "", done: true });
          this.setLlm(LlmStatus.Idle);
        }
      },
      control: (message) => {
        switch (message.action) {
          case "tts_started":
            this.setTts(TtsStatus.Streaming);
            this.setSpeaking(SpeakingStatus.Buffering);
            break;
          case "tts_finished":
            this.setTts(TtsStatus.Idle);
            this.setSpeaking(SpeakingStatus.Idle);
            this.acceptingSpeech = true;
            this.utterance.reset();
            try {
              if (this.started && this.caption.supported) {
                this.caption.start("vi-VN");
              }
            } catch {
              // optional
            }
            break;
          case "error": {
            const err = new Error(message.message ?? "Voice runtime error");
            this.state.setError(err);
            this.events.emit("runtime:error", err);
            this.setRuntime(RuntimeStatus.Error);
            this.acceptingSpeech = true;
            break;
          }
          default:
            break;
        }
      },
      audio: async (message) => {
        this.setSpeaking(SpeakingStatus.Playing);
        await this.speaker.enqueueEncoded({
          codec: message.codec,
          data: base64ToBytes(message.data),
          sampleRate: message.sampleRate,
          timestamp: message.timestamp,
        });
      },
    });
  }

  private async teardown(): Promise<void> {
    this.caption.stop();
    this.utterance.reset();
    this.acceptingSpeech = true;
    await Promise.allSettled([
      this.mic.stop(),
      Promise.resolve(this.transport.disconnect()),
      this.speaker.stop(),
    ]);
  }

  private setRuntime(status: RuntimeStatus): void {
    this.state.setRuntime(status);
    this.events.emit("runtime:status", status);
  }

  private setMic(status: MicStatus): void {
    this.state.setMic(status);
    this.events.emit("mic:status", status);
  }

  private setStt(status: SttStatus): void {
    this.state.setStt(status);
    this.events.emit("stt:status", status);
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
