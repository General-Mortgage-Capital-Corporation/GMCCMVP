/**
 * Server-side helper for calling the GMCC Bill.com Cloud Functions.
 *
 * The Cloud Functions live in the same Firebase project as our auth
 * (`gmcc-66e1e`) and accept a Firebase ID token in the Authorization header.
 * Our Next.js API routes verify the caller's ID token via Firebase Admin,
 * then forward the same token to the cloud function on the user's behalf.
 *
 * Why proxy server-side instead of letting the browser hit cloud functions
 * directly: keeps invoice URLs + responses inspectable on our side (logging,
 * future per-user safety rails like a max-recharges-per-day), and avoids
 * surfacing the cloud-function base URL to the client bundle.
 */

const CLOUD_FN_BASE = "https://us-central1-gmcc-66e1e.cloudfunctions.net";
const DEFAULT_TIMEOUT_MS = 15_000;

interface CallOptions {
  /** Firebase ID token of the authenticated caller. */
  idToken: string;
  /** JSON body (sent for POST; ignored for GET). */
  body?: unknown;
  /** Override request timeout. */
  timeoutMs?: number;
}

export class CloudFunctionError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "CloudFunctionError";
  }
}

async function call<T>(
  method: "GET" | "POST",
  path: string,
  opts: CallOptions,
): Promise<T> {
  const url = `${CLOUD_FN_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.idToken}`,
  };
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(opts.body ?? {}) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    cache: "no-store",
  });

  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* leave as text for diagnostics */
  }

  if (!res.ok) {
    throw new CloudFunctionError(
      res.status,
      `Cloud function ${path} returned ${res.status}`,
      parsed,
    );
  }
  return parsed as T;
}

// --- Typed wrappers ---

export interface AddonAcknowledgeResp {
  ok?: boolean;
  acknowledged?: boolean;
  [k: string]: unknown;
}
export function addonAcknowledge(
  idToken: string,
  body: { type: "refi_finder"; autoPayEnabled: boolean },
): Promise<AddonAcknowledgeResp> {
  return call<AddonAcknowledgeResp>("POST", "/billcomAddonAcknowledge", {
    idToken,
    body,
  });
}

export interface AddonCreateInvoiceResp {
  paymentUrl: string;
  invoiceId: string;
  [k: string]: unknown;
}
export function addonCreateInvoice(
  idToken: string,
  body: { type: "refi_finder" },
): Promise<AddonCreateInvoiceResp> {
  return call<AddonCreateInvoiceResp>("POST", "/billcomAddonCreateInvoice", {
    idToken,
    body,
  });
}

export interface AddonStatusResp {
  paid: boolean;
  status: string;
  [k: string]: unknown;
}
export function addonStatus(
  idToken: string,
  type: "refi_finder",
): Promise<AddonStatusResp> {
  return call<AddonStatusResp>(
    "GET",
    `/billcomAddonStatus?type=${encodeURIComponent(type)}`,
    { idToken },
  );
}

export interface RechargeResp {
  paymentUrl: string;
  invoiceId: string;
  [k: string]: unknown;
}
export function refiFinderRecharge(idToken: string): Promise<RechargeResp> {
  return call<RechargeResp>("POST", "/billcomRefiFinderRecharge", {
    idToken,
    body: {},
  });
}

export interface CancelResp {
  success: boolean;
  status: "canceled" | "already_canceled";
  message?: string;
  [k: string]: unknown;
}
export function cancelRefiFinder(idToken: string): Promise<CancelResp> {
  return call<CancelResp>("POST", "/billcomCancelRefiFinder", {
    idToken,
    body: {},
  });
}
