"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { VoiceRuntime } from "@/runtime";
import { runtimeStore, type VoiceUiState } from "@/stores";

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
      runtime.events.on("llm:status", (llm) => {
        runtimeStore.setState({ llm });
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
      }),
      runtime.events.on("runtime:interrupted", () => {
        runtimeStore.abortAssistantDraft();
      }),
      runtime.events.on("user:transcript", ({ itemId, text, isFinal }) => {
        runtimeStore.upsertUserTranscript(itemId, text, isFinal);
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
        messages: [],
        micLevel: 0,
        thinking: false,
        thinkingMessage: "",
        turnPhase: "listening",
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
    state: snapshot as VoiceUiState,
    isBusy,
    start,
    stop,
  };
}
