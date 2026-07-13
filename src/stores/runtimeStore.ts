import type { RuntimeStateSnapshot } from "@/runtime";
import type { ChatMessage } from "@/types";
import { createChatMessage } from "@/types";
import {
  LlmStatus,
  MicStatus,
  RuntimeStatus,
  SpeakingStatus,
  SttStatus,
  TtsStatus,
} from "@/enums";

type Listener = () => void;

const initialState: RuntimeStateSnapshot = {
  runtime: RuntimeStatus.Idle,
  mic: MicStatus.Idle,
  stt: SttStatus.Idle,
  llm: LlmStatus.Idle,
  tts: TtsStatus.Idle,
  speaking: SpeakingStatus.Idle,
  micLevel: 0,
  partialTranscript: "",
  finalTranscript: "",
  assistantText: "",
  messages: [],
  error: null,
};

let state: RuntimeStateSnapshot = {
  ...initialState,
  messages: [],
};
const listeners = new Set<Listener>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

export const runtimeStore = {
  getState(): RuntimeStateSnapshot {
    return state;
  },

  setState(next: Partial<RuntimeStateSnapshot>): void {
    state = {
      ...state,
      ...next,
      messages: next.messages ? [...next.messages] : state.messages,
    };
    emit();
  },

  reset(): void {
    state = { ...initialState, messages: [] };
    emit();
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** Live user caption — only while in an open user turn (not waiting for reply). */
  upsertUserDraft(text: string): void {
    const messages = [...state.messages];
    const last = messages[messages.length - 1];

    // Backend chưa trả lời xong → không mở bubble user mới.
    if (last?.role === "user" && !last.pending) return;
    if (last?.role === "assistant" && last.pending) return;

    if (last?.role === "user" && last.pending) {
      messages[messages.length - 1] = { ...last, text };
    } else {
      messages.push(createChatMessage("user", text, true));
    }
    state = {
      ...state,
      messages,
      partialTranscript: text,
    };
    emit();
  },

  commitUserMessage(text: string): void {
    const messages = [...state.messages];
    const last = messages[messages.length - 1];
    if (last?.role === "user" && last.pending) {
      messages[messages.length - 1] = {
        ...last,
        text,
        pending: false,
      };
    } else if (last?.role === "user" && !last.pending) {
      // Already committed this turn — just refresh text if needed.
      messages[messages.length - 1] = { ...last, text };
    } else {
      messages.push(createChatMessage("user", text, false));
    }
    state = {
      ...state,
      messages,
      partialTranscript: "",
      finalTranscript: text,
    };
    emit();
  },

  appendAssistantDelta(delta: string): void {
    if (!delta) return;
    const messages = [...state.messages];
    const last = messages[messages.length - 1];
    // Chỉ tạo bubble WALL-E khi backend bắt đầu stream chữ thật.
    if (last?.role === "assistant" && last.pending) {
      messages[messages.length - 1] = {
        ...last,
        text: last.text + delta,
      };
    } else {
      messages.push(createChatMessage("assistant", delta, true));
    }
    state = {
      ...state,
      messages,
      assistantText: state.assistantText + delta,
    };
    emit();
  },

  finishAssistantMessage(): void {
    const messages = [...state.messages];
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && last.pending) {
      messages[messages.length - 1] = { ...last, pending: false };
      state = { ...state, messages };
      emit();
    }
  },

  getMessages(): ChatMessage[] {
    return state.messages;
  },
};
