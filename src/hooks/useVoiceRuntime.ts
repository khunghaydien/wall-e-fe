"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  listAudioDevices,
  unlockAudioDeviceLabels,
  type AudioDeviceInfo,
} from "@/hearing";
import { VoiceRuntime } from "@/runtime";
import { runtimeStore, type VoiceUiState } from "@/stores";

export type AudioRouteUi = {
  inputId?: string;
  inputLabel?: string;
  outputId?: string;
  outputLabel?: string;
};

export function useVoiceRuntime() {
  const runtimeRef = useRef<VoiceRuntime | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [inputs, setInputs] = useState<AudioDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<AudioDeviceInfo[]>([]);
  const [selectedInputId, setSelectedInputId] = useState("");
  const [selectedOutputId, setSelectedOutputId] = useState("");
  const [route, setRoute] = useState<AudioRouteUi>({});

  const snapshot = useSyncExternalStore(
    runtimeStore.subscribe,
    runtimeStore.getState,
    runtimeStore.getState,
  );

  const refreshDevices = useCallback(async (requestPermission = false) => {
    if (requestPermission) {
      try {
        await unlockAudioDeviceLabels();
      } catch {
        // Permission denied — still try enumerate (may have empty labels).
      }
    }
    const listed = await listAudioDevices();
    setInputs(listed.inputs);
    setOutputs(listed.outputs);
    return listed;
  }, []);

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
      runtime.events.on("audio:route", (next) => {
        setRoute(next);
        if (next.inputId) setSelectedInputId(next.inputId);
        if (next.outputId) setSelectedOutputId(next.outputId);
        void refreshDevices(false);
      }),
    ];

    void refreshDevices(false);

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      void runtime.stop();
      runtimeRef.current = null;
      runtimeStore.reset();
    };
  }, [refreshDevices]);

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
      await runtimeRef.current.setAudioDevices({
        inputId: selectedInputId || undefined,
        outputId: selectedOutputId || undefined,
      });
      await runtimeRef.current.start();
      await refreshDevices(false);
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

  async function selectInput(deviceId: string): Promise<void> {
    setSelectedInputId(deviceId);
    if (!runtimeRef.current) return;
    await runtimeRef.current.setAudioDevices({
      inputId: deviceId || undefined,
      outputId: selectedOutputId || undefined,
    });
  }

  async function selectOutput(deviceId: string): Promise<void> {
    setSelectedOutputId(deviceId);
    if (!runtimeRef.current) return;
    await runtimeRef.current.setAudioDevices({
      inputId: selectedInputId || undefined,
      outputId: deviceId || undefined,
    });
  }

  return {
    state: snapshot as VoiceUiState,
    isBusy,
    start,
    stop,
    inputs,
    outputs,
    selectedInputId,
    selectedOutputId,
    route,
    refreshDevices,
    selectInput,
    selectOutput,
  };
}
