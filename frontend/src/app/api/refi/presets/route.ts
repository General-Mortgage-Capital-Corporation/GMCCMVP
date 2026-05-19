import { NextResponse } from "next/server";
import { pyGet, PythonServiceError } from "@/lib/python-client";

export const runtime = "nodejs";

export async function GET() {
  try {
    const data = await pyGet<{ presets: unknown[] }>("/api/refi/presets");
    return NextResponse.json(data);
  } catch (err) {
    const status = err instanceof PythonServiceError ? err.status : 502;
    return NextResponse.json({ error: "Failed to load refi presets" }, { status });
  }
}
