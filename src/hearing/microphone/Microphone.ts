import type { AudioFrame } from "@/types";
import { resampleFloat32 } from "@/utils";

export type MicrophoneOptions = {
  /** Target rate for frames sent to the transport (e.g. 24 kHz). */
  sampleRate: number;
  channelCount: number;
  /** Prefer this input when available (only when user picks it). */
  deviceId?: string;
};

type AudioContextWithSink = AudioContext & {
  setSinkId?: (sinkId: string | { type: "none" }) => Promise<void>;
};

/**
 * Captures mono PCM via getUserMedia with browser DSP.
 *
 * Critical for Bluetooth speakers (A2DP): the capture AudioContext must NOT
 * claim the real hardware output. Connecting ScriptProcessor → destination
 * steals the OS default sink (often the BT speaker) and renegotiates the
 * link — YouTube only plays audio, so it never hits this path.
 */
export class Microphone {
  private stream: MediaStream | null = null;
  private context: AudioContextWithSink | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private discard: MediaStreamAudioDestinationNode | null = null;
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

  /** Hot-swap input (user pick or safe remount away from BT HFP). */
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
        this.stream = await this.getStream(undefined, false);
      } else {
        throw error;
      }
    }

    // Match hardware clock; do not force 24 kHz.
    this.context = new AudioContext() as AudioContextWithSink;
    await this.applySilentSink(this.context);
    if (this.context.state === "suspended") {
      await this.context.resume();
    }

    this.source = this.context.createMediaStreamSource(this.stream);
    // Keep the processor graph alive without routing to real speakers/BT.
    this.discard = this.context.createMediaStreamDestination();

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
    this.processor.connect(this.discard);
  }

  /** Chrome: mute the capture context so it never owns the BT A2DP sink. */
  private async applySilentSink(context: AudioContextWithSink): Promise<void> {
    if (typeof context.setSinkId !== "function") return;
    try {
      await context.setSinkId({ type: "none" });
    } catch {
      // Older browsers — MediaStreamDestination above still avoids speakers.
    }
  }

  private async getStream(
    deviceId: string | undefined,
    preferExactDevice: boolean,
  ): Promise<MediaStream> {
    const audio: MediaTrackConstraints = {
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
    this.discard?.disconnect();
    this.discard = null;

    await this.context?.close().catch(() => undefined);
    this.context = null;

    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }
}
