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
  turnPhase: "listening",
  micLevel: 0,
  partialTranscript: "",
  finalTranscript: "",
  thinking: false,
  thinkingMessage: "",
  metrics: null,
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

  /** Interim caption — dim bubble. */
  upsertUserDraft(text: string): void {
    const messages = [...state.messages];
    const last = messages[messages.length - 1];

    // Allow extending the user turn even if a premature assistant draft exists —
    // revise path aborts that draft separately.
    if (last?.role === "assistant" && last.pending) {
      messages.pop();
    }

    const userLast = messages[messages.length - 1];
    if (userLast?.role === "user") {
      messages[messages.length - 1] = {
        ...userLast,
        text,
        pending: true,
        interim: true,
      };
    } else {
      const msg = createChatMessage("user", text, true);
      msg.interim = true;
      messages.push(msg);
    }
    state = {
      ...state,
      messages,
      partialTranscript: text,
      thinking: false,
      thinkingMessage: "",
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
        interim: false,
      };
    } else if (last?.role === "user" && !last.pending) {
      messages[messages.length - 1] = { ...last, text, interim: false };
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

  /** Drop mid-reply when user keeps talking (revise). */
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

  /** Re-open / extend the user bubble with the merged continuous utterance. */
  reviseUserMessage(text: string): void {
    this.abortAssistantDraft();
    const messages = [...state.messages];
    const last = messages[messages.length - 1];
    if (last?.role === "user") {
      messages[messages.length - 1] = {
        ...last,
        text,
        pending: true,
        interim: true,
      };
    } else {
      const msg = createChatMessage("user", text, true);
      msg.interim = true;
      messages.push(msg);
    }
    state = {
      ...state,
      messages,
      partialTranscript: text,
      finalTranscript: text,
      thinking: false,
      thinkingMessage: "",
    };
    emit();
  },

  getMessages(): ChatMessage[] {
    return state.messages;
  },
};
