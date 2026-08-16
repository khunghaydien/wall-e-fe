"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { RuntimeStatus } from "@/enums";
import { useVoiceRuntime } from "@/hooks";
import type { ChatMessage } from "@/types";

export default function Home() {
  const {
    state,
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
    pickSpeaker,
    outputPickerSupported,
  } = useVoiceRuntime();
  const isRunning = state.runtime === RuntimeStatus.Running;
  const levelPct = Math.round(Math.min(1, state.micLevel) * 100);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [state.messages, state.thinking]);

  return (
    <main className="flex min-h-screen w-full items-center justify-center px-6 py-10">
      <div className="flex w-full max-w-5xl flex-col gap-5">
        <header className="space-y-1 text-center sm:text-left">
          <p className="font-mono text-sm tracking-widest text-accent uppercase">
            WALL-E
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            Voice Runtime
          </h1>
          <p className="text-muted text-sm leading-relaxed">
            Cuộc gọi speech-to-speech — lúc AI đang nói thì không nghe mic,
            không chen lời. Xong lượt mới nghe lại.
          </p>
        </header>

        <section className="rounded-xl border border-border bg-panel p-4 font-mono text-sm">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-muted text-xs uppercase tracking-wide">
              Thiết bị âm thanh
            </p>
            <button
              type="button"
              onClick={() => void refreshDevices(true)}
              className="rounded border border-border px-2.5 py-1 text-xs text-muted hover:text-foreground"
            >
              Làm mới
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-muted text-xs">Micro</span>
              <DeviceSelect
                value={selectedInputId}
                onChange={(value) => void selectInput(value)}
              >
                <option value="">Tự động (ưu tiên Bluetooth)</option>
                {inputs.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </DeviceSelect>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-muted text-xs">Loa / tai nghe</span>
              <div className="flex gap-2">
                <div className="min-w-0 flex-1">
                  <DeviceSelect
                    value={selectedOutputId}
                    onChange={(value) => void selectOutput(value)}
                  >
                    <option value="">Tự động (ưu tiên Bluetooth)</option>
                    {outputs.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label}
                      </option>
                    ))}
                  </DeviceSelect>
                </div>
                {outputPickerSupported ? (
                  <button
                    type="button"
                    onClick={() => void pickSpeaker()}
                    className="shrink-0 rounded-lg border border-border px-3 py-2.5 text-xs text-muted hover:text-foreground"
                  >
                    Chọn loa
                  </button>
                ) : null}
              </div>
              {outputs.length === 0 ? (
                <p className="text-[11px] leading-relaxed text-muted">
                  {outputPickerSupported
                    ? "Điện thoại: để “Tự động” — Android tự gắn Bluetooth. Chỉ bấm “Chọn loa” nếu muốn chỉ định loa."
                    : "Điện thoại: âm thanh theo Bluetooth hệ thống khi đã kết nối headset."}
                </p>
              ) : null}
            </label>
          </div>
          {(route.inputLabel || route.outputLabel) && (
            <p className="mt-3 text-xs text-muted">
              Đang dùng: {route.inputLabel ?? "—"} →{" "}
              {route.outputLabel ?? "mặc định hệ thống"}
            </p>
          )}
        </section>

        <div className="grid h-[min(62vh,520px)] grid-cols-1 gap-4 md:grid-cols-2">
          <section className="flex h-full min-h-0 flex-col rounded-xl border border-border bg-panel p-5 font-mono text-sm">
            <p className="mb-4 text-muted text-xs uppercase tracking-wide">
              Status
            </p>
            <div className="flex flex-1 flex-col justify-center gap-4">
              <div className="rounded-lg border border-border/80 bg-background/40 px-3 py-3">
                <p className="text-muted text-[10px] uppercase tracking-wide">
                  Lượt hiện tại
                </p>
                <p className="mt-1 text-base font-medium text-accent">
                  {turnLabel(state.turnPhase)}
                </p>
              </div>
              <StatusRow label="Runtime" value={state.runtime} />
              <StatusRow label="Mic" value={state.mic} />
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted">Mic level</span>
                  <span>{levelPct}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded bg-border/60">
                  <div
                    className="h-full bg-accent transition-[width] duration-75"
                    style={{ width: `${levelPct}%` }}
                  />
                </div>
              </div>
              <StatusRow label="Speaker" value={state.speaking} />
            </div>
          </section>

          <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-panel">
            <div className="border-b border-border px-4 py-2.5">
              <p className="font-mono text-muted text-xs uppercase tracking-wide">
                Messages
              </p>
            </div>
            <div
              ref={listRef}
              className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-4"
            >
              {state.messages.length === 0 && !state.thinking ? (
                <p className="px-2 text-sm text-muted">
                  Start rồi nói — không cần caption trên trình duyệt.
                </p>
              ) : (
                <>
                  {state.messages.map((message) => (
                    <ChatBubble key={message.id} message={message} />
                  ))}
                  {state.thinking ? (
                    <div className="flex justify-start">
                      <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-[#243040]/80 px-3.5 py-2 text-sm text-muted italic">
                        {state.thinkingMessage || "WALL-E đang suy nghĩ..."}
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </div>
            {state.error ? (
              <p className="border-t border-border px-4 py-2 font-mono text-sm text-red-400">
                {state.error.message}
              </p>
            ) : null}
          </section>
        </div>

        <div className="flex flex-wrap justify-center gap-3 sm:justify-start">
          <button
            type="button"
            disabled={isBusy || isRunning}
            onClick={() => void start()}
            className="rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-background disabled:opacity-40"
          >
            Start
          </button>
          <button
            type="button"
            disabled={isBusy || !isRunning}
            onClick={() => void stop()}
            className="rounded-lg border border-border px-4 py-2.5 text-sm font-medium disabled:opacity-40"
          >
            Stop
          </button>
        </div>
      </div>
    </main>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  return (
    <div
      className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
          isUser
            ? "rounded-br-md bg-accent text-background"
            : "rounded-bl-md bg-[#243040] text-foreground"
        }`}
      >
        <p className="mb-1 font-mono text-[10px] uppercase tracking-wide opacity-70">
          {isUser ? "Bạn" : "WALL-E"}
        </p>
        <p className="whitespace-pre-wrap">
          {message.text || (message.pending ? "…" : "")}
          {message.pending && message.text ? (
            <span className="ml-0.5 inline-block animate-pulse">▍</span>
          ) : null}
        </p>
      </div>
    </div>
  );
}

function turnLabel(phase: string): string {
  switch (phase) {
    case "listening":
      return "Đang nghe bạn";
    case "thinking":
      return "AI đang nghe và suy nghĩ";
    case "preparing":
      return "AI đang chuẩn bị trả lời";
    case "speaking":
      return "AI đang nói";
    case "echo_hold":
      return "Sắp nghe lại…";
    default:
      return phase;
  }
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function DeviceSelect({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none rounded-lg border border-border bg-background py-2.5 pl-3 pr-10 text-sm"
      >
        {children}
      </select>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-muted"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path
            d="M2.5 4.5L6 8L9.5 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </div>
  );
}
