import { type NextRequest, NextResponse } from "next/server";
import { rateLimit, getClientIp } from "@/lib/ratelimit";
import { pyPost, PythonServiceError } from "@/lib/python-client";

export const runtime = "nodejs";

/** Proxy batch-matching to the Python matching service. */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (!rateLimit(ip, 30)) {
    return NextResponse.json(
      { success: false, error: "Rate limit exceeded." },
      { status: 429 },
    );
  }

  const body = await req.json().catch(() => null);
  if (!Array.isArray(body)) {
    return NextResponse.json(
      { success: false, error: "Expected JSON array of listings." },
      { status: 400 },
    );
  }

  try {
    const data = await pyPost("/api/match-batch", body);
    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof PythonServiceError) {
      return NextResponse.json(
        { success: false, error: err.message },
        { status: err.status },
      );
    }
    return NextResponse.json(
      { success: false, error: "Matching service unavailable." },
      { status: 502 },
    );
  }
}
