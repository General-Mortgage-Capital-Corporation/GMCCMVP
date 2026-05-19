import { type NextRequest, NextResponse } from "next/server";
import { pyGet, PythonServiceError } from "@/lib/python-client";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const checkRemaining = req.nextUrl.searchParams.get("check_remaining") === "1";
  const path = checkRemaining ? "/api/refi/quota?check_remaining=1" : "/api/refi/quota";
  try {
    const data = await pyGet<Record<string, unknown>>(path);
    return NextResponse.json(data);
  } catch (err) {
    const status = err instanceof PythonServiceError ? err.status : 502;
    return NextResponse.json({ error: "Quota lookup failed" }, { status });
  }
}
