import { NextResponse } from "next/server";
import { pyGet, PythonServiceError } from "@/lib/python-client";

export const runtime = "nodejs";

/** Return the program → state → county hierarchy from the matching service. */
export async function GET() {
  try {
    const data = await pyGet("/api/program-locations");
    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof PythonServiceError) {
      return NextResponse.json({ programs: [] }, { status: err.status });
    }
    return NextResponse.json({ programs: [] }, { status: 502 });
  }
}
