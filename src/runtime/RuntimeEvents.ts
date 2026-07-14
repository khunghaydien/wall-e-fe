import type {
  LlmStatus,
  MicStatus,
  RuntimeStatus,
  SpeakingStatus,
  SttStatus,
  TtsStatus,
} from "@/enums";
import type {
  AudioFrame,
  LlmTokenEvent,
  TranscriptEvent,
} from "@/types";
import type { LatencyMetrics } from "./RuntimeState";
import type { TurnPhase } from "./VoiceRuntime";

export type RuntimeEvents = {
  "runtime:status": RuntimeStatus;
  "runtime:error": Error;
  "runtime:thinking": { thinking: boolean; message: string };
  "runtime:metrics": LatencyMetrics | null;
  "runtime:turn": TurnPhase;
  /** Premature AI reply aborted; continue merging user speech. */
  "runtime:revise": { text: string };
  "mic:status": MicStatus;
  "mic:level": number;
  "mic:frame": AudioFrame;
  "stt:status": SttStatus;
  "stt:transcript": TranscriptEvent;
  "llm:status": LlmStatus;
  "llm:token": LlmTokenEvent;
  "tts:status": TtsStatus;
  "speaking:status": SpeakingStatus;
};
