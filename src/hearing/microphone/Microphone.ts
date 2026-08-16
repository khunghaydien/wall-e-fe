import type { AudioFrame } from "@/types";
import { resampleFloat32 } from "@/utils";

export type MicrophoneOptions = {
  /** Target rate for frames sent to the transport (e.g. 24 kHz). */
  sampleRate: number;
  channelCount: number;
  /** Prefer this input when available (only when user picks it). */
  deviceId?: string;
};

export type OpenCaptureOptions = {
  /** Softer getUserMedia constraints — required for stable Bluetooth HFP/SCO. */
  bluetooth?: boolean;
};

type AudioContextWithSink = AudioContext & {
  setSinkId?: (sinkId: string | { type: "none" }) => Promise<void>;
};

const BT_SETTLE_MS = 350;

/**
 * Captures mono PCM via getUserMedia with browser DSP.
 *
 * Bluetooth HFP mics drop if we remount the stream, use `exact` deviceId, or
 * pile on echoCancellation/noiseSuppression during profile handshake.
 * Capture AudioContext stays on a silent sink so it never steals A2DP output.
 */
export class Microphone {
  private stream: MediaStream | null = null;
  private context: AudioContextWithSink | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private discard: MediaStreamAudioDestinationNode | null = null;
  private onFrameCallback: ((frame: AudioFrame) => void) | null = null;
  private onTrackEndedCallback: (() => void) | null = null;
  private deviceId: string | undefined;
  private bluetoothMode = false;
  private started = false;
  private opening = false;
  private openGeneration = 0;
  private endedHandler: (() => void) | null = null;

  constructor(private readonly options: MicrophoneOptions) {
    this.deviceId = options.deviceId;
  }

  onFrame(callback: (frame: AudioFrame) => void): void {
    this.onFrameCallback = callback;
  }

  /** Fired when the OS ends the track (common during BT HFP flaps). */
  onTrackEnded(callback: () => void): void {
    this.onTrackEndedCallback = callback;
  }

  get activeDeviceId(): string | undefined {
    const track = this.stream?.getAudioTracks()[0];
    return track?.getSettings().deviceId ?? this.deviceId;
  }

  get isOpening(): boolean {
    return this.opening;
  }

  get isLive(): boolean {
    const track = this.stream?.getAudioTracks()[0];
    return Boolean(track && track.readyState === "live" && this.stream?.active);
  }

  async start(
    deviceId?: string,
    capture: OpenCaptureOptions = {},
  ): Promise<void> {
    if (typeof window === "undefined" || !navigator.mediaDevices) {
      throw new Error("Microphone is only available in the browser");
    }

    if (deviceId !== undefined) this.deviceId = deviceId;
    await this.openCapture(this.deviceId, capture);
    this.started = true;
  }

  /**
   * Hot-swap input. No-ops when already live on the same device — reopening
   * is what kicks Bluetooth HFP offline.
   */
  async setDevice(
    deviceId: string | undefined,
    capture: OpenCaptureOptions = {},
  ): Promise<void> {
    this.deviceId = deviceId;
    if (!this.started) return;

    if (
      deviceId &&
      this.isLive &&
      this.activeDeviceId === deviceId &&
      !this.opening
    ) {
      return;
    }

    await this.openCapture(deviceId, capture);
  }

  async stop(): Promise<void> {
    this.started = false;
    this.openGeneration += 1;
    await this.closeCapture();
  }

  private async openCapture(
    deviceId: string | undefined,
    capture: OpenCaptureOptions,
  ): Promise<void> {
    const generation = ++this.openGeneration;
    this.opening = true;
    this.bluetoothMode = Boolean(capture.bluetooth);

    try {
      const hadStream = Boolean(this.stream);
      await this.closeCapture();

      // Let the previous device release before claiming BT HFP/SCO.
      if (hadStream) {
        await sleep(BT_SETTLE_MS);
        if (generation !== this.openGeneration) return;
      }

      try {
        this.stream = await this.getStream(deviceId, {
          bluetooth: this.bluetoothMode,
          exactDevice: !this.bluetoothMode && Boolean(deviceId),
        });
      } catch (error) {
        if (!deviceId) throw error;
        // Soft retry on the same device — never fall back to built-in while
        // the user asked for this mic (fallback is what "outs" Bluetooth).
        await sleep(BT_SETTLE_MS);
        if (generation !== this.openGeneration) return;
        this.stream = await this.getStream(deviceId, {
          bluetooth: true,
          exactDevice: false,
        });
      }

      if (generation !== this.openGeneration) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
        return;
      }

      this.bindTrackEnded(this.stream);

      this.context = new AudioContext() as AudioContextWithSink;
      await this.applySilentSink(this.context);
      if (this.context.state === "suspended") {
        await this.context.resume();
      }

      this.source = this.context.createMediaStreamSource(this.stream);
      this.discard = this.context.createMediaStreamDestination();

      // Larger buffer absorbs SCO jitter on Bluetooth headsets.
      const bufferSize = this.bluetoothMode ? 4096 : 2048;
      this.processor = this.context.createScriptProcessor(bufferSize, 1, 1);
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
    } finally {
      if (generation === this.openGeneration) {
        this.opening = false;
      }
    }
  }

  private bindTrackEnded(stream: MediaStream): void {
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    this.endedHandler = () => {
      if (!this.started || this.opening) return;
      this.onTrackEndedCallback?.();
    };
    track.addEventListener("ended", this.endedHandler);
  }

  private async applySilentSink(context: AudioContextWithSink): Promise<void> {
    if (typeof context.setSinkId !== "function") return;
    try {
      await context.setSinkId({ type: "none" });
    } catch {
      // MediaStreamDestination still avoids claiming speakers.
    }
  }

  private async getStream(
    deviceId: string | undefined,
    opts: { bluetooth: boolean; exactDevice: boolean },
  ): Promise<MediaStream> {
    const audio: MediaTrackConstraints = {
      channelCount: { ideal: this.options.channelCount },
    };

    if (opts.bluetooth) {
      // Soft DSP only — hard true/false often renegotiates and drops HFP.
      audio.echoCancellation = { ideal: true };
      audio.noiseSuppression = { ideal: false };
      audio.autoGainControl = { ideal: true };
    } else {
      audio.echoCancellation = true;
      audio.noiseSuppression = true;
      audio.autoGainControl = true;
    }

    if (deviceId) {
      audio.deviceId = opts.exactDevice
        ? { exact: deviceId }
        : { ideal: deviceId };
    }

    return navigator.mediaDevices.getUserMedia({
      audio,
      video: false,
    });
  }

  private async closeCapture(): Promise<void> {
    const track = this.stream?.getAudioTracks()[0];
    if (track && this.endedHandler) {
      track.removeEventListener("ended", this.endedHandler);
    }
    this.endedHandler = null;

    this.processor?.disconnect();
    this.processor = null;
    this.source?.disconnect();
    this.source = null;
    this.discard?.disconnect();
    this.discard = null;

    await this.context?.close().catch(() => undefined);
    this.context = null;

    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
