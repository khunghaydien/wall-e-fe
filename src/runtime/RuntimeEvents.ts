import type {
  LlmStatus,
  MicStatus,
  RuntimeStatus,
  SpeakingStatus,
  TtsStatus,
} from "@/enums";
import type { TurnPhase } from "./RealtimeVoiceRuntime";

export type LlmTokenEvent = {
  text: string;
  done: boolean;
};

export type UserTranscriptEvent = {
  itemId: string;
  text: string;
  isFinal: boolean;
};

export type RuntimeEvents = {
  "runtime:status": RuntimeStatus;
  "runtime:error": Error;
  "runtime:thinking": { thinking: boolean; message: string };
  "runtime:turn": TurnPhase;
  "runtime:interrupted": undefined;
  "user:transcript": UserTranscriptEvent;
  "mic:status": MicStatus;
  "mic:level": number;
  "llm:status": LlmStatus;
  "llm:token": LlmTokenEvent;
  "tts:status": TtsStatus;
  "speaking:status": SpeakingStatus;
  "audio:route": {
    inputId?: string;
    inputLabel?: string;
    outputId?: string;
    outputLabel?: string;
  };
};
