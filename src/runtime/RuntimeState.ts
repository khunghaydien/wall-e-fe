import {
  LlmStatus,
  MicStatus,
  RuntimeStatus,
  SpeakingStatus,
  TtsStatus,
} from "@/enums";
import type { TurnPhase } from "./RealtimeVoiceRuntime";

export type RuntimeStateSnapshot = {
  runtime: RuntimeStatus;
  mic: MicStatus;
  llm: LlmStatus;
  tts: TtsStatus;
  speaking: SpeakingStatus;
  turnPhase: TurnPhase;
  micLevel: number;
  thinking: boolean;
  thinkingMessage: string;
  error: Error | null;
};

export class RuntimeState {
  private snapshot: RuntimeStateSnapshot = createInitialSnapshot();

  get(): RuntimeStateSnapshot {
    return { ...this.snapshot };
  }

  setRuntime(status: RuntimeStatus): void {
    this.snapshot.runtime = status;
  }

  setMic(status: MicStatus): void {
    this.snapshot.mic = status;
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

  setThinking(thinking: boolean, message = ""): void {
    this.snapshot.thinking = thinking;
    this.snapshot.thinkingMessage = thinking
      ? message || "Đang nghĩ câu trả lời..."
      : "";
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
    llm: LlmStatus.Idle,
    tts: TtsStatus.Idle,
    speaking: SpeakingStatus.Idle,
    turnPhase: "listening",
    micLevel: 0,
    thinking: false,
    thinkingMessage: "",
    error: null,
  };
}
