/**
 * HTTP client for the Python matching microservice.
 *
 * PYTHON_SERVICE_URL defaults to http://localhost:5001 in development.
 * Set it in .env.local (or Vercel env vars) to point at the deployed service.
 */

import type { CountyInfo } from "@/types";

const BASE = process.env.PYTHON_SERVICE_URL ?? "http://localhost:5001";

export class PythonServiceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PythonServiceError";
    this.status = status;
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new PythonServiceError(
      body.error ?? `Python service error (${res.status})`,
      res.status,
    );
  }
  return res.json() as Promise<T>;
}

export async function pyGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    signal,
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  return handleResponse<T>(res);
}

export class CountyLookupError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "CountyLookupError";
    this.status = status;
  }
}

/**
 * Resolves county metadata from the Python service.
 * Throws CountyLookupError (with HTTP status) on any failure so callers
 * can return a typed error response without duplicating try/catch logic.
 */
export async function resolveCountyInfo(fips: string): Promise<CountyInfo> {
  let result: { success: boolean; info: CountyInfo; error?: string };
  try {
    result = await pyGet<{ success: boolean; info: CountyInfo; error?: string }>(
      `/api/county-info?fips=${encodeURIComponent(fips)}`,
    );
  } catch (err) {
    if (err instanceof PythonServiceError) {
      throw new CountyLookupError(err.message, err.status);
    }
    throw new CountyLookupError("Failed to resolve county information.", 502);
  }
  if (!result.success) {
    throw new CountyLookupError(result.error ?? `Unknown county FIPS: ${fips}`, 400);
  }
  return result.info;
}

export async function pyPost<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal,
    cache: "no-store",
  });
  return handleResponse<T>(res);
}
