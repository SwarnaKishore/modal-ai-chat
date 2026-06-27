import { NextRequest, NextResponse } from "next/server";

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const modalBaseUrl = process.env.MODAL_BASE_URL;
  const modalApiKey = process.env.MODAL_API_KEY;
  const model = process.env.QWEN_MODEL ?? "Qwen/Qwen2.5-7B-Instruct";

  if (!modalBaseUrl || !modalApiKey) {
    return NextResponse.json(
      { error: "Missing MODAL_BASE_URL or MODAL_API_KEY on the server." },
      { status: 500 },
    );
  }

  const body = await request.json().catch(() => null);
  const messages = body?.messages as ChatMessage[] | undefined;

  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: "Expected a non-empty messages array." }, { status: 400 });
  }

  const response = await fetch(`${modalBaseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${modalApiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "You are a concise, helpful assistant.",
        },
        ...messages,
      ],
      temperature: 0.7,
      max_tokens: 800,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    return NextResponse.json(
      { error: "Modal request failed.", detail },
      { status: response.status },
    );
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  if (typeof content !== "string") {
    return NextResponse.json({ error: "Modal returned an unexpected response." }, { status: 502 });
  }

  return NextResponse.json({ content });
}
