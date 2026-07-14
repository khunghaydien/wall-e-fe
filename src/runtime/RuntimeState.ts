import {
  LlmStatus,
  MicStatus,
  RuntimeStatus,
  SpeakingStatus,
  SttStatus,
  TtsStatus,
} from "@/enums";
import type { ChatMessage } from "@/types";
import type { TurnPhase } from "./VoiceRuntime";

export type LatencyMetrics = Record<string, number | undefined>;

export type RuntimeStateSnapshot = {
  runtime: RuntimeStatus;
  mic: MicStatus;
  stt: SttStatus;
  llm: LlmStatus;
  tts: TtsStatus;
  speaking: SpeakingStatus;
  turnPhase: TurnPhase;
  micLevel: number;
  partialTranscript: string;
  finalTranscript: string;
  thinking: boolean;
  thinkingMessage: string;
  metrics: LatencyMetrics | null;
  messages: ChatMessage[];
  error: Error | null;
};

export class RuntimeState {
  private snapshot: RuntimeStateSnapshot = createInitialSnapshot();

  get(): RuntimeStateSnapshot {
    return {
      ...this.snapshot,
      messages: [...this.snapshot.messages],
    };
  }

  setRuntime(status: RuntimeStatus): void {
    this.snapshot.runtime = status;
  }

  setMic(status: MicStatus): void {
    this.snapshot.mic = status;
  }

  setStt(status: SttStatus): void {
    this.snapshot.stt = status;
  }

  setLlm(status: LlmStatus): void {
    this.snapshot.llm = status;
  }

  setTts(status: TtsStatus): void {
    this.snapshot.tts = status;
  }

  setSpeaking(status: SpeakingStatus): void {
    this.snapshot.speaking = status;
  }

  setTurnPhase(phase: TurnPhase): void {
    this.snapshot.turnPhase = phase;
  }

  setMicLevel(level: number): void {
    this.snapshot.micLevel = level;
  }

  setPartialTranscript(text: string): void {
    this.snapshot.partialTranscript = text;
  }

  setFinalTranscript(text: string): void {
    this.snapshot.finalTranscript = text;
  }

  setThinking(thinking: boolean, message = ""): void {
    this.snapshot.thinking = thinking;
    this.snapshot.thinkingMessage = thinking
      ? message || "Đang nghĩ câu trả lời..."
      : "";
  }

  setMetrics(metrics: LatencyMetrics | null): void {
    this.snapshot.metrics = metrics;
  }

  setError(error: Error | null): void {
    this.snapshot.error = error;
  }

  reset(): void {
    this.snapshot = createInitialSnapshot();
  }
}

function createInitialSnapshot(): RuntimeStateSnapshot {
  return {
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
}
