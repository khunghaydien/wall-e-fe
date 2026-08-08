export enum RuntimeStatus {
  Idle = "idle",
  Starting = "starting",
  Running = "running",
  Stopping = "stopping",
  Error = "error",
}

export enum MicStatus {
  Idle = "idle",
  Capturing = "capturing",
}

export enum LlmStatus {
  Idle = "idle",
  Connecting = "connecting",
  Streaming = "streaming",
  Error = "error",
}

export enum TtsStatus {
  Idle = "idle",
  Connecting = "connecting",
  Streaming = "streaming",
  Error = "error",
}

export enum SpeakingStatus {
  Idle = "idle",
  Buffering = "buffering",
  Playing = "playing",
}
