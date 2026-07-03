// app/api/chat/route.ts
import { Redis } from "@upstash/redis";
import { NextRequest, NextResponse } from "next/server";

// ── Rate limiting (simple in-memory store) ────────────────────────────────
// Uses Upstash Redis when configured, with an in-memory fallback for local dev.
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const DAILY_LIMIT = Math.round(clampNumber(process.env.RATE_LIMIT_DAILY, 3, 1, 100));

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

function validateAccessCode(req: NextRequest) {
  const configuredCode = process.env.APP_ACCESS_CODE?.trim();
  if (!configuredCode) return null;

  const providedCode = req.headers.get("x-app-access-code")?.trim();
  if (providedCode === configuredCode) return null;

  return NextResponse.json(
    { error: "Enter the correct access code to use this app." },
    { status: 401 }
  );
}

function getClientIp(req: NextRequest) {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
}

function getNextResetAt() {
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime();
}

function getSecondsUntilReset(resetAt: number) {
  return Math.max(Math.ceil((resetAt - Date.now()) / 1000), 1);
}

function getRateLimitKey(ip: string) {
  const today = new Date().toISOString().slice(0, 10);
  return `rate-limit:chat:${ip}:${today}`;
}

function getMemoryRateLimitStatus(ip: string): { limit: number; remaining: number; resetAt: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now >= entry.resetAt) {
    return { limit: DAILY_LIMIT, remaining: DAILY_LIMIT, resetAt: getNextResetAt() };
  }

  return {
    limit: DAILY_LIMIT,
    remaining: Math.max(DAILY_LIMIT - entry.count, 0),
    resetAt: entry.resetAt,
  };
}

function checkMemoryRateLimit(ip: string): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const resetAt = getNextResetAt();

  const entry = rateLimitMap.get(ip);

  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt });
    return { allowed: true, remaining: DAILY_LIMIT - 1, resetAt };
  }

  if (entry.count >= DAILY_LIMIT) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count += 1;
  return { allowed: true, remaining: DAILY_LIMIT - entry.count, resetAt: entry.resetAt };
}

async function getRateLimitStatus(ip: string) {
  if (!redis) return getMemoryRateLimitStatus(ip);

  const resetAt = getNextResetAt();
  const key = getRateLimitKey(ip);
  const used = Number((await redis.get<number>(key)) ?? 0);

  return {
    limit: DAILY_LIMIT,
    remaining: Math.max(DAILY_LIMIT - used, 0),
    resetAt,
  };
}

async function checkRateLimit(ip: string) {
  if (!redis) return checkMemoryRateLimit(ip);

  const resetAt = getNextResetAt();
  const key = getRateLimitKey(ip);
  const used = await redis.incr(key);

  if (used === 1) {
    await redis.expire(key, getSecondsUntilReset(resetAt));
  }

  return {
    allowed: used <= DAILY_LIMIT,
    remaining: Math.max(DAILY_LIMIT - used, 0),
    resetAt,
  };
}

export async function GET(req: NextRequest) {
  const accessError = validateAccessCode(req);
  if (accessError) return accessError;

  const status = await getRateLimitStatus(getClientIp(req));

  return NextResponse.json({
    limit: status.limit,
    remaining: status.remaining,
    resetAt: new Date(status.resetAt).toISOString(),
  });
}

// ── Types ─────────────────────────────────────────────────────────────────
type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

type RequestBody = {
  messages: ChatMessage[];
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
};

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) return fallback;
  return Math.min(Math.max(numericValue, min), max);
}

// ── Handler ───────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const accessError = validateAccessCode(req);
  if (accessError) return accessError;

  // 1. Rate limit
  const ip = getClientIp(req);
  const { allowed, remaining, resetAt } = await checkRateLimit(ip);

  if (!allowed) {
    return NextResponse.json(
      {
        error: `You’ve used today’s ${DAILY_LIMIT} ${DAILY_LIMIT === 1 ? "chat" : "chats"}. Try again tomorrow.`,
        limit: DAILY_LIMIT,
        remaining,
        resetAt: new Date(resetAt).toISOString(),
      },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": String(DAILY_LIMIT),
          "X-RateLimit-Remaining": String(remaining),
          "X-RateLimit-Reset": new Date(resetAt).toISOString(),
        },
      }
    );
  }

  // 2. Parse body
  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { messages, model, systemPrompt, temperature, maxTokens } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: "Messages array is required." }, { status: 400 });
  }

  // 3. Build the messages array for vLLM
  //    Prepend system prompt if provided, ensuring no duplicate system messages.
  const systemMessage: ChatMessage = {
    role: "system",
    content: systemPrompt?.trim() || "You are a helpful AI assistant. Be concise and accurate.",
  };

  const filteredMessages = messages.filter((m) => m.role !== "system");
  const vllmMessages = [systemMessage, ...filteredMessages];
  const safeTemperature = clampNumber(temperature, 0.7, 0, 1.5);
  const safeMaxTokens = Math.round(clampNumber(maxTokens, 1024, 128, 2048));

  // 4. Forward to Modal/vLLM
  const modalUrl = process.env.MODAL_BASE_URL;
  const modalApiKey = process.env.MODAL_API_KEY;

  if (!modalUrl || !modalApiKey) {
    return NextResponse.json(
      { error: "MODAL_BASE_URL or MODAL_API_KEY is not configured." },
      { status: 500 }
    );
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(`${modalUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${modalApiKey}`,
      },
      body: JSON.stringify({
        model: model ?? "Qwen/Qwen2.5-7B-Instruct",
        messages: vllmMessages,
        stream: true,
        max_tokens: safeMaxTokens,
        temperature: safeTemperature,
      }),
    });
  } catch (err) {
    console.error("Modal upstream error:", err);
    return NextResponse.json(
      { error: "The model server is currently paused or unavailable. Please try again later." },
      { status: 502 }
    );
  }

  if (!upstreamResponse.ok) {
    const text = await upstreamResponse.text().catch(() => "");
    console.error("Modal error response:", text);

    const errorMessage =
      upstreamResponse.status === 401 || upstreamResponse.status === 403
        ? "The model server rejected this request. Please check the Modal API key configuration."
        : upstreamResponse.status === 429
          ? "The model server is busy right now. Please try again in a moment."
          : upstreamResponse.status >= 500
            ? "The model server is currently paused or unavailable. Please try again later."
            : "The model server could not complete this request. Please try again.";

    return NextResponse.json(
      { error: errorMessage },
      { status: upstreamResponse.status }
    );
  }

  // 5. Stream response back with rate limit header
  return new Response(upstreamResponse.body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-RateLimit-Limit": String(DAILY_LIMIT),
      "X-RateLimit-Remaining": String(remaining),
      "X-RateLimit-Reset": new Date(resetAt).toISOString(),
    },
  });
}
