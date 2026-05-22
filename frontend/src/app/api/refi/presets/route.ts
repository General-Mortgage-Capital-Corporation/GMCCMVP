import { NextResponse, type NextRequest } from "next/server";
import { pyGet, PythonServiceError } from "@/lib/python-client";
import { withRefiAccess } from "@/lib/refi-access";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  return withRefiAccess(req, async () => {
    try {
      const data = await pyGet<{ presets: unknown[] }>("/api/refi/presets");
      return NextResponse.json(data);
    } catch (err) {
      const status = err instanceof PythonServiceError ? err.status : 502;
      return NextResponse.json({ error: "Failed to load refi presets" }, { status });
    }
  });
}
