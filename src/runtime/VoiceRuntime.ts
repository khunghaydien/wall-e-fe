import {
  AUDIO_CHANNEL_COUNT,
  AUDIO_SAMPLE_RATE,
} from "@/constants";
import {
  BrowserCaption,
  Microphone,
  isMeaningfulCaption,
  looksLikeAssistantEcho,
  rootMeanSquare,
  stripAssistantEcho,
} from "@/hearing";
import { base64ToBytes, base64ToInt16 } from "@/protocol";
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

/** After local playback is idle, adaptive settle before opening caption. */
const ECHO_SETTLE_MIN_MS = 120;
const ECHO_SETTLE_MAX_MS = 500;
/** Text filter window after reopen (tail-of-reply bleed). */
const ECHO_GUARD_MS = 4_000;
const SPEAKER_IDLE_TIMEOUT_MS = 30_000;
/** Local silence after last NEW caption → force dispatch (don't stay in listening). */
const LOCAL_EOS_MS = 1_200;
/** If preparing/speaking stalls with no progress, force listen again. */
const STUCK_PREPARING_MS = 12_000;
const STUCK_SPEAKING_MS = 20_000;

export type TurnPhase =
  | "listening"
  | "thinking"
  | "preparing"
  | "speaking"
  | "echo_hold";

/**
 * Stream + revise turn-taking:
 * - listening: caption on, hear user.
 * - thinking: caption STAYS on — if user keeps talking → revise (abort mid-reply).
 * - preparing: TTS synthesizing / audio buffering — caption STAYS on for revise.
 * - speaking: speaker_started (first audible PCM) — caption off, revise locked.
 * - echo_hold: caption off until speaker is stably silent, then listen again.
 * - After true EOS: answer once with the merged utterance.
 *
 * Mic is never played to the speaker (user never hears themselves).
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

  private started = false;
  private bound = false;
  private gate: TurnPhase = "listening";
  private levelEmitAt = 0;
  private listenEpoch = 0;
  private lastAssistantText = "";
  private echoGuardUntil = 0;
  /** Seed utterance that triggered the in-flight AI turn (for revise). */
  private dispatchedSeed = "";
  private stuckTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAudioAt = 0;
  private eosTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEosCaption = "";

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
      await this.speaker.enqueue({
        pcm: new Int16Array(160),
        sampleRate: AUDIO_SAMPLE_RATE,
        timestamp: performance.now(),
      });

      this.setStt(SttStatus.Streaming);
      this.setLlm(LlmStatus.Idle);
      this.setTts(TtsStatus.Idle);

      await this.mic.start();
      this.openListening();

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

  call(): void {
    this.finishListeningTurn();
  }

  /** Caption went quiet → leave listening and ask the backend to answer. */
  private finishListeningTurn(): void {
    this.clearEosTimer();
    if (!this.started || !this.transport.isOpen) return;
    if (this.gate !== "listening") return;

    const caption = (
      this.state.get().finalTranscript ||
      this.state.get().partialTranscript
    ).trim();
    if (!isMeaningfulCaption(caption)) return;

    this.dispatchedSeed = caption;
    this.lastEosCaption = "";
    this.setGate("thinking");
    this.transport.call(caption);
  }

  private clearEosTimer(): void {
    if (this.eosTimer) {
      clearTimeout(this.eosTimer);
      this.eosTimer = null;
    }
  }

  /**
   * Arm local end-of-speech. Only resets when caption text changes so repeated
   * identical Web Speech events cannot keep us in listening forever.
   */
  private noteListeningCaption(text: string): void {
    if (this.gate !== "listening") return;
    const normalized = text.trim();
    if (!normalized || !isMeaningfulCaption(normalized)) return;
    if (normalized === this.lastEosCaption) return;

    this.lastEosCaption = normalized;
    this.clearEosTimer();
    this.eosTimer = setTimeout(() => {
      this.eosTimer = null;
      this.finishListeningTurn();
    }, LOCAL_EOS_MS);
  }

  async stop(): Promise<void> {
    if (!this.started && this.state.get().runtime === RuntimeStatus.Idle) return;

    this.setRuntime(RuntimeStatus.Stopping);
    this.listenEpoch += 1;
    this.transport.stop();
    await this.teardown();
    this.state.reset();
    this.started = false;
    this.setRuntime(RuntimeStatus.Idle);
  }

  private startCaption(): void {
    try {
      if (this.started && this.caption.supported) {
        this.caption.start("vi-VN");
      }
    } catch {
      // optional
    }
  }

  private stopCaption(): void {
    this.caption.stop();
    this.state.setPartialTranscript("");
  }

  private setGate(phase: TurnPhase): void {
    this.gate = phase;
    this.state.setTurnPhase(phase);
    this.events.emit("runtime:turn", phase);
    if (phase !== "listening") {
      this.clearEosTimer();
    }
    this.armStuckWatchdog(phase);
  }

  private clearStuckWatchdog(): void {
    if (this.stuckTimer) {
      clearTimeout(this.stuckTimer);
      this.stuckTimer = null;
    }
  }

  /** Recover if TTS hangs and tts_finished never arrives. */
  private armStuckWatchdog(phase: TurnPhase): void {
    this.clearStuckWatchdog();
    if (phase !== "preparing" && phase !== "speaking") return;

    const waitMs = phase === "preparing" ? STUCK_PREPARING_MS : STUCK_SPEAKING_MS;
    const epoch = this.listenEpoch;
    this.stuckTimer = setTimeout(() => {
      if (!this.started || epoch !== this.listenEpoch) return;
      if (this.gate !== "preparing" && this.gate !== "speaking") return;
      // Speaking with recent audio is fine — only bail if truly idle/stuck.
      if (
        this.gate === "speaking" &&
        (this.speaker.isPlaying || performance.now() - this.lastAudioAt < 3_000)
      ) {
        this.armStuckWatchdog("speaking");
        return;
      }
      console.warn(`[runtime] stuck in ${this.gate} — forcing listen`);
      this.speaker.flush();
      this.setTts(TtsStatus.Idle);
      this.setSpeaking(SpeakingStatus.Idle);
      this.state.setThinking(false);
      void this.resumeListeningAfterEcho();
    }, waitMs);
  }

  private openListening(): void {
    this.clearEosTimer();
    this.lastEosCaption = "";
    this.setGate("listening");
    this.dispatchedSeed = "";
    this.state.setPartialTranscript("");
    this.state.setFinalTranscript("");
    this.startCaption();
  }

  private async resumeListeningAfterEcho(): Promise<void> {
    const epoch = ++this.listenEpoch;
    this.setGate("echo_hold");
    this.stopCaption();

    // Wait until the speaker is truly idle, then for stable silence.
    await Promise.race([
      this.speaker.whenSilent({
        minQuietMs: 80,
        maxWaitMs: 600,
        threshold: 0.025,
      }),
      sleep(SPEAKER_IDLE_TIMEOUT_MS),
    ]);

    // Adaptive settle: shorter replies reopen mic sooner; long replies
    // get a bit more room-reverb margin (no fixed 1s hold).
    const settleMs = adaptiveEchoSettleMs(this.speaker.lastSpeakDurationMs);
    await sleep(settleMs);

    if (!this.started || epoch !== this.listenEpoch) return;

    this.state.setPartialTranscript("");
    this.state.setFinalTranscript("");
    this.echoGuardUntil = performance.now() + ECHO_GUARD_MS;
    this.openListening();
  }

  private resumeListeningForRevise(merged: string): void {
    this.listenEpoch += 1;
    this.speaker.flush();
    this.setGate("listening");
    this.dispatchedSeed = "";
    this.lastAssistantText = "";
    this.echoGuardUntil = 0;
    this.state.setThinking(false);
    const clean = merged.trim();
    this.state.setFinalTranscript(clean);
    this.state.setPartialTranscript("");
    if (!this.caption.isActive) {
      this.startCaption();
    }
    this.events.emit("runtime:revise", { text: clean });
    this.events.emit("stt:transcript", { text: clean, isFinal: true });
  }

  private acceptCaption(raw: string): string | null {
    // Caption stays on through preparing (revise). Hard-gate only once
    // speaker is audible or during echo settle.
    if (this.gate === "echo_hold" || this.gate === "speaking") {
      return null;
    }

    let text = raw.trim();
    if (!text) return null;

    // After TTS: drop speaker→mic bleed (often only the last clause, ASR-garbled).
    if (
      this.gate === "listening" &&
      performance.now() < this.echoGuardUntil &&
      this.lastAssistantText
    ) {
      if (looksLikeAssistantEcho(text, this.lastAssistantText)) {
        return null;
      }
      text = stripAssistantEcho(text, this.lastAssistantText);
      if (!text || looksLikeAssistantEcho(text, this.lastAssistantText)) {
        return null;
      }
    }

    if (!isMeaningfulCaption(text)) return null;
    return text;
  }

  /** Kill Web Speech so Mac speaker audio cannot become captions. */
  private silenceCaptionForTts(): void {
    this.stopCaption();
  }

  private bindOnce(): void {
    if (this.bound) return;
    this.bound = true;

    this.speaker.on("speaker_started", () => {
      // UI + gate must track real audio out — not TTS enqueue / decode.
      // From this point revise is locked (notify BE).
      this.lastAudioAt = performance.now();
      if (this.gate !== "speaking") {
        this.setGate("speaking");
        this.state.setThinking(false);
        this.events.emit("runtime:thinking", {
          thinking: false,
          message: "",
        });
      } else {
        this.armStuckWatchdog("speaking");
      }
      this.silenceCaptionForTts();
      this.transport.speakerStarted();
      this.setSpeaking(SpeakingStatus.Playing);
      this.setTts(TtsStatus.Streaming);
    });

    this.speaker.on("speaker_finished", () => {
      // Playback drained for this turn. Echo reopen still follows tts_finished
      // via resumeListeningAfterEcho so mid-stream phrases stay gated.
      if (this.gate === "speaking" && !this.speaker.isPlaying) {
        this.setSpeaking(SpeakingStatus.Idle);
      }
    });

    this.caption.onCaption((raw, isFinal) => {
      if (this.gate === "echo_hold" || this.gate === "speaking") {
        return;
      }

      const text = this.acceptCaption(raw);
      if (!text) return;

      // Thinking + preparing: revise if user ADDED words. Locked after
      // speaker_started (speaking) to avoid Mac speaker bleed as revise.
      if (this.gate === "thinking" || this.gate === "preparing") {
        const seed =
          this.dispatchedSeed ||
          this.state.get().finalTranscript ||
          this.state.get().partialTranscript;
        if (!addsNewSpeechLocal(seed, text)) return;

        this.transport.sendTranscript(text, isFinal);

        const merged = mergeLocal(seed, text);
        this.state.setFinalTranscript(merged);
        this.state.setPartialTranscript(isFinal ? "" : text);
        this.events.emit("stt:transcript", {
          text: merged,
          isFinal,
        });
        return;
      }

      if (this.gate !== "listening") return;

      this.transport.sendTranscript(text, isFinal);

      if (isFinal) {
        const previous = this.state.get().finalTranscript;
        const merged = previous ? mergeLocal(previous, text) : text;
        if (!isMeaningfulCaption(merged)) return;
        this.state.setFinalTranscript(merged);
        this.state.setPartialTranscript("");
        this.events.emit("stt:transcript", { text: merged, isFinal: true });
        this.noteListeningCaption(merged);
      } else {
        this.state.setPartialTranscript(text);
        this.events.emit("stt:transcript", { text, isFinal: false });
        this.noteListeningCaption(text);
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

      // Never play mic to speaker. Only send PCM while listening (VAD/EOS).
      if (this.gate !== "listening") return;
      this.transport.sendAudio(float32ToInt16(frame.samples));
    });

    this.transport.setHandler({
      transcript: (message) => {
        if (!message.isFinal || !message.text.trim()) return;
        if (this.gate === "echo_hold") return;
        const cleaned = message.text.trim();
        if (!isMeaningfulCaption(cleaned)) return;
        this.events.emit("stt:transcript", { text: cleaned, isFinal: true });
      },
      ai: (message) => {
        if (message.phase === "started") {
          this.setGate("thinking");
          this.lastAssistantText = "";
          if (!this.dispatchedSeed) {
            this.dispatchedSeed =
              this.state.get().finalTranscript ||
              this.state.get().partialTranscript;
          }
          // Keep caption on for revise.
          if (!this.caption.isActive) this.startCaption();
          this.setLlm(LlmStatus.Streaming);
          return;
        }
        if (message.phase === "delta" && message.delta) {
          this.lastAssistantText += message.delta;
          this.state.setThinking(false);
          this.events.emit("runtime:thinking", {
            thinking: false,
            message: "",
          });
          this.events.emit("llm:token", { text: message.delta, done: false });
          return;
        }
        if (message.phase === "done") {
          this.events.emit("llm:token", { text: "", done: true });
          this.setLlm(LlmStatus.Idle);
          // Text is complete — TTS may still be synthesizing. Keep caption on
          // for revise until speaker_started.
          if (this.gate === "thinking") {
            this.setGate("preparing");
            if (!this.caption.isActive) this.startCaption();
            this.setSpeaking(SpeakingStatus.Buffering);
            this.setTts(TtsStatus.Streaming);
          }
        }
      },
      control: (message) => {
        switch (message.action) {
          case "thinking":
            this.setGate("thinking");
            if (!this.dispatchedSeed) {
              this.dispatchedSeed =
                this.state.get().finalTranscript ||
                this.state.get().partialTranscript;
            }
            if (!this.caption.isActive) this.startCaption();
            this.state.setThinking(true, message.message);
            this.setLlm(LlmStatus.Streaming);
            this.events.emit("runtime:thinking", {
              thinking: true,
              message: message.message ?? "Đang nghĩ...",
            });
            break;
          case "tts_started":
            // Synth began — prepare UI. Keep caption on for revise until
            // speaker_started locks the turn.
            if (this.gate !== "speaking") {
              this.setGate("preparing");
              if (!this.caption.isActive) this.startCaption();
            }
            this.setTts(TtsStatus.Streaming);
            if (this.gate !== "speaking") {
              this.setSpeaking(SpeakingStatus.Buffering);
            }
            break;
          case "tts_finished":
            this.clearStuckWatchdog();
            this.setTts(TtsStatus.Idle);
            this.state.setThinking(false);
            this.events.emit("runtime:thinking", {
              thinking: false,
              message: "",
            });
            void this.resumeListeningAfterEcho().then(() => {
              this.setSpeaking(SpeakingStatus.Idle);
            });
            break;
          case "interrupt": {
            const isRevise = message.message === "revise";
            this.speaker.flush();
            this.state.setThinking(false);
            this.setSpeaking(SpeakingStatus.Idle);
            this.setTts(TtsStatus.Idle);
            this.setLlm(LlmStatus.Idle);
            this.events.emit("runtime:thinking", {
              thinking: false,
              message: "",
            });

            if (isRevise) {
              const merged =
                this.state.get().finalTranscript ||
                this.state.get().partialTranscript;
              // During preparing revise, lastAssistantText is the aborted draft —
              // only strip if it looks like echo bleed, not user additions.
              const clean = merged.trim();
              this.lastAssistantText = "";
              this.resumeListeningForRevise(clean);
            } else {
              void this.resumeListeningAfterEcho();
            }
            break;
          }
          case "metrics":
            this.state.setMetrics(message.metrics ?? null);
            this.events.emit("runtime:metrics", message.metrics ?? null);
            break;
          case "error": {
            const err = new Error(message.message ?? "Voice runtime error");
            this.state.setError(err);
            this.events.emit("runtime:error", err);
            this.setRuntime(RuntimeStatus.Error);
            this.state.setThinking(false);
            void this.resumeListeningAfterEcho();
            break;
          }
          default:
            break;
        }
      },
      audio: async (message) => {
        if (this.gate === "thinking") {
          this.setGate("preparing");
          if (!this.caption.isActive) this.startCaption();
        } else if (this.gate !== "preparing" && this.gate !== "speaking") {
          return;
        }

        this.lastAudioAt = performance.now();
        if (this.gate === "preparing") {
          this.armStuckWatchdog("preparing");
        } else if (this.gate === "speaking") {
          this.armStuckWatchdog("speaking");
        }
        if (this.gate !== "speaking") {
          this.setSpeaking(SpeakingStatus.Buffering);
        }
        this.setTts(TtsStatus.Streaming);

        try {
          const isStreamPcm =
            message.codec === "pcm_s16le" &&
            message.frameIndex !== undefined &&
            message.phraseId !== undefined;

          if (isStreamPcm) {
            this.speaker.pushStreamFrame({
              pcm: base64ToInt16(message.data),
              sampleRate: message.sampleRate,
              phraseId: message.phraseId!,
              frameIndex: message.frameIndex!,
              isLast: message.isLast ?? false,
              turnId: message.turnId,
            });
            return;
          }

          await this.speaker.enqueueEncoded({
            codec: message.codec,
            data: base64ToBytes(message.data),
            sampleRate: message.sampleRate,
            timestamp: message.timestamp,
          });
        } catch (error) {
          console.error("[speaker] enqueue failed", error);
        }
      },
    });
  }

  private async teardown(): Promise<void> {
    this.clearStuckWatchdog();
    this.clearEosTimer();
    this.stopCaption();
    this.setGate("listening");
    this.lastAssistantText = "";
    this.echoGuardUntil = 0;
    this.dispatchedSeed = "";
    this.lastEosCaption = "";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Scale reopen delay with how long the speaker was active. */
function adaptiveEchoSettleMs(speakDurationMs: number): number {
  if (speakDurationMs <= 0) return ECHO_SETTLE_MIN_MS;
  const scaled = Math.round(speakDurationMs * 0.05);
  return Math.min(ECHO_SETTLE_MAX_MS, Math.max(ECHO_SETTLE_MIN_MS, scaled));
}

function mergeLocal(prev: string, next: string): string {
  const a = prev.trim();
  const b = next.trim();
  if (!a) return b;
  if (!b) return a;
  if (b.startsWith(a)) return b;
  if (a.includes(b)) return a;
  if (b.includes(a)) return b;
  return `${a} ${b}`.trim();
}

function addsNewSpeechLocal(seed: string, next: string): boolean {
  const a = seed
    .toLocaleLowerCase("vi")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const b = next
    .toLocaleLowerCase("vi")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!b) return false;
  if (!a) return true;
  if (a === b || a.includes(b)) return false;
  if (b.startsWith(a) && b.length > a.length + 2) return true;
  const aWords = new Set(a.match(/\p{L}+/gu) ?? []);
  const bWords = b.match(/\p{L}+/gu) ?? [];
  let novel = 0;
  for (const w of bWords) {
    if (!aWords.has(w)) novel += 1;
  }
  return novel >= 2 || (novel >= 1 && b.length > a.length + 5);
}
