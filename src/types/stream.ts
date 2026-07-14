export type TranscriptEvent = {
  text: string;
  isFinal: boolean;
};

export type LlmTokenEvent = {
  text: string;
  done: boolean;
};
