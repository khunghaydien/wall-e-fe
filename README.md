# WALL-E Frontend

Next.js client for real-time voice:

```
Mic → STT Streaming → LLM Streaming → TTS Streaming → Speaker
```

## Backend env

Defaults point at local backend. Copy `.env.example` → `.env.local` if needed:

```bash
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000
NEXT_PUBLIC_BACKEND_WS_URL=ws://localhost:8000
# NEXT_PUBLIC_STT_WS_URL=ws://localhost:8000/stt
# NEXT_PUBLIC_LLM_WS_URL=ws://localhost:8000/llm
# NEXT_PUBLIC_TTS_WS_URL=ws://localhost:8000/tts
```

## Develop

```bash
npm run dev
```
