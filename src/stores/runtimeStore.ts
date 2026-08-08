import type { RuntimeStateSnapshot } from "@/runtime";
import type { ChatMessage } from "@/types";
import { createChatMessage } from "@/types";
import {
  LlmStatus,
  MicStatus,
  RuntimeStatus,
  SpeakingStatus,
  TtsStatus,
} from "@/enums";

export type VoiceUiState = RuntimeStateSnapshot & {
  messages: ChatMessage[];
};

type Listener = () => void;

const initialState: VoiceUiState = {
  runtime: RuntimeStatus.Idle,
  mic: MicStatus.Idle,
  llm: LlmStatus.Idle,
  tts: TtsStatus.Idle,
  speaking: SpeakingStatus.Idle,
  turnPhase: "listening",
  micLevel: 0,
  thinking: false,
  thinkingMessage: "",
  messages: [],
  error: null,
};

let state: VoiceUiState = { ...initialState, messages: [] };
const listeners = new Set<Listener>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

export const runtimeStore = {
  getState(): VoiceUiState {
    return state;
  },

  setState(next: Partial<VoiceUiState>): void {
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

  upsertUserTranscript(
    sourceId: string,
    text: string,
    isFinal: boolean,
  ): void {
    const clean = text.trim();
    if (!sourceId || !clean) return;

    const messages = [...state.messages];
    const existingIndex = messages.findIndex(
      (message) => message.role === "user" && message.sourceId === sourceId,
    );

    if (existingIndex >= 0) {
      const existing = messages[existingIndex]!;
      messages[existingIndex] = {
        ...existing,
        text: isFinal ? clean : existing.text + clean,
        pending: !isFinal,
      };
    } else {
      const message = createChatMessage("user", clean, !isFinal);
      message.sourceId = sourceId;

      // Input transcription can complete after response generation begins.
      // Keep the user caption before the trailing assistant draft.
      const trailingAssistantIndex = messages.findIndex(
        (item) => item.role === "assistant" && item.pending,
      );
      if (trailingAssistantIndex >= 0) {
        messages.splice(trailingAssistantIndex, 0, message);
      } else {
        messages.push(message);
      }
    }

    state = { ...state, messages };
    emit();
  },

  appendAssistantDelta(delta: string): void {
    if (!delta) return;
    const messages = [...state.messages];
    const last = messages[messages.length - 1];
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
      thinking: false,
      thinkingMessage: "",
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

  abortAssistantDraft(): void {
    const messages = [...state.messages];
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && last.pending) {
      messages.pop();
    }
    state = {
      ...state,
      messages,
      thinking: false,
      thinkingMessage: "",
    };
    emit();
  },
};
