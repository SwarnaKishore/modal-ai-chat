// app/api/chat/route.ts
import { NextRequest, NextResponse } from "next/server";

// ── Rate limiting (simple in-memory store) ────────────────────────────────
// Replace with Redis / Upstash for production multi-instance deployments.
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const DAILY_LIMIT = 3;

function checkRateLimit(ip: string): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  const resetAt = midnight.getTime();

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

// ── Types ─────────────────────────────────────────────────────────────────
type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

type RequestBody = {
  messages: ChatMessage[];
  model?: string;
  systemPrompt?: string;
};

// ── Handler ───────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  // 1. Rate limit
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const { allowed, remaining, resetAt } = checkRateLimit(ip);

  if (!allowed) {
    return NextResponse.json(
      { error: "Daily message limit reached. Come back tomorrow." },
      { status: 429 }
    );
  }

  // 2. Parse body
  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { messages, model, systemPrompt } = body;

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
        max_tokens: 1024,
        temperature: 0.7,
      }),
    });
  } catch (err) {
    console.error("Modal upstream error:", err);
    return NextResponse.json(
      { error: "Could not reach the inference server." },
      { status: 502 }
    );
  }

  if (!upstreamResponse.ok) {
    const text = await upstreamResponse.text().catch(() => "");
    console.error("Modal error response:", text);
    return NextResponse.json(
      { error: "Inference server returned an error." },
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
