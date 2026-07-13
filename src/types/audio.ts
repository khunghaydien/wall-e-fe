export type AudioFrame = {
  samples: Float32Array;
  sampleRate: number;
  timestamp: number;
};

export type AudioChunk = {
  pcm: Int16Array;
  sampleRate: number;
  timestamp: number;
};
