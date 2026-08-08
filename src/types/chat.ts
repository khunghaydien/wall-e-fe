export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  /** Still streaming assistant delta. */
  pending?: boolean;
  /** Realtime input item id for updating user transcript deltas. */
  sourceId?: string;
};

let messageSeq = 0;

export function createChatMessage(
  role: ChatRole,
  text: string,
  pending = false,
): ChatMessage {
  messageSeq += 1;
  return {
    id: `msg-${messageSeq}-${Date.now()}`,
    role,
    text,
    pending,
  };
}
