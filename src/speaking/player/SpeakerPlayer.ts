import { int16ToFloat32 } from "@/utils";
import type { AudioChunk } from "@/types";
import type { AudioCodec } from "@/protocol";

export type EncodedAudioChunk = {
  codec: AudioCodec;
  data: Uint8Array;
  sampleRate: number;
  timestamp: number;
};

/** One PCM frame from the WS audio stream. */
export type StreamPcmFrame = {
  pcm: Int16Array;
  sampleRate: number;
  phraseId: number;
  frameIndex: number;
  isLast: boolean;
  turnId?: string;
};

export type SpeakerEvent = "speaker_started" | "speaker_finished";

type SpeakerListener = () => void;

/** Minimum buffered audio before starting playback (~120ms). */
const MIN_STREAM_MS = 120;

/**
 * Streaming PCM speaker + legacy encoded blob fallback.
 *
 * PCM frames are scheduled as soon as ~MIN_STREAM_MS buffer is available.
 * MP3 blobs still use one-shot decode (legacy provider fallback).
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

  /** PCM waiting to be scheduled (streaming path). */
  private streamQueues: Int16Array[] = [];
  private streamPendingSamples = 0;
  private streamPhraseId: number | null = null;
  private streamSampleRate = 24_000;

  lastSpeakDurationMs = 0;

  get isPlaying(): boolean {
    if (this.pending > 0 || this.sources.size > 0) return true;
    if (this.streamPendingSamples > 0) return true;
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

  /**
   * Push one PCM stream frame — schedules playback without waiting for the
   * full phrase. Non-blocking (returns before audio is scheduled).
   */
  pushStreamFrame(frame: StreamPcmFrame): void {
    const myEpoch = this.epoch;
    void this.pushStreamFrameInner(frame, myEpoch);
  }

  whenIdle(): Promise<void> {
    if (!this.isPlaying) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
      this.notifyIdleIfNeeded();
    });
  }

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
    this.clearStreamPending();
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

  private clearStreamPending(): void {
    this.streamQueues = [];
    this.streamPendingSamples = 0;
    this.streamPhraseId = null;
  }

  private async pushStreamFrameInner(
    frame: StreamPcmFrame,
    myEpoch: number,
  ): Promise<void> {
    this.pending += 1;
    try {
      await this.ensureContext();
      if (!this.context || myEpoch !== this.epoch) return;

      this.beginTurnIfNeeded();

      if (
        this.streamPhraseId !== null &&
        frame.phraseId !== this.streamPhraseId
      ) {
        this.flushStreamBuffer(myEpoch, true);
      }

      this.streamPhraseId = frame.phraseId;
      this.streamSampleRate = frame.sampleRate;
      this.streamQueues.push(frame.pcm);
      this.streamPendingSamples += frame.pcm.length;

      const minSamples = Math.max(
        1,
        Math.floor((this.streamSampleRate * MIN_STREAM_MS) / 1000),
      );

      while (
        myEpoch === this.epoch &&
        this.streamPendingSamples >= minSamples
      ) {
        this.drainStreamBuffer(minSamples, myEpoch);
      }

      if (frame.isLast && myEpoch === this.epoch) {
        this.flushStreamBuffer(myEpoch, true);
      }
    } finally {
      this.pending -= 1;
      this.notifyIdleIfNeeded();
    }
  }

  private drainStreamBuffer(minSamples: number, myEpoch: number): void {
    if (!this.context || myEpoch !== this.epoch) return;

    let needed = minSamples;
    const parts: Int16Array[] = [];

    while (needed > 0 && this.streamQueues.length > 0) {
      const head = this.streamQueues[0]!;
      if (head.length <= needed) {
        parts.push(head);
        needed -= head.length;
        this.streamPendingSamples -= head.length;
        this.streamQueues.shift();
      } else {
        parts.push(head.subarray(0, needed));
        this.streamQueues[0] = head.subarray(needed);
        this.streamPendingSamples -= needed;
        needed = 0;
      }
    }

    if (parts.length === 0) return;

    const total = parts.reduce((n, p) => n + p.length, 0);
    const merged = new Int16Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.length;
    }

    const samples = int16ToFloat32(merged);
    const buffer = this.context.createBuffer(
      1,
      samples.length,
      this.streamSampleRate,
    );
    buffer.copyToChannel(Float32Array.from(samples), 0);
    this.schedule(buffer);
  }

  private flushStreamBuffer(myEpoch: number, scheduleAll: boolean): void {
    if (!this.context || myEpoch !== this.epoch) return;
    if (this.streamPendingSamples <= 0) return;

    if (scheduleAll) {
      this.drainStreamBuffer(this.streamPendingSamples, myEpoch);
    }
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

    if (this.speakStartedAt > 0) {
      this.lastSpeakDurationMs = performance.now() - this.speakStartedAt;
    }
    this.flushIdleWaiters();

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
