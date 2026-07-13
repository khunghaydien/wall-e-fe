import type { AudioFrame } from "@/types";

export type MicrophoneOptions = {
  sampleRate: number;
  channelCount: number;
};

export class Microphone {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private onFrameCallback: ((frame: AudioFrame) => void) | null = null;

  constructor(private readonly options: MicrophoneOptions) {}

  onFrame(callback: (frame: AudioFrame) => void): void {
    this.onFrameCallback = callback;
  }

  async start(): Promise<void> {
    if (typeof window === "undefined" || !navigator.mediaDevices) {
      throw new Error("Microphone is only available in the browser");
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: this.options.channelCount,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    this.context = new AudioContext();
    // Critical: browsers start AudioContext suspended until resumed after a gesture.
    if (this.context.state === "suspended") {
      await this.context.resume();
    }

    const source = this.context.createMediaStreamSource(this.stream);

    const silent = this.context.createGain();
    silent.gain.value = 0;

    this.processor = this.context.createScriptProcessor(512, 1, 1);
    this.processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      this.onFrameCallback?.({
        samples: new Float32Array(input),
        sampleRate: this.context?.sampleRate ?? this.options.sampleRate,
        timestamp: performance.now(),
      });
    };

    source.connect(this.processor);
    this.processor.connect(silent);
    silent.connect(this.context.destination);
  }

  async stop(): Promise<void> {
    this.processor?.disconnect();
    this.processor = null;

    await this.context?.close();
    this.context = null;

    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }
}
