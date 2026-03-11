import { type NextRequest, NextResponse } from "next/server";
import { rateLimit, getClientIp } from "@/lib/ratelimit";
import { pyPost, PythonServiceError } from "@/lib/python-client";

export const runtime = "nodejs";

/** Proxy LLM explanation generation to the Python service. */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (!rateLimit(ip, 20)) {
    return NextResponse.json(
      { success: false, error: "Rate limit exceeded." },
      { status: 429 },
    );
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { success: false, error: "Request body required." },
      { status: 400 },
    );
  }

  try {
    const data = await pyPost("/api/explain", body);
    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof PythonServiceError) {
      return NextResponse.json(
        { success: false, error: err.message },
        { status: err.status },
      );
    }
    return NextResponse.json(
      { success: false, error: "Explanation service unavailable." },
      { status: 502 },
    );
  }
}
