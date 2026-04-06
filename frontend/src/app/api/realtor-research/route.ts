import { type NextRequest, NextResponse } from "next/server";
import { researchRealtor } from "@/lib/services/realtor-research";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.name && !body?.email && !body?.company) {
    return NextResponse.json({ error: "name, email, or company required" }, { status: 400 });
  }

  try {
    const result = await researchRealtor({
      name: body.name,
      email: body.email,
      company: body.company,
      city: body.city,
      state: body.state,
      forceRefresh: body.forceRefresh === true,
    });

    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Research failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
