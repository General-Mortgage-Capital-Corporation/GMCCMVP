import { type NextRequest, NextResponse } from "next/server";
import { rateLimit, getClientIp } from "@/lib/ratelimit";
import { verifyIdTokenWithEmail } from "@/lib/firestore-admin";
import type {
  EngineProgram,
  PricingScenario,
  QuoteApiResponse,
  QuoteResponse,
} from "@/types/pricing";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Property-search → MLO portal pricing aggregator proxy.
 *
 * Per property-search-unified-pricing.md section 5:
 *   - LO email comes from the verified Firebase ID token (NEVER trust client input).
 *   - Shared secret stays server-side; we forward it to the MLO portal as
 *     `Authorization: Bearer <PROPERTY_SEARCH_API_KEY>` and place the LO email
 *     in the JSON body for v1.
 */

const DEFAULT_PROGRAMS: EngineProgram[] = ["loannex", "qm_jumbo", "bws"];

interface PostBody {
  scenario?: PricingScenario;
  programs?: EngineProgram[];
}

function jsonError(error: string, code: NonNullable<Extract<QuoteApiResponse, { success: false }>["code"]>, status: number) {
  return NextResponse.json<QuoteApiResponse>(
    { success: false, error, code },
    { status },
  );
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (!rateLimit(`pricing:${ip}`, 30)) {
    return jsonError("Rate limit exceeded. Try again in a minute.", "rate_limited", 429);
  }

  // Auth — extract LO email from a verified Firebase ID token.
  const authHeader = req.headers.get("authorization") ?? "";
  const idToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  if (!idToken) {
    return jsonError("Sign-in required to compare pricing.", "auth_required", 401);
  }
  const verified = await verifyIdTokenWithEmail(idToken);
  if (!verified?.email) {
    return jsonError("Your session expired. Sign in again.", "auth_required", 401);
  }
  const loEmail = verified.email;

  // Body
  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body || !body.scenario) {
    return jsonError("Scenario is required.", "upstream_error", 400);
  }
  const programs = body.programs && body.programs.length > 0 ? body.programs : DEFAULT_PROGRAMS;

  // MLO portal config
  const baseUrl = process.env.MLO_PRICING_API_URL;
  const sharedSecret = process.env.MLO_PRICING_API_KEY;
  if (!baseUrl || !sharedSecret) {
    return jsonError(
      "Pricing service is not configured yet. Reach out to the platform team.",
      "config_missing",
      503,
    );
  }

  const url = `${baseUrl.replace(/\/$/, "")}/api/public/pricing/quote`;

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sharedSecret}`,
      },
      body: JSON.stringify({
        lo_email: loEmail,
        programs,
        scenario: body.scenario,
      }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    return jsonError(
      isTimeout
        ? "Pricing service timed out. Try again."
        : "Could not reach the pricing service.",
      "service_unavailable",
      504,
    );
  }

  if (!upstreamRes.ok) {
    const text = await upstreamRes.text().catch(() => "");
    return jsonError(
      `Pricing service returned ${upstreamRes.status}: ${text.slice(0, 200) || "no body"}`,
      "upstream_error",
      502,
    );
  }

  const data = (await upstreamRes.json().catch(() => null)) as QuoteResponse | null;
  if (!data || !Array.isArray(data.results)) {
    return jsonError("Pricing service returned a malformed response.", "upstream_error", 502);
  }

  return NextResponse.json<QuoteApiResponse>({ success: true, ...data });
}
