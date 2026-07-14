import { int16ToFloat32 } from "@/utils";
import type { AudioChunk } from "@/types";
import type { AudioCodec } from "@/protocol";

export type EncodedAudioChunk = {
  codec: AudioCodec;
  data: Uint8Array;
  sampleRate: number;
  timestamp: number;
};

export type SpeakerEvent = "speaker_started" | "speaker_finished";

type SpeakerListener = () => void;

/**
 * Reliable speaker queue for PCM / MP3.
 * Serializes enqueues so decode races cannot reorder phrases.
 *
 * Emits:
 * - speaker_started — first audible sample actually begins playing
 * - speaker_finished — queue drained and output is idle/silent
 */
export class SpeakerPlayer {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private nextStartTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private pending = 0;
  private idleWaiters: Array<() => void> = [];
  private chain: Promise<void> = Promise.resolve();
  private turnActive = false;
  private startedEmitted = false;
  private speakStartedAt = 0;
  private startTimers = new Set<ReturnType<typeof setTimeout>>();
  private finishedTimer: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;
  private readonly listeners = new Map<SpeakerEvent, Set<SpeakerListener>>();

  /** Duration of the last completed speak turn (ms). */
  lastSpeakDurationMs = 0;

  get isPlaying(): boolean {
    if (this.pending > 0 || this.sources.size > 0) return true;
    if (
      this.context &&
      this.nextStartTime > this.context.currentTime + 0.02
    ) {
      return true;
    }
    return false;
  }

  on(event: SpeakerEvent, listener: SpeakerListener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  async enqueue(chunk: AudioChunk): Promise<void> {
    return this.enqueueSerial(() => this.enqueuePcm(chunk));
  }

  async enqueueEncoded(chunk: EncodedAudioChunk): Promise<void> {
    return this.enqueueSerial(() => this.enqueueEncodedInner(chunk));
  }

  whenIdle(): Promise<void> {
    if (!this.isPlaying) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
      this.notifyIdleIfNeeded();
    });
  }

  /**
   * Wait until playback is idle and output energy stays quiet.
   * Used for adaptive echo hold — open mic as soon as the speaker is
   * stably silent instead of always waiting a fixed second.
   */
  async whenSilent(options?: {
    minQuietMs?: number;
    maxWaitMs?: number;
    threshold?: number;
  }): Promise<void> {
    const minQuietMs = options?.minQuietMs ?? 100;
    const maxWaitMs = options?.maxWaitMs ?? 800;
    const threshold = options?.threshold ?? 0.02;

    await this.whenIdle();

    const started = performance.now();
    let quietSince = performance.now();

    while (performance.now() - started < maxWaitMs) {
      if (this.isPlaying) {
        await this.whenIdle();
        quietSince = performance.now();
        continue;
      }

      const rms = this.getOutputRms();
      if (rms < threshold) {
        if (performance.now() - quietSince >= minQuietMs) return;
      } else {
        quietSince = performance.now();
      }
      await sleep(40);
    }
  }

  /** Instantaneous output RMS in ~0..1 (0 if analyser unavailable). */
  getOutputRms(): number {
    if (!this.analyser) return 0;
    const data = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const v = (data[i]! - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / data.length);
  }

  flush(): void {
    this.epoch += 1;
    this.chain = Promise.resolve();
    for (const timer of this.startTimers) clearTimeout(timer);
    this.startTimers.clear();
    if (this.finishedTimer) {
      clearTimeout(this.finishedTimer);
      this.finishedTimer = null;
    }
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    this.sources.clear();
    this.pending = 0;
    this.nextStartTime = this.context?.currentTime ?? 0;
    this.finishTurnIfNeeded(false);
    this.flushIdleWaiters();
  }

  async stop(): Promise<void> {
    this.flush();
    await this.context?.close();
    this.context = null;
    this.masterGain = null;
    this.analyser = null;
  }

  private emit(event: SpeakerEvent): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      try {
        listener();
      } catch (error) {
        console.error(`[speaker] ${event} listener failed`, error);
      }
    }
  }

  private beginTurnIfNeeded(): void {
    if (this.turnActive) return;
    this.turnActive = true;
    this.startedEmitted = false;
    this.speakStartedAt = 0;
    this.lastSpeakDurationMs = 0;
  }

  private finishTurnIfNeeded(emitFinished: boolean): void {
    if (!this.turnActive) return;
    const didStart = this.speakStartedAt > 0;
    if (didStart) {
      this.lastSpeakDurationMs = performance.now() - this.speakStartedAt;
    }
    this.turnActive = false;
    this.startedEmitted = false;
    this.speakStartedAt = 0;
    if (emitFinished && didStart) {
      this.emit("speaker_finished");
    }
  }

  private enqueueSerial(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async enqueuePcm(chunk: AudioChunk): Promise<void> {
    const myEpoch = this.epoch;
    this.beginTurnIfNeeded();
    this.pending += 1;
    try {
      await this.ensureContext();
      if (!this.context || myEpoch !== this.epoch) return;
      const samples = int16ToFloat32(chunk.pcm);
      const buffer = this.context.createBuffer(
        1,
        samples.length,
        this.context.sampleRate,
      );
      buffer.copyToChannel(Float32Array.from(samples), 0);
      if (myEpoch !== this.epoch) return;
      this.schedule(buffer);
    } finally {
      this.pending -= 1;
      this.notifyIdleIfNeeded();
    }
  }

  private async enqueueEncodedInner(chunk: EncodedAudioChunk): Promise<void> {
    const myEpoch = this.epoch;
    this.beginTurnIfNeeded();
    this.pending += 1;
    try {
      await this.ensureContext();
      if (!this.context || myEpoch !== this.epoch) return;

      if (chunk.codec === "pcm_s16le") {
        const pcm = new Int16Array(
          chunk.data.buffer,
          chunk.data.byteOffset,
          Math.floor(chunk.data.byteLength / 2),
        );
        const samples = int16ToFloat32(pcm);
        const buffer = this.context.createBuffer(
          1,
          samples.length,
          // Prefer declared rate for streaming PCM providers.
          chunk.sampleRate || this.context.sampleRate,
        );
        buffer.copyToChannel(Float32Array.from(samples), 0);
        if (myEpoch !== this.epoch) return;
        this.schedule(buffer);
        return;
      }

      const bytes = chunk.data;
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      const decoded = await this.context.decodeAudioData(ab);
      if (myEpoch !== this.epoch) return;
      this.schedule(decoded);
    } finally {
      this.pending -= 1;
      this.notifyIdleIfNeeded();
    }
  }

  private async ensureContext(): Promise<void> {
    if (typeof window === "undefined") return;
    this.context ??= new AudioContext();
    if (!this.masterGain || !this.analyser) {
      this.masterGain = this.context.createGain();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.3;
      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.context.destination);
    }
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
  }

  private schedule(buffer: AudioBuffer): void {
    if (!this.context || !this.masterGain) return;

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.masterGain);
    this.sources.add(source);

    const now = this.context.currentTime;
    const startAt = Math.max(now, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;

    const delayMs = Math.max(0, (startAt - now) * 1000);
    const timer = setTimeout(() => {
      this.startTimers.delete(timer);
      if (!this.sources.has(source)) return;
      // Ignore sub-frame priming blips (AudioContext warm-up).
      if (buffer.duration < 0.04) return;
      if (!this.startedEmitted) {
        this.startedEmitted = true;
        this.speakStartedAt = performance.now();
        this.emit("speaker_started");
      }
    }, delayMs);
    this.startTimers.add(timer);

    source.onended = () => {
      this.sources.delete(source);
      this.notifyIdleIfNeeded();
    };
  }

  private notifyIdleIfNeeded(): void {
    if (this.isPlaying) {
      if (this.finishedTimer) {
        clearTimeout(this.finishedTimer);
        this.finishedTimer = null;
      }
      return;
    }
    if (this.context && this.context.currentTime < this.nextStartTime - 0.05) {
      const waitMs = Math.ceil(
        (this.nextStartTime - this.context.currentTime) * 1000,
      );
      setTimeout(() => this.notifyIdleIfNeeded(), Math.max(20, waitMs));
      return;
    }

    // Snapshot duration before waiters wake (echo settle needs it now).
    if (this.speakStartedAt > 0) {
      this.lastSpeakDurationMs = performance.now() - this.speakStartedAt;
    }
    this.flushIdleWaiters();

    // Debounce finished so a decode gap between phrases doesn't end the turn.
    if (
      this.turnActive &&
      this.speakStartedAt > 0 &&
      !this.finishedTimer
    ) {
      this.finishedTimer = setTimeout(() => {
        this.finishedTimer = null;
        if (!this.isPlaying) {
          this.finishTurnIfNeeded(true);
        }
      }, 180);
    }
  }

  private flushIdleWaiters(): void {
    if (this.idleWaiters.length === 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    waiters.forEach((resolve) => resolve());
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
