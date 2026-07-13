import {
  AUDIO_CHANNEL_COUNT,
  AUDIO_SAMPLE_RATE,
  ENV,
} from "@/constants";
import {
  type AudioMessage,
  type ControlMessage,
  type RuntimeMessage,
  type RuntimeMessageHandler,
  dispatchRuntimeMessage,
  int16ToBase64,
  parseRuntimeMessage,
} from "@/protocol";
import { StreamSocket } from "@/utils";

/**
 * Transport abstraction — WebSocket today, WebRTC/LiveKit later.
 * Runtime should depend on this, not on a concrete socket type.
 */
export class TransportClient {
  private socket: StreamSocket | null = null;
  private handler: RuntimeMessageHandler | null = null;
  private sequence = 0;

  setHandler(handler: RuntimeMessageHandler): void {
    this.handler = handler;
  }

  async connect(): Promise<void> {
    this.socket = new StreamSocket(ENV.voiceWsUrl);
    this.socket.setMessageHandler((data) => {
      if (typeof data !== "string") return;
      const message = parseRuntimeMessage(data);
      if (!message || !this.handler) return;
      void dispatchRuntimeMessage(message, this.handler);
    });
    await this.socket.connect();
  }

  sendAudio(pcm: Int16Array): void {
    if (!this.socket?.isOpen) return;
    const message: AudioMessage = {
      type: "audio",
      codec: "pcm_s16le",
      sampleRate: AUDIO_SAMPLE_RATE,
      channel: AUDIO_CHANNEL_COUNT,
      sequence: ++this.sequence,
      timestamp: Date.now(),
      data: int16ToBase64(pcm),
    };
    this.send(message);
  }

  call(text?: string): void {
    this.send({
      type: "control",
      action: "call",
      text,
    } satisfies ControlMessage);
  }

  stop(): void {
    this.send({ type: "control", action: "stop" } satisfies ControlMessage);
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = null;
    this.sequence = 0;
  }

  get isOpen(): boolean {
    return this.socket?.isOpen ?? false;
  }

  private send(message: RuntimeMessage): void {
    if (!this.socket?.isOpen) return;
    this.socket.sendJson(message);
  }
}
