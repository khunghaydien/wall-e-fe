type MessageHandler = (data: string | ArrayBuffer) => void;

/**
 * Minimal WebSocket helper for streaming backend services.
 */
export class StreamSocket {
  private socket: WebSocket | null = null;
  private onMessage: MessageHandler | null = null;

  constructor(private readonly url: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof window === "undefined") {
        reject(new Error("WebSocket is only available in the browser"));
        return;
      }

      const socket = new WebSocket(this.url);
      socket.binaryType = "arraybuffer";
      this.socket = socket;

      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error(`Failed to connect: ${this.url}`));
      socket.onmessage = (event) => {
        this.onMessage?.(event.data as string | ArrayBuffer);
      };
    });
  }

  setMessageHandler(handler: MessageHandler): void {
    this.onMessage = handler;
  }

  sendJson(payload: unknown): void {
    this.ensureOpen().send(JSON.stringify(payload));
  }

  sendBinary(data: ArrayBufferLike): void {
    this.ensureOpen().send(data);
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private ensureOpen(): WebSocket {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`Socket not open: ${this.url}`);
    }
    return this.socket;
  }
}
