/**
 * Backend endpoints — override via NEXT_PUBLIC_* env vars.
 */
const BACKEND_HTTP =
  process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";
const BACKEND_WS =
  process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? "ws://localhost:8000";

export const ENV = {
  backendHttpUrl: BACKEND_HTTP,
  backendWsUrl: BACKEND_WS,
  voiceWsUrl: process.env.NEXT_PUBLIC_VOICE_WS_URL ?? `${BACKEND_WS}/voice`,
} as const;
