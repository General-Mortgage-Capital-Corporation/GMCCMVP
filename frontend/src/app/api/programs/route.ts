import { NextResponse } from "next/server";
import { pyGet, PythonServiceError } from "@/lib/python-client";
import { requireAuth, unauthorized } from "@/lib/require-auth";

export const runtime = "nodejs";

/** Return the list of available GMCC program names from the matching service. */
export async function GET(req: Request) {
  if (!(await requireAuth(req))) return unauthorized();
  try {
    const data = await pyGet<{ programs: string[] }>("/api/programs");
    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof PythonServiceError) {
      return NextResponse.json({ programs: [] }, { status: err.status });
    }
    return NextResponse.json({ programs: [] }, { status: 502 });
  }
}
