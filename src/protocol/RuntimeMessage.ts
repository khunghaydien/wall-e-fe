export type AudioCodec = "pcm_s16le" | "opus" | "aac" | "mp3";

export type AudioMessage = {
  type: "audio";
  codec: AudioCodec;
  sampleRate: number;
  channel: number;
  sequence: number;
  timestamp: number;
  data: string;
};

export type ControlAction =
  | "session_started"
  | "session_stopped"
  | "call"
  | "stop"
  | "audio_received"
  | "tts_started"
  | "tts_finished"
  | "error";

export type ControlMessage = {
  type: "control";
  action: ControlAction;
  message?: string;
  /** User utterance caption sent with call. */
  text?: string;
};

export type TranscriptMessage = {
  type: "transcript";
  text: string;
  isFinal: boolean;
};

export type AiMessage = {
  type: "ai";
  phase: "started" | "delta" | "done";
  text?: string;
  delta?: string;
};

export type RuntimeMessage =
  | AudioMessage
  | ControlMessage
  | TranscriptMessage
  | AiMessage;

export type RuntimeMessageHandler = {
  audio?: (message: AudioMessage) => void | Promise<void>;
  control?: (message: ControlMessage) => void | Promise<void>;
  transcript?: (message: TranscriptMessage) => void | Promise<void>;
  ai?: (message: AiMessage) => void | Promise<void>;
};

export function dispatchRuntimeMessage(
  message: RuntimeMessage,
  handler: RuntimeMessageHandler,
): void | Promise<void> {
  switch (message.type) {
    case "audio":
      return handler.audio?.(message);
    case "control":
      return handler.control?.(message);
    case "transcript":
      return handler.transcript?.(message);
    case "ai":
      return handler.ai?.(message);
  }
}

export function parseRuntimeMessage(raw: string): RuntimeMessage | null {
  try {
    const message = JSON.parse(raw) as RuntimeMessage;
    if (!message || typeof message !== "object" || !("type" in message)) {
      return null;
    }
    return message;
  } catch {
    return null;
  }
}

export function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function base64ToInt16(data: string): Int16Array {
  const bytes = base64ToBytes(data);
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}

export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
