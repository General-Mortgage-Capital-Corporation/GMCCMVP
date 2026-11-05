/**
 * fillPdfFlier fails intermittently (Chrome won't launch on an instance: about
 * 8% of requests in Nov 2026), and the same request usually works a moment
 * later. Server errors and network failures are retried; a 4xx is a real
 * answer and is returned as is.
 */
export async function fetchWithRetry(
  request: () => Promise<Response>,
  { attempts = 3, delayMs = 500 }: { attempts?: number; delayMs?: number } = {},
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await request();
      if (res.status < 500 || attempt >= attempts) return res;
    } catch (err) {
      if (attempt >= attempts) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
  }
}
