import {
  LlmStatus,
  MicStatus,
  RuntimeStatus,
  SpeakingStatus,
  SttStatus,
  TtsStatus,
} from "@/enums";
import type { ChatMessage } from "@/types";

export type RuntimeStateSnapshot = {
  runtime: RuntimeStatus;
  mic: MicStatus;
  stt: SttStatus;
  llm: LlmStatus;
  tts: TtsStatus;
  speaking: SpeakingStatus;
  micLevel: number;
  partialTranscript: string;
  finalTranscript: string;
  assistantText: string;
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

  setMicLevel(level: number): void {
    this.snapshot.micLevel = level;
  }

  setPartialTranscript(text: string): void {
    this.snapshot.partialTranscript = text;
  }

  setFinalTranscript(text: string): void {
    this.snapshot.finalTranscript = text;
  }

  appendAssistantText(text: string): void {
    this.snapshot.assistantText += text;
  }

  clearAssistantText(): void {
    this.snapshot.assistantText = "";
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
    micLevel: 0,
    partialTranscript: "",
    finalTranscript: "",
    assistantText: "",
    messages: [],
    error: null,
  };
}
