import { NextRequest, NextResponse } from "next/server";

function getAccessCode() {
  return process.env.APP_ACCESS_CODE?.trim() ?? "";
}

export async function GET() {
  return NextResponse.json({ enabled: Boolean(getAccessCode()) });
}

export async function POST(req: NextRequest) {
  const configuredCode = getAccessCode();
  if (!configuredCode) return NextResponse.json({ ok: true });

  const body = (await req.json().catch(() => null)) as { code?: string } | null;
  const code = body?.code?.trim() ?? "";

  if (code !== configuredCode) {
    return NextResponse.json(
      { error: "Enter the correct access code to use this app." },
      { status: 401 }
    );
  }

  return NextResponse.json({ ok: true });
}
