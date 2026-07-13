export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  pending?: boolean;
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
