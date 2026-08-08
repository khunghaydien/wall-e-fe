# WALL-E Frontend

Next.js client for realtime speech-to-speech:

```
Mic PCM 24 kHz → WALL-E WebSocket → OpenAI Realtime → Speaker PCM
```

Half-duplex: mic is muted while the assistant speaks. No barge-in.

## Env

```bash
NEXT_PUBLIC_BACKEND_WS_URL=ws://localhost:8000
```

Production: use `wss://…`.

## Develop

```bash
npm run dev
```
