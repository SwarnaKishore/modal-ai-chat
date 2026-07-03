"use client";

import { FormEvent, isValidElement, KeyboardEvent, ReactNode, useEffect, useRef, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  meta?: string;
};

type Conversation = {
  id: string;
  title: string;
  messages: ChatMessage[];
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  updatedAt: number;
};

type ChatErrorResponse = {
  error?: string;
  remaining?: number;
  resetAt?: string;
};

type RateLimitResponse = {
  remaining?: number;
};

const MODELS = [
  { id: "Qwen/Qwen2.5-7B-Instruct", label: "Qwen2.5-7B" },
];

const DEFAULT_SYSTEM = "You are a helpful AI assistant. Be concise and accurate.";
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 1024;
const STORAGE_KEY = "modal-ai-chat.conversations";
const ACCESS_CODE_STORAGE_KEY = "modal-ai-chat.access-code";
const MAX_STORED_CONVERSATIONS = 8;
const WELCOME_MESSAGE: ChatMessage = {
  role: "assistant",
  content: "Ask me anything. I’ll stream the response as it comes in.",
};

function formatRateLimitStatus(remaining: number) {
  return `${remaining} ${remaining === 1 ? "chat" : "chats"} left today`;
}

function getNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(getNodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return getNodeText(node.props.children);
  return "";
}

function createConversation(model: string): Conversation {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    messages: [WELCOME_MESSAGE],
    model,
    systemPrompt: DEFAULT_SYSTEM,
    temperature: DEFAULT_TEMPERATURE,
    maxTokens: DEFAULT_MAX_TOKENS,
    updatedAt: now,
  };
}

function getConversationTitle(messages: ChatMessage[]) {
  const firstUserMessage = messages.find((message) => message.role === "user")?.content.trim();
  if (!firstUserMessage) return "New chat";
  return firstUserMessage.length > 48 ? `${firstUserMessage.slice(0, 45)}...` : firstUserMessage;
}

function isBlankConversation(conversation: Pick<Conversation, "messages">) {
  return !conversation.messages.some((message) => message.role === "user" && message.content.trim());
}

function saveConversations(conversations: Conversation[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  } catch {
    // Keep the active chat usable even if browser storage is unavailable.
  }
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("abort"));
}

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME_MESSAGE]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);
  const [rateLimitStatus, setRateLimitStatus] = useState("3 chats left today");
  const [selectedModel, setSelectedModel] = useState(MODELS[0].id);
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM);
  const [temperature, setTemperature] = useState(DEFAULT_TEMPERATURE);
  const [maxTokens, setMaxTokens] = useState(DEFAULT_MAX_TOKENS);
  const [showSysPrompt, setShowSysPrompt] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [hasLoadedConversations, setHasLoadedConversations] = useState(false);
  const [hasAccess, setHasAccess] = useState<boolean | null>(null);
  const [accessCode, setAccessCode] = useState("");
  const [verifiedAccessCode, setVerifiedAccessCode] = useState("");
  const [accessError, setAccessError] = useState("");
  const [isCheckingAccess, setIsCheckingAccess] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const canSend = useMemo(() => input.trim().length > 0 && !isLoading, [input, isLoading]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  useEffect(() => {
    async function checkStoredAccess() {
      const response = await fetch("/api/auth");
      const settings = (await response.json().catch(() => null)) as { enabled?: boolean } | null;

      if (!settings?.enabled) {
        setHasAccess(true);
        return;
      }

      const storedCode = window.sessionStorage.getItem(ACCESS_CODE_STORAGE_KEY) ?? "";
      if (!storedCode) {
        setHasAccess(false);
        return;
      }

      const verifyResponse = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: storedCode }),
      });

      if (verifyResponse.ok) {
        setVerifiedAccessCode(storedCode);
        setHasAccess(true);
        return;
      }

      window.sessionStorage.removeItem(ACCESS_CODE_STORAGE_KEY);
      setHasAccess(false);
    }

    void checkStoredAccess().catch(() => setHasAccess(false));
  }, []);

  useEffect(() => {
    if (!hasAccess) return;

    const fallbackConversation = createConversation(MODELS[0].id);

    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      const parsed = stored ? (JSON.parse(stored) as Conversation[]) : [];
      const validConversations = Array.isArray(parsed)
        ? parsed
            .filter((conversation) => conversation.id && Array.isArray(conversation.messages))
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .filter((conversation, index, sortedConversations) => {
              if (!isBlankConversation(conversation)) return true;
              return sortedConversations.findIndex(isBlankConversation) === index;
            })
            .slice(0, MAX_STORED_CONVERSATIONS)
        : [];
      const initialConversation = validConversations[0] ?? fallbackConversation;

      setConversations(validConversations.length ? validConversations : [fallbackConversation]);
      setActiveConversationId(initialConversation.id);
      setMessages(initialConversation.messages.length ? initialConversation.messages : [WELCOME_MESSAGE]);
      setSelectedModel(initialConversation.model || MODELS[0].id);
      setSystemPrompt(initialConversation.systemPrompt || DEFAULT_SYSTEM);
      setTemperature(initialConversation.temperature ?? DEFAULT_TEMPERATURE);
      setMaxTokens(initialConversation.maxTokens ?? DEFAULT_MAX_TOKENS);
    } catch {
      setConversations([fallbackConversation]);
      setActiveConversationId(fallbackConversation.id);
    } finally {
      setHasLoadedConversations(true);
    }
  }, [hasAccess]);

  useEffect(() => {
    if (!hasLoadedConversations || !activeConversationId) return;

    setConversations((currentConversations) => {
      const updatedConversation: Conversation = {
        id: activeConversationId,
        title: getConversationTitle(messages),
        messages,
        model: selectedModel,
        systemPrompt,
        temperature,
        maxTokens,
        updatedAt: Date.now(),
      };
      const nextConversations = [
        updatedConversation,
        ...currentConversations.filter((conversation) => conversation.id !== activeConversationId),
      ].slice(0, MAX_STORED_CONVERSATIONS);

      saveConversations(nextConversations);
      return nextConversations;
    });
  }, [activeConversationId, hasLoadedConversations, maxTokens, messages, selectedModel, systemPrompt, temperature]);

  useEffect(() => {
    if (!hasAccess) return;

    async function loadUsage() {
      const headers = verifiedAccessCode ? { "x-app-access-code": verifiedAccessCode } : undefined;
      const response = await fetch("/api/chat", { headers });
      if (response.status === 401) {
        setHasAccess(false);
        return;
      }
      if (!response.ok) return;

      const usage = (await response.json().catch(() => null)) as RateLimitResponse | null;
      if (typeof usage?.remaining === "number") {
        setRateLimitStatus(formatRateLimitStatus(usage.remaining));
      }
    }

    void loadUsage();
  }, [hasAccess, verifiedAccessCode]);

  async function runInference(history: ChatMessage[]) {
    setIsLoading(true);
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const startedAt = performance.now();
    let assistantContent = "";

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(verifiedAccessCode ? { "x-app-access-code": verifiedAccessCode } : {}),
        },
        signal: abortController.signal,
        body: JSON.stringify({
          messages: history,
          model: selectedModel,
          systemPrompt: systemPrompt.trim() || DEFAULT_SYSTEM,
          temperature,
          maxTokens,
        }),
      });

      if (!response.ok) {
        const error = (await response.json().catch(() => null)) as ChatErrorResponse | null;
        if (typeof error?.remaining === "number") {
          setRateLimitStatus(formatRateLimitStatus(error.remaining));
        }
        throw new Error(error?.error ?? "The chat request failed.");
      }

      if (!response.body) throw new Error("No stream in response.");

      const remaining = response.headers.get("X-RateLimit-Remaining");
      if (remaining) setRateLimitStatus(formatRateLimitStatus(Number(remaining)));

      const assistantMessage: ChatMessage = { role: "assistant", content: "" };
      setMessages([...history, assistantMessage]);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
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
      if (abortController.signal.aborted || isAbortError(error)) {
        const elapsedSeconds = (performance.now() - startedAt) / 1000;
        const content = assistantContent || "Stopped while the model was still getting ready.";
        setMessages([
          ...history,
          {
            role: "assistant",
            content,
            meta: `Stopped by user after ${elapsedSeconds.toFixed(1)}s`,
          },
        ]);
        return;
      }

      const message = error instanceof Error ? error.message : "Something went wrong.";
      setMessages([...history, { role: "assistant", content: `⚠ ${message}` }]);
    } finally {
      abortControllerRef.current = null;
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

  async function submitAccessCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = accessCode.trim();
    if (!code) return;

    setIsCheckingAccess(true);
    setAccessError("");

    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });

      if (!response.ok) {
        const error = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(error?.error ?? "Enter the correct access code to use this app.");
      }

      window.sessionStorage.setItem(ACCESS_CODE_STORAGE_KEY, code);
      setVerifiedAccessCode(code);
      setHasAccess(true);
      setAccessCode("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to verify access code.";
      setAccessError(message);
    } finally {
      setIsCheckingAccess(false);
    }
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

  function startNewChat() {
    if (isLoading) return;
    if (!messages.some((message) => message.role === "user" && message.content.trim())) return;

    const blankConversation = conversations.find(isBlankConversation);
    if (blankConversation) {
      selectConversation(blankConversation.id);
      return;
    }

    const conversation = createConversation(selectedModel);
    setConversations((currentConversations) => [conversation, ...currentConversations].slice(0, MAX_STORED_CONVERSATIONS));
    setActiveConversationId(conversation.id);
    setMessages(conversation.messages);
    setInput("");
    setCopiedIndex(null);
    setCopiedCodeId(null);
    setSystemPrompt(DEFAULT_SYSTEM);
    setTemperature(DEFAULT_TEMPERATURE);
    setMaxTokens(DEFAULT_MAX_TOKENS);
    setShowSysPrompt(false);
  }

  function selectConversation(id: string) {
    if (isLoading || id === activeConversationId) return;

    const conversation = conversations.find((item) => item.id === id);
    if (!conversation) return;

    openConversation(conversation);
  }

  function openConversation(conversation: Conversation) {
    setActiveConversationId(conversation.id);
    setMessages(conversation.messages.length ? conversation.messages : [WELCOME_MESSAGE]);
    setSelectedModel(conversation.model || MODELS[0].id);
    setSystemPrompt(conversation.systemPrompt || DEFAULT_SYSTEM);
    setTemperature(conversation.temperature ?? DEFAULT_TEMPERATURE);
    setMaxTokens(conversation.maxTokens ?? DEFAULT_MAX_TOKENS);
    setInput("");
    setCopiedIndex(null);
    setCopiedCodeId(null);
    setShowSysPrompt(false);
  }

  function deleteConversation(id: string) {
    if (isLoading) return;

    const nextConversations = conversations.filter((conversation) => conversation.id !== id);
    const fallbackConversation = createConversation(selectedModel);
    const safeConversations = nextConversations.length ? nextConversations : [fallbackConversation];

    setConversations(safeConversations);
    saveConversations(safeConversations);

    if (id === activeConversationId) {
      openConversation(safeConversations[0]);
    }
  }

  function clearHistory() {
    if (isLoading) return;

    const conversation = createConversation(selectedModel);
    const nextConversations = [conversation];
    setConversations(nextConversations);
    saveConversations(nextConversations);
    openConversation(conversation);
  }

  function stopGenerating() {
    abortControllerRef.current?.abort();
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

  async function copyCodeBlock(content: string, id: string) {
    await navigator.clipboard.writeText(content);
    setCopiedCodeId(id);
    window.setTimeout(() => setCopiedCodeId(null), 1400);
  }

  const currentModelLabel = MODELS.find((m) => m.id === selectedModel)?.label ?? selectedModel;

  if (hasAccess !== true) {
    return (
      <main className="shell">
        <section className="access-panel" aria-label="App access">
          <div className="model-avatar access-avatar" aria-hidden="true">🤖</div>
          <h1>Qwen Chat</h1>
          <p>Enter the access code to use this self-hosted chat app.</p>
          {hasAccess === null ? (
            <p className="access-status">Checking access...</p>
          ) : (
            <form className="access-form" onSubmit={submitAccessCode}>
              <input
                type="password"
                value={accessCode}
                onChange={(event) => setAccessCode(event.target.value)}
                placeholder="Access code"
                aria-label="Access code"
                autoComplete="current-password"
                disabled={isCheckingAccess}
              />
              <button type="submit" disabled={!accessCode.trim() || isCheckingAccess}>
                {isCheckingAccess ? "Checking..." : "Unlock"}
              </button>
              {accessError && <p className="access-error">{accessError}</p>}
            </form>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <div className="app-layout">
        <aside className="conversation-sidebar" aria-label="Conversation history">
          <div className="sidebar-header">
            <span>Chats</span>
            <div className="sidebar-actions">
              <button
                type="button"
                className="new-chat-btn"
                onClick={startNewChat}
                disabled={isLoading}
              >
                + New chat
              </button>
              <button
                type="button"
                className="clear-history-btn"
                onClick={clearHistory}
                disabled={isLoading || conversations.length <= 1}
                aria-label="Clear chat history"
              >
                Clear
              </button>
            </div>
          </div>

          <nav className="conversation-list" aria-label="Saved chats">
            {conversations.map((conversation) => (
              <div
                key={conversation.id}
                className={`conversation-item ${conversation.id === activeConversationId ? "active" : ""}`}
              >
                <button
                  type="button"
                  className="conversation-open-btn"
                  onClick={() => selectConversation(conversation.id)}
                  disabled={isLoading}
                  aria-current={conversation.id === activeConversationId ? "page" : undefined}
                >
                  <span className="conversation-title">{conversation.title}</span>
                </button>
                <button
                  type="button"
                  className="conversation-delete-btn"
                  onClick={() => deleteConversation(conversation.id)}
                  disabled={isLoading}
                  aria-label={`Delete ${conversation.title}`}
                  title="Delete chat"
                >
                  ×
                </button>
              </div>
            ))}
          </nav>
        </aside>

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
            ⚙ Settings
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
            <div className="generation-settings">
              <label className="generation-control" htmlFor="temperature">
                <span>Temperature</span>
                <strong>{temperature.toFixed(1)}</strong>
                <input
                  id="temperature"
                  type="range"
                  min="0"
                  max="1.5"
                  step="0.1"
                  value={temperature}
                  onChange={(e) => setTemperature(Number(e.target.value))}
                  disabled={isLoading}
                />
              </label>
              <label className="generation-control" htmlFor="max-tokens">
                <span>Max tokens</span>
                <input
                  id="max-tokens"
                  type="number"
                  min="128"
                  max="2048"
                  step="128"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(Number(e.target.value))}
                  disabled={isLoading}
                />
              </label>
            </div>
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
                {message.role === "assistant" ? (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      pre({ children }) {
                        const codeText = getNodeText(children).replace(/\n$/, "");
                        const child = Array.isArray(children) ? children[0] : children;
                        const className = isValidElement<{ className?: string }>(child)
                          ? child.props.className ?? ""
                          : "";
                        const language = /language-(\S+)/.exec(className)?.[1] ?? "text";
                        const codeId = `${index}-${codeText.length}-${codeText.slice(0, 24)}`;

                        return (
                          <div className="code-block">
                            <div className="code-block-header">
                              <span>{language}</span>
                              <button
                                type="button"
                                className="code-copy-btn"
                                onClick={() => copyCodeBlock(codeText, codeId)}
                                aria-label={`Copy ${language} code`}
                              >
                                {copiedCodeId === codeId ? "Copied" : "Copy"}
                              </button>
                            </div>
                            <pre>{children}</pre>
                          </div>
                        );
                      },
                    }}
                  >
                    {message.content}
                  </ReactMarkdown>
                ) : (
                  <p>{message.content}</p>
                )}
              </div>

              {/* Actions — only on non-empty assistant messages */}
              {message.role === "assistant" && index > 0 && message.content && !message.content.startsWith("⚠") && (
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
                  <p>Waking GPU. First response can take a few minutes. Future replies are faster while it stays warm.</p>
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
            {isLoading ? (
              <button type="button" className="stop-btn" onClick={stopGenerating} aria-label="Stop generating">
                ■
              </button>
            ) : (
              <button type="submit" className="send-btn" disabled={!canSend} aria-label="Send">
                ➤
              </button>
            )}
          </div>
          <div className="composer-footer">
            <span className="composer-hint">{currentModelLabel} · Modal · vLLM</span>
            <span className="char-count">{input.length} / 2000</span>
          </div>
        </form>

        </section>
      </div>
    </main>
  );
}
