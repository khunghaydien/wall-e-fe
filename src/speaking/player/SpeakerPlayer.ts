import { int16ToFloat32 } from "@/utils";
import type { AudioChunk } from "@/types";

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
 * Streaming PCM speaker for Realtime audio deltas.
 *
 * Routes to a chosen output via AudioContext.setSinkId when available
 * (needed for Bluetooth headsets paired with the mic).
 */
export class SpeakerPlayer {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private nextStartTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private pending = 0;
  private chain: Promise<void> = Promise.resolve();
  private turnActive = false;
  private startedEmitted = false;
  private speakStartedAt = 0;
  private startTimers = new Set<ReturnType<typeof setTimeout>>();
  private finishedTimer: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;
  private sinkId: string | undefined;
  private readonly listeners = new Map<SpeakerEvent, Set<SpeakerListener>>();

  private streamQueues: Int16Array[] = [];
  private streamPendingSamples = 0;
  private streamPhraseId: number | null = null;
  private streamSampleRate = 24_000;

  get outputDeviceId(): string | undefined {
    return this.sinkId;
  }

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

  /** Approximate audio heard by the user in the current response. */
  get currentPlaybackMs(): number {
    if (this.speakStartedAt <= 0) return 0;
    return Math.max(0, performance.now() - this.speakStartedAt);
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

  /** Unlock AudioContext on a user gesture (silent buffer). */
  async enqueue(chunk: AudioChunk): Promise<void> {
    const run = this.chain.then(
      () => this.enqueuePcm(chunk),
      () => this.enqueuePcm(chunk),
    );
    this.chain = run.catch(() => undefined);
    return run;
  }

  pushStreamFrame(frame: StreamPcmFrame): void {
    const myEpoch = this.epoch;
    void this.pushStreamFrameInner(frame, myEpoch);
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
  }

  async stop(): Promise<void> {
    this.flush();
    await this.context?.close();
    this.context = null;
    this.masterGain = null;
  }

  /** Route Web Audio output to a specific device, or "" for system default. */
  async setOutputDevice(deviceId: string | undefined): Promise<void> {
    this.sinkId = deviceId;
    if (!this.context) return;
    await this.applySinkId(this.context);
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
  }

  private finishTurnIfNeeded(emitFinished: boolean): void {
    if (!this.turnActive) return;
    const didStart = this.speakStartedAt > 0;
    this.turnActive = false;
    this.startedEmitted = false;
    this.speakStartedAt = 0;
    if (emitFinished && didStart) {
      this.emit("speaker_finished");
    }
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
        this.flushStreamBuffer(myEpoch);
      }

      this.streamPhraseId = frame.phraseId;
      this.streamSampleRate = frame.sampleRate;
      if (frame.pcm.length > 0) {
        this.streamQueues.push(frame.pcm);
        this.streamPendingSamples += frame.pcm.length;
      }

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
        this.flushStreamBuffer(myEpoch);
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

  private flushStreamBuffer(myEpoch: number): void {
    if (!this.context || myEpoch !== this.epoch) return;
    if (this.streamPendingSamples <= 0) return;
    this.drainStreamBuffer(this.streamPendingSamples, myEpoch);
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

  private async ensureContext(): Promise<void> {
    if (typeof window === "undefined") return;
    if (!this.context) {
      const options: AudioContextOptions & { sinkId?: string } = {};
      if (this.sinkId) options.sinkId = this.sinkId;
      this.context = new AudioContext(options);
      await this.applySinkId(this.context);
    }
    if (!this.masterGain) {
      this.masterGain = this.context.createGain();
      this.masterGain.connect(this.context.destination);
    }
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
  }

  private async applySinkId(context: AudioContext): Promise<void> {
    const ctx = context as AudioContext & {
      setSinkId?: (id: string) => Promise<void>;
    };
    if (typeof ctx.setSinkId !== "function") return;
    try {
      // Empty string = OS default output (YouTube path / BT A2DP).
      await ctx.setSinkId(this.sinkId ?? "");
    } catch (error) {
      console.warn("[speaker] setSinkId failed — using system default output", error);
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
}
