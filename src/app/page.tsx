"use client";

import { useEffect, useRef } from "react";
import { RuntimeStatus } from "@/enums";
import { useVoiceRuntime } from "@/hooks";
import type { ChatMessage } from "@/types";

export default function Home() {
  const { state, isBusy, start, stop } = useVoiceRuntime();
  const isRunning = state.runtime === RuntimeStatus.Running;
  const levelPct = Math.round(Math.min(1, state.micLevel) * 100);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [state.messages]);

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
            Bạn bên phải · WALL-E bên trái · chỉ mở bubble mới khi có trả lời
          </p>
        </header>

        <div className="grid h-[min(62vh,520px)] grid-cols-1 gap-4 md:grid-cols-2">
          <section className="flex h-full min-h-0 flex-col rounded-xl border border-border bg-panel p-5 font-mono text-sm">
            <p className="mb-4 text-muted text-xs uppercase tracking-wide">
              Status
            </p>
            <div className="flex flex-1 flex-col justify-center gap-4">
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
              {state.messages.length === 0 ? (
                <p className="px-2 text-sm text-muted">
                  Start rồi nói — tin nhắn sẽ hiện ở đây.
                </p>
              ) : (
                state.messages.map((message) => (
                  <ChatBubble key={message.id} message={message} />
                ))
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
        } ${message.pending ? "opacity-85" : ""}`}
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

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted">{label}</span>
      <span>{value}</span>
    </div>
  );
}
