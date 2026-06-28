"use client";

import { FormEvent, KeyboardEvent, useMemo, useState } from "react";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content: "Ask me something. I am routed through your Next.js API to Qwen on Modal.",
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const canSend = useMemo(() => input.trim().length > 0 && !isLoading, [input, isLoading]);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const content = input.trim();
    if (!content) return;

    const nextMessages: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(nextMessages);
    setInput("");
    setIsLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error ?? "The chat request failed.");
      }

      if (!response.body) {
        throw new Error("The chat response did not include a stream.");
      }

      const assistantMessage: ChatMessage = { role: "assistant", content: "" };
      setMessages([...nextMessages, assistantMessage]);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantContent = "";

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
          setMessages([...nextMessages, { role: "assistant", content: assistantContent }]);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      setMessages([...nextMessages, { role: "assistant", content: message }]);
    } finally {
      setIsLoading(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;

    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <main className="shell">
      <section className="chat-panel" aria-label="Qwen chat">
        <header className="topbar">
          <div>
            <p className="eyebrow">Modal + vLLM</p>
            <h1>Qwen Chat</h1>
          </div>
          <span className="status">Server routed</span>
        </header>

        <div className="messages">
          {messages.map((message, index) => (
            <article className={`message ${message.role}`} key={`${message.role}-${index}`}>
              <p>{message.content}</p>
            </article>
          ))}
          {isLoading && messages[messages.length - 1]?.role !== "assistant" && (
            <article className="message assistant">
              <p>Thinking...</p>
            </article>
          )}
        </div>

        <form className="composer" onSubmit={sendMessage}>
          <textarea
            aria-label="Message"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="Ask Qwen..."
            rows={3}
          />
          <button type="submit" disabled={!canSend}>
            Send
          </button>
        </form>
      </section>
    </main>
  );
}
