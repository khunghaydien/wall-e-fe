export type TranscriptEvent = {
  text: string;
  isFinal: boolean;
};

export type LlmTokenEvent = {
  text: string;
  done: boolean;
};

export type TtsAudioEvent = {
  pcm: Int16Array;
  sampleRate: number;
};
