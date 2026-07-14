import { int16ToFloat32 } from "@/utils";
import type { AudioChunk } from "@/types";
import type { AudioCodec } from "@/protocol";

export type EncodedAudioChunk = {
  codec: AudioCodec;
  data: Uint8Array;
  sampleRate: number;
  timestamp: number;
};

/**
 * Simple reliable speaker queue for PCM / MP3.
 * Keeps AudioContext awake; serializes enqueues so decode races cannot
 * reorder phrases.
 */
export class SpeakerPlayer {
  private context: AudioContext | null = null;
  private nextStartTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private pending = 0;
  private idleWaiters: Array<() => void> = [];
  private chain: Promise<void> = Promise.resolve();

  get isPlaying(): boolean {
    if (this.pending > 0 || this.sources.size > 0) return true;
    // Scheduled audio still in the future counts as playing.
    if (
      this.context &&
      this.nextStartTime > this.context.currentTime + 0.02
    ) {
      return true;
    }
    return false;
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

  flush(): void {
    this.chain = Promise.resolve();
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
    this.flushIdleWaiters();
  }

  async stop(): Promise<void> {
    this.flush();
    await this.context?.close();
    this.context = null;
  }

  private enqueueSerial(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task, task);
    // Keep the chain alive even if one chunk fails.
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async enqueuePcm(chunk: AudioChunk): Promise<void> {
    this.pending += 1;
    try {
      await this.ensureContext();
      if (!this.context) return;
      const samples = int16ToFloat32(chunk.pcm);
      const buffer = this.context.createBuffer(
        1,
        samples.length,
        this.context.sampleRate,
      );
      buffer.copyToChannel(Float32Array.from(samples), 0);
      this.schedule(buffer);
    } finally {
      this.pending -= 1;
      this.notifyIdleIfNeeded();
    }
  }

  private async enqueueEncodedInner(chunk: EncodedAudioChunk): Promise<void> {
    this.pending += 1;
    try {
      await this.ensureContext();
      if (!this.context) return;

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
          this.context.sampleRate,
        );
        buffer.copyToChannel(Float32Array.from(samples), 0);
        this.schedule(buffer);
        return;
      }

      const bytes = chunk.data;
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      const decoded = await this.context.decodeAudioData(ab);
      this.schedule(decoded);
    } finally {
      this.pending -= 1;
      this.notifyIdleIfNeeded();
    }
  }

  private async ensureContext(): Promise<void> {
    if (typeof window === "undefined") return;
    this.context ??= new AudioContext();
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
  }

  private schedule(buffer: AudioBuffer): void {
    if (!this.context) return;

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    this.sources.add(source);

    const now = this.context.currentTime;
    const startAt = Math.max(now, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;

    source.onended = () => {
      this.sources.delete(source);
      this.notifyIdleIfNeeded();
    };
  }

  private notifyIdleIfNeeded(): void {
    if (this.isPlaying) return;
    if (this.context && this.context.currentTime < this.nextStartTime - 0.05) {
      const waitMs = Math.ceil(
        (this.nextStartTime - this.context.currentTime) * 1000,
      );
      setTimeout(() => this.notifyIdleIfNeeded(), Math.max(20, waitMs));
      return;
    }
    this.flushIdleWaiters();
  }

  private flushIdleWaiters(): void {
    if (this.idleWaiters.length === 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    waiters.forEach((resolve) => resolve());
  }
}
