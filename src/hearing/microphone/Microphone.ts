import type { AudioFrame } from "@/types";

export type MicrophoneOptions = {
  sampleRate: number;
  channelCount: number;
};

/**
 * FE WebRTC Processing stage (first step of the hearing chain):
 * getUserMedia echoCancellation + noiseSuppression + autoGainControl.
 * Server HearingEngine continues: Preprocessor → DeepFilter → Level → VAD → STT.
 */
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
        sampleRate: this.options.sampleRate,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    this.context = new AudioContext({ sampleRate: this.options.sampleRate });
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
