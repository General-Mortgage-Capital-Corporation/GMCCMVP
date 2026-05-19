import { type NextRequest, NextResponse } from "next/server";
import { rateLimit, getClientIp } from "@/lib/ratelimit";
import { pyPost, PythonServiceError } from "@/lib/python-client";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (!rateLimit(ip, 60)) {
    return NextResponse.json({ success: false, error: "Rate limit exceeded." }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ success: false, error: "Invalid request body." }, { status: 400 });
  }

  try {
    const data = await pyPost<Record<string, unknown>>("/api/refi/preview", body);
    return NextResponse.json(data);
  } catch (err) {
    const status = err instanceof PythonServiceError ? err.status : 502;
    const msg = err instanceof PythonServiceError ? err.message : "Refi preview failed.";
    return NextResponse.json({ success: false, error: msg }, { status });
  }
}
