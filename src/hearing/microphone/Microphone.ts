import type { AudioFrame } from "@/types";
import { resampleFloat32 } from "@/utils";

export type MicrophoneOptions = {
  /** Target rate for frames sent to the transport (e.g. 24 kHz). */
  sampleRate: number;
  channelCount: number;
  /** Prefer this input when available (Bluetooth headset, etc.). */
  deviceId?: string;
};

/**
 * Captures mono PCM via getUserMedia with browser DSP.
 *
 * Does not force hardware sampleRate — Bluetooth HFP/SCO often only
 * supports 8–16 kHz. Capture at the device rate, then resample uplink.
 */
export class Microphone {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private onFrameCallback: ((frame: AudioFrame) => void) | null = null;
  private deviceId: string | undefined;
  private started = false;

  constructor(private readonly options: MicrophoneOptions) {
    this.deviceId = options.deviceId;
  }

  onFrame(callback: (frame: AudioFrame) => void): void {
    this.onFrameCallback = callback;
  }

  get activeDeviceId(): string | undefined {
    const track = this.stream?.getAudioTracks()[0];
    return track?.getSettings().deviceId ?? this.deviceId;
  }

  async start(deviceId?: string): Promise<void> {
    if (typeof window === "undefined" || !navigator.mediaDevices) {
      throw new Error("Microphone is only available in the browser");
    }

    if (deviceId !== undefined) this.deviceId = deviceId;
    await this.openCapture(this.deviceId);
    this.started = true;
  }

  /** Hot-swap input (e.g. Bluetooth headset connected while running). */
  async setDevice(deviceId: string | undefined): Promise<void> {
    this.deviceId = deviceId;
    if (!this.started) return;
    await this.openCapture(deviceId);
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.closeCapture();
  }

  private async openCapture(deviceId: string | undefined): Promise<void> {
    await this.closeCapture();

    try {
      this.stream = await this.getStream(deviceId, true);
    } catch (error) {
      if (deviceId) {
        // Exact device may be gone or reject constraints — fall back to default.
        this.stream = await this.getStream(undefined, false);
      } else {
        throw error;
      }
    }

    // Match the hardware clock; do not force 24 kHz (breaks many BT headsets).
    this.context = new AudioContext();
    if (this.context.state === "suspended") {
      await this.context.resume();
    }

    this.source = this.context.createMediaStreamSource(this.stream);

    const silent = this.context.createGain();
    silent.gain.value = 0;

    // Larger buffer is more tolerant of Bluetooth SCO jitter.
    this.processor = this.context.createScriptProcessor(2048, 1, 1);
    this.processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const nativeRate = this.context?.sampleRate ?? this.options.sampleRate;
      const samples = resampleFloat32(
        new Float32Array(input),
        nativeRate,
        this.options.sampleRate,
      );
      this.onFrameCallback?.({
        samples,
        sampleRate: this.options.sampleRate,
        timestamp: performance.now(),
      });
    };

    this.source.connect(this.processor);
    this.processor.connect(silent);
    silent.connect(this.context.destination);
  }

  private async getStream(
    deviceId: string | undefined,
    preferExactDevice: boolean,
  ): Promise<MediaStream> {
    const audio: MediaTrackConstraints = {
      // Soft constraints — Bluetooth often cannot honor exact sampleRate/channelCount.
      channelCount: { ideal: this.options.channelCount },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };

    if (deviceId) {
      audio.deviceId = preferExactDevice
        ? { exact: deviceId }
        : { ideal: deviceId };
    }

    return navigator.mediaDevices.getUserMedia({
      audio,
      video: false,
    });
  }

  private async closeCapture(): Promise<void> {
    this.processor?.disconnect();
    this.processor = null;
    this.source?.disconnect();
    this.source = null;

    await this.context?.close().catch(() => undefined);
    this.context = null;

    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }
}
