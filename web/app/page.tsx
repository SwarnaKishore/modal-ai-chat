"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useMemo, useState } from "react";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  meta?: string;
};

type ChatErrorResponse = {
  error?: string;
  remaining?: number;
  resetAt?: string;
};

const MODELS = [
  { id: "Qwen/Qwen2.5-7B-Instruct", label: "Qwen2.5-7B" },
];

const DEFAULT_SYSTEM = "You are a helpful AI assistant. Be concise and accurate.";

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content: "Ask me anything. I’ll stream the response as it comes in.",
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [rateLimitStatus, setRateLimitStatus] = useState("3 chats left today");
  const [selectedModel, setSelectedModel] = useState(MODELS[0].id);
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM);
  const [showSysPrompt, setShowSysPrompt] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canSend = useMemo(() => input.trim().length > 0 && !isLoading, [input, isLoading]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  async function runInference(history: ChatMessage[]) {
    setIsLoading(true);
    const startedAt = performance.now();

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history,
          model: selectedModel,
          systemPrompt: systemPrompt.trim() || DEFAULT_SYSTEM,
        }),
      });

      if (!response.ok) {
        const error = (await response.json().catch(() => null)) as ChatErrorResponse | null;
        if (typeof error?.remaining === "number") {
          setRateLimitStatus(`${error.remaining} chats left today`);
        }
        throw new Error(error?.error ?? "The chat request failed.");
      }

      if (!response.body) throw new Error("No stream in response.");

      const remaining = response.headers.get("X-RateLimit-Remaining");
      if (remaining) setRateLimitStatus(`${remaining} chats left today`);

      const assistantMessage: ChatMessage = { role: "assistant", content: "" };
      setMessages([...history, assistantMessage]);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantContent = "";
      let firstResponseAt: number | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") break;

          const chunk = JSON.parse(payload);
          const token = chunk?.choices?.[0]?.delta?.content;
          if (typeof token !== "string") continue;

          assistantContent += token;
          firstResponseAt ??= performance.now();
          setMessages([...history, { role: "assistant", content: assistantContent }]);
        }
      }

      const elapsedSeconds = (performance.now() - startedAt) / 1000;
      const firstResponseSeconds = firstResponseAt
        ? (firstResponseAt - startedAt) / 1000
        : elapsedSeconds;
      const meta = `Started responding in ${firstResponseSeconds.toFixed(1)}s · completed in ${elapsedSeconds.toFixed(1)}s`;
      setMessages([...history, { role: "assistant", content: assistantContent, meta }]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      setMessages([...history, { role: "assistant", content: `⚠ ${message}` }]);
    } finally {
      setIsLoading(false);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = input.trim();
    if (!content) return;
    const nextMessages: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(nextMessages);
    setInput("");
    await runInference(nextMessages);
  }

  async function retryLast() {
    // Find the last user message and re-run from there
    const lastUserIdx = [...messages].reverse().findIndex((m) => m.role === "user");
    if (lastUserIdx === -1) return;
    const idx = messages.length - 1 - lastUserIdx;
    const historyUpToUser = messages.slice(0, idx + 1);
    setMessages(historyUpToUser);
    await runInference(historyUpToUser);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  async function copyMessage(content: string, index: number) {
    await navigator.clipboard.writeText(content);
    setCopiedIndex(index);
    window.setTimeout(() => setCopiedIndex(null), 1400);
  }

  const currentModelLabel = MODELS.find((m) => m.id === selectedModel)?.label ?? selectedModel;

  return (
    <main className="shell">
      <section className="chat-panel" aria-label="Qwen chat">

        {/* ── Topbar ── */}
        <header className="topbar">
          <div className="topbar-left">
            <div className="model-avatar" aria-hidden="true">🤖</div>
            <div className="topbar-meta">
              <h1>Qwen Chat</h1>
              <p className="topbar-sub">Modal + vLLM · self-hosted</p>
            </div>
          </div>
          <div className="topbar-right">
            <span className="badge badge-stream">
              <span className="pulse-dot" aria-hidden="true" />
              Streaming
            </span>
            <span className="badge badge-rate" title="Daily message limit">
              🔥 {rateLimitStatus}
            </span>
          </div>
        </header>

        {/* ── Model selector row ── */}
        <div className="toolbar-row">
          <label className="toolbar-label" htmlFor="model-select">Model</label>
          <select
            id="model-select"
            className="model-select"
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            disabled={isLoading}
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>

          <button
            type="button"
            className="sys-prompt-btn"
            onClick={() => setShowSysPrompt((v) => !v)}
            aria-expanded={showSysPrompt}
          >
            ⚙ System prompt
          </button>
        </div>

        {/* ── System prompt drawer ── */}
        {showSysPrompt && (
          <div className="sys-drawer">
            <label className="sys-drawer-label" htmlFor="sys-prompt">System prompt</label>
            <textarea
              id="sys-prompt"
              className="sys-textarea"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="You are a helpful assistant…"
              rows={3}
            />
          </div>
        )}

        {/* ── Messages ── */}
        <div className="messages" role="log" aria-live="polite">
          {messages.map((message, index) => (
            <article className={`message ${message.role}`} key={`${message.role}-${index}`}>
              <span className="message-role">
                {message.role === "assistant" ? currentModelLabel : "You"}
              </span>

              <div className="bubble">
                <p>{message.content}</p>
              </div>

              {/* Actions — only on non-empty assistant messages */}
              {message.role === "assistant" && message.content && !message.content.startsWith("⚠") && (
                <div className="bubble-actions">
                  <button
                    type="button"
                    className="action-btn"
                    onClick={() => copyMessage(message.content, index)}
                    aria-label="Copy message"
                  >
                    {copiedIndex === index ? "✓ Copied" : "⎘ Copy"}
                  </button>
                  {/* Show Retry only on the last assistant message */}
                  {index === messages.length - 1 && (
                    <button
                      type="button"
                      className="action-btn"
                      onClick={retryLast}
                      disabled={isLoading}
                      aria-label="Retry last response"
                    >
                      ↺ Retry
                    </button>
                  )}
                </div>
              )}

              {message.meta && (
                <p className="message-meta">{message.meta}</p>
              )}
            </article>
          ))}

          {/* Typing indicator — shown only when waiting for first token */}
          {isLoading && messages[messages.length - 1]?.role !== "assistant" && (
            <article className="message assistant" aria-label="Qwen is thinking">
              <span className="message-role">{currentModelLabel}</span>
              <div className="bubble">
                <div className="thinking-state">
                  <div className="typing-indicator" aria-label="Waking GPU">
                    <span /><span /><span />
                  </div>
                  <p>Waking GPU. First response can take a minute. Stays warm for about 5 minutes.</p>
                </div>
              </div>
            </article>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* ── Composer ── */}
        <form className="composer" onSubmit={sendMessage}>
          <div className="composer-input-row">
            <textarea
              ref={textareaRef}
              aria-label="Message"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask Qwen… (↵ send, ⇧↵ newline)"
              rows={3}
              disabled={isLoading}
            />
            <button type="submit" className="send-btn" disabled={!canSend} aria-label="Send">
              ➤
            </button>
          </div>
          <div className="composer-footer">
            <span className="composer-hint">{currentModelLabel} · Modal · vLLM</span>
            <span className="char-count">{input.length} / 2000</span>
          </div>
        </form>

      </section>
    </main>
  );
}
