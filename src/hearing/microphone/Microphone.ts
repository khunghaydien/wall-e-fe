import type { AudioFrame } from "@/types";
import { resampleFloat32 } from "@/utils";

export type MicrophoneOptions = {
  /** Target rate for frames sent to the transport (e.g. 24 kHz). */
  sampleRate: number;
  channelCount: number;
  deviceId?: string;
};

export type OpenCaptureOptions = {
  bluetooth?: boolean;
  /**
   * Phone: disable DSP, reuse the playback AudioContext, never remount a
   * live track. Opening a second AudioContext / AEC is what drops A2DP.
   */
  mobile?: boolean;
};

type AudioContextWithSink = AudioContext & {
  setSinkId?: (sinkId: string | { type: "none" }) => Promise<void>;
};

const BT_SETTLE_MS = 350;

export class Microphone {
  private stream: MediaStream | null = null;
  private context: AudioContextWithSink | null = null;
  private ownedContext = true;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private discard: AudioNode | null = null;
  private onFrameCallback: ((frame: AudioFrame) => void) | null = null;
  private onTrackEndedCallback: (() => void) | null = null;
  private deviceId: string | undefined;
  private bluetoothMode = false;
  private mobileMode = false;
  private lastCapture: OpenCaptureOptions = {};
  private paused = false;
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

  onTrackEnded(callback: () => void): void {
    this.onTrackEndedCallback = callback;
  }

  /** Reuse the speaker AudioContext (required on Android). */
  attachContext(context: AudioContext): void {
    this.context = context as AudioContextWithSink;
    this.ownedContext = false;
  }

  get activeDeviceId(): string | undefined {
    const track = this.stream?.getAudioTracks()[0];
    return track?.getSettings().deviceId ?? this.deviceId;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Release the capture track without ending the session.
   * Bluetooth can leave HFP/SCO so A2DP speaker playback works.
   */
  async pause(): Promise<void> {
    if (!this.started || this.paused) return;
    this.paused = true;
    this.openGeneration += 1;
    await this.closeCapture();
  }

  /** Re-open capture after pause (listening turn). */
  async resume(): Promise<void> {
    if (!this.started || !this.paused) return;
    this.paused = false;
    await this.openCapture(this.deviceId, this.lastCapture);
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

  async setDevice(
    deviceId: string | undefined,
    capture: OpenCaptureOptions = {},
  ): Promise<void> {
    this.deviceId = deviceId;
    if (!this.started || this.paused) return;

    if (this.isLive && !this.opening) {
      if (!deviceId) return;
      if (this.activeDeviceId === deviceId) return;
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
    this.paused = false;
    this.lastCapture = capture;
    this.mobileMode = Boolean(capture.mobile);
    this.bluetoothMode = Boolean(capture.bluetooth || capture.mobile);

    try {
      const hadStream = Boolean(this.stream);
      await this.closeCapture();

      if (hadStream) {
        await sleep(BT_SETTLE_MS);
        if (generation !== this.openGeneration) return;
      }

      try {
        this.stream = await this.getStream(deviceId, {
          bluetooth: this.bluetoothMode,
          mobile: this.mobileMode,
          exactDevice: !this.mobileMode && !this.bluetoothMode && Boolean(deviceId),
        });
      } catch (error) {
        if (!deviceId) throw error;
        await sleep(BT_SETTLE_MS);
        if (generation !== this.openGeneration) return;
        this.stream = await this.getStream(deviceId, {
          bluetooth: true,
          mobile: this.mobileMode,
          exactDevice: false,
        });
      }

      if (generation !== this.openGeneration) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
        return;
      }

      await this.disableCaptureProcessing(this.stream);
      this.bindTrackEnded(this.stream);

      if (!this.context) {
        this.context = new AudioContext({
          latencyHint: this.mobileMode ? "playback" : "interactive",
        }) as AudioContextWithSink;
        this.ownedContext = true;
        if (!this.mobileMode) await this.applySilentSink(this.context);
      }
      if (this.context.state === "suspended") {
        await this.context.resume();
      }

      this.source = this.context.createMediaStreamSource(this.stream);

      const bufferSize = this.mobileMode || this.bluetoothMode ? 4096 : 2048;
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
      if (this.mobileMode) {
        const mute = this.context.createGain();
        mute.gain.value = 0;
        this.discard = mute;
        this.processor.connect(mute);
        mute.connect(this.context.destination);
      } else {
        const dest = this.context.createMediaStreamDestination();
        this.discard = dest;
        this.processor.connect(dest);
      }
    } finally {
      if (generation === this.openGeneration) {
        this.opening = false;
      }
    }
  }

  private async disableCaptureProcessing(stream: MediaStream): Promise<void> {
    const track = stream.getAudioTracks()[0];
    if (!track || !this.mobileMode) return;
    try {
      await track.applyConstraints({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      });
    } catch {
      // Device may reject — capture still runs with initial constraints.
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
      // ignore
    }
  }

  private async getStream(
    deviceId: string | undefined,
    opts: { bluetooth: boolean; exactDevice: boolean; mobile: boolean },
  ): Promise<MediaStream> {
    const audio: MediaTrackConstraints = {};

    if (opts.mobile) {
      // Media-path capture: stereo 48 kHz, no DSP → Android STREAM_MUSIC.
      audio.echoCancellation = false;
      audio.noiseSuppression = false;
      audio.autoGainControl = false;
      audio.channelCount = { ideal: 2 };
      audio.sampleRate = { ideal: 48_000 };
      Object.assign(audio, {
        googEchoCancellation: false,
        googAutoGainControl: false,
        googNoiseSuppression: false,
        googHighpassFilter: false,
        googTypingNoiseDetection: false,
      });
    } else if (opts.bluetooth) {
      audio.channelCount = { ideal: this.options.channelCount };
      audio.echoCancellation = { ideal: true };
      audio.noiseSuppression = { ideal: false };
      audio.autoGainControl = { ideal: true };
    } else {
      audio.channelCount = { ideal: this.options.channelCount };
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

    if (this.ownedContext) {
      await this.context?.close().catch(() => undefined);
      this.context = null;
    }

    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
