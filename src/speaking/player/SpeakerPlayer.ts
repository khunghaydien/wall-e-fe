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
 * Queued speaker playback for PCM and compressed TTS (e.g. MP3 from Edge TTS).
 */
export class SpeakerPlayer {
  private context: AudioContext | null = null;
  private nextStartTime = 0;
  private playing = false;

  get isPlaying(): boolean {
    return this.playing;
  }

  async enqueue(chunk: AudioChunk): Promise<void> {
    await this.ensureContext(chunk.sampleRate);
    const samples = int16ToFloat32(chunk.pcm);
    const buffer = this.context!.createBuffer(
      1,
      samples.length,
      chunk.sampleRate,
    );
    buffer.copyToChannel(Float32Array.from(samples), 0);
    this.schedule(buffer);
  }

  async enqueueEncoded(chunk: EncodedAudioChunk): Promise<void> {
    await this.ensureContext(chunk.sampleRate);

    if (chunk.codec === "pcm_s16le") {
      const pcm = new Int16Array(
        chunk.data.buffer,
        chunk.data.byteOffset,
        Math.floor(chunk.data.byteLength / 2),
      );
      await this.enqueue({
        pcm,
        sampleRate: chunk.sampleRate,
        timestamp: chunk.timestamp,
      });
      return;
    }

    const copy = chunk.data.slice().buffer;
    const decoded = await this.context!.decodeAudioData(copy);
    this.schedule(decoded);
  }

  async stop(): Promise<void> {
    this.nextStartTime = 0;
    this.playing = false;
    await this.context?.close();
    this.context = null;
  }

  private async ensureContext(sampleRate: number): Promise<void> {
    if (typeof window === "undefined") return;
    this.context ??= new AudioContext({ sampleRate });
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
  }

  private schedule(buffer: AudioBuffer): void {
    if (!this.context) return;

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);

    const now = this.context.currentTime;
    const startAt = Math.max(now, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
    this.playing = true;

    source.onended = () => {
      if (this.context && this.context.currentTime >= this.nextStartTime - 0.01) {
        this.playing = false;
      }
    };
  }
}
