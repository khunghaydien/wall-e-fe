"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LlmStatus } from "@/enums";
import { VoiceRuntime, type RuntimeStateSnapshot } from "@/runtime";
import { runtimeStore } from "@/stores";

export function useVoiceRuntime() {
  const runtimeRef = useRef<VoiceRuntime | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const snapshot = useSyncExternalStore(
    runtimeStore.subscribe,
    runtimeStore.getState,
    runtimeStore.getState,
  );

  useEffect(() => {
    const runtime = new VoiceRuntime();
    runtimeRef.current = runtime;

    const unsubscribers = [
      runtime.events.on("runtime:status", (runtimeStatus) => {
        runtimeStore.setState({ runtime: runtimeStatus });
      }),
      runtime.events.on("mic:status", (mic) => {
        runtimeStore.setState({ mic });
      }),
      runtime.events.on("mic:level", (micLevel) => {
        runtimeStore.setState({ micLevel });
      }),
      runtime.events.on("stt:status", (stt) => {
        runtimeStore.setState({ stt });
      }),
      runtime.events.on("llm:status", (llm) => {
        runtimeStore.setState({ llm });
        if (llm === LlmStatus.Streaming) {
          const draft =
            runtimeStore.getState().partialTranscript ||
            runtimeStore.getState().finalTranscript;
          if (draft.trim()) {
            runtimeStore.commitUserMessage(draft.trim());
          }
        }
      }),
      runtime.events.on("tts:status", (tts) => {
        runtimeStore.setState({ tts });
      }),
      runtime.events.on("speaking:status", (speaking) => {
        runtimeStore.setState({ speaking });
      }),
      runtime.events.on("runtime:turn", (turnPhase) => {
        runtimeStore.setState({ turnPhase });
      }),
      runtime.events.on("runtime:thinking", ({ thinking, message }) => {
        runtimeStore.setState({
          thinking,
          thinkingMessage: message,
        });
        if (thinking) {
          const draft =
            runtimeStore.getState().partialTranscript ||
            runtimeStore.getState().finalTranscript;
          if (draft.trim()) {
            runtimeStore.commitUserMessage(draft.trim());
          }
        }
      }),
      runtime.events.on("runtime:metrics", (metrics) => {
        runtimeStore.setState({ metrics });
      }),
      runtime.events.on("runtime:revise", ({ text }) => {
        runtimeStore.reviseUserMessage(text);
      }),
      runtime.events.on("stt:transcript", (event) => {
        if (event.isFinal) {
          // During revise, keep user bubble open (pending) until true EOS reply.
          const last = runtimeStore.getState().messages.at(-1);
          if (last?.role === "user" && last.pending) {
            runtimeStore.reviseUserMessage(event.text);
          } else {
            runtimeStore.commitUserMessage(event.text);
          }
        } else {
          runtimeStore.upsertUserDraft(event.text);
        }
      }),
      runtime.events.on("llm:token", (event) => {
        if (event.done) {
          runtimeStore.finishAssistantMessage();
          return;
        }
        if (!event.text) return;
        runtimeStore.appendAssistantDelta(event.text);
      }),
      runtime.events.on("runtime:error", (error) => {
        runtimeStore.setState({ error });
      }),
    ];

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      void runtime.stop();
      runtimeRef.current = null;
      runtimeStore.reset();
    };
  }, []);

  async function start(): Promise<void> {
    if (!runtimeRef.current || isBusy) return;
    setIsBusy(true);
    try {
      runtimeStore.setState({
        partialTranscript: "",
        finalTranscript: "",
        messages: [],
        micLevel: 0,
        thinking: false,
        thinkingMessage: "",
        turnPhase: "listening",
        metrics: null,
        error: null,
      });
      await runtimeRef.current.start();
    } finally {
      setIsBusy(false);
    }
  }

  async function stop(): Promise<void> {
    if (!runtimeRef.current || isBusy) return;
    setIsBusy(true);
    try {
      await runtimeRef.current.stop();
    } finally {
      setIsBusy(false);
    }
  }

  return {
    state: snapshot as RuntimeStateSnapshot,
    isBusy,
    start,
    stop,
  };
}
