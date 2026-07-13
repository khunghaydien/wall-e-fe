import type { AudioFrame, LlmTokenEvent, TranscriptEvent } from "@/types";
import type {
  LlmStatus,
  MicStatus,
  RuntimeStatus,
  SpeakingStatus,
  SttStatus,
  TtsStatus,
} from "@/enums";

export type RuntimeEvents = {
  "runtime:status": RuntimeStatus;
  "runtime:error": Error;
  "mic:status": MicStatus;
  "mic:frame": AudioFrame;
  "mic:level": number;
  "stt:status": SttStatus;
  "stt:transcript": TranscriptEvent;
  "llm:status": LlmStatus;
  "llm:token": LlmTokenEvent;
  "tts:status": TtsStatus;
  "speaking:status": SpeakingStatus;
};
