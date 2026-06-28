import { NextRequest, NextResponse } from "next/server";

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type DailyLimitEntry = {
  count: number;
  resetAt: number;
};

export const runtime = "nodejs";

const DAILY_MESSAGE_LIMIT = 3;
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const ipDailyLimits = new Map<string, DailyLimitEntry>();

function getClientIp(request: NextRequest) {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0]?.trim() ?? "unknown";

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp;

  return "unknown";
}

function checkDailyLimit(ip: string) {
  const now = Date.now();
  const current = ipDailyLimits.get(ip);

  if (!current || current.resetAt <= now) {
    const next = { count: 1, resetAt: now + DAY_IN_MS };
    ipDailyLimits.set(ip, next);
    return { allowed: true, remaining: DAILY_MESSAGE_LIMIT - next.count, resetAt: next.resetAt };
  }

  if (current.count >= DAILY_MESSAGE_LIMIT) {
    return { allowed: false, remaining: 0, resetAt: current.resetAt };
  }

  current.count += 1;
  return { allowed: true, remaining: DAILY_MESSAGE_LIMIT - current.count, resetAt: current.resetAt };
}

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

  const forwardedMessages = messages.filter((message, index) => {
    if (index === 0 && message.role === "assistant") return false;
    return message.role === "user" || message.role === "assistant";
  });

  if (!forwardedMessages.some((message) => message.role === "user")) {
    return NextResponse.json({ error: "Expected at least one user message." }, { status: 400 });
  }

  const limit = checkDailyLimit(getClientIp(request));

  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: "Daily message limit reached.",
        limit: DAILY_MESSAGE_LIMIT,
        remaining: limit.remaining,
        resetAt: new Date(limit.resetAt).toISOString(),
      },
      { status: 429 },
    );
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
        ...forwardedMessages,
      ],
      temperature: 0.7,
      max_tokens: 800,
      stream: true,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    return NextResponse.json(
      { error: "Modal request failed.", detail },
      { status: response.status },
    );
  }

  if (!response.body) {
    return NextResponse.json({ error: "Modal returned an empty stream." }, { status: 502 });
  }

  return new Response(response.body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-RateLimit-Limit": String(DAILY_MESSAGE_LIMIT),
      "X-RateLimit-Remaining": String(limit.remaining),
      "X-RateLimit-Reset": new Date(limit.resetAt).toISOString(),
    },
  });
}
