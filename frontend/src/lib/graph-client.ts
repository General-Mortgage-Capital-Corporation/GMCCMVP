/**
 * Server-side Microsoft Graph client using client credentials flow.
 * Used by cron jobs for auto-send follow-ups and reply detection.
 *
 * Requires: AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, NEXT_PUBLIC_AZURE_TENANT_ID
 */

let _cachedToken: { token: string; expiresAt: number } | null = null;

async function getAppToken(): Promise<string | null> {
  const clientId = process.env.NEXT_PUBLIC_AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET_VALUE ?? process.env.AZURE_CLIENT_SECRET;
  const tenantId = process.env.NEXT_PUBLIC_AZURE_TENANT_ID;

  if (!clientId || !clientSecret || !tenantId) return null;

  // Return cached token if still valid (5-min buffer)
  if (_cachedToken && _cachedToken.expiresAt > Date.now() + 5 * 60 * 1000) {
    return _cachedToken.token;
  }

  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({})) as { error_description?: string };
    console.error("[graph-client] Token fetch failed:", res.status, errBody.error_description ?? "");
    return null;
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  _cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return _cachedToken.token;
}

export interface GraphMessage {
  subject: string;
  body: { contentType: "HTML" | "Text"; content: string };
  toRecipients: { emailAddress: { address: string; name?: string } }[];
  /** Set conversationId to send in the same thread as the original email */
  conversationId?: string;
  /** Set internetMessageHeaders for In-Reply-To threading */
  internetMessageHeaders?: { name: string; value: string }[];
}

/** Send an email as a specific user using application permissions. */
export async function sendMailAs(
  userEmail: string,
  message: GraphMessage,
): Promise<{ ok: boolean; error?: string }> {
  const token = await getAppToken();
  if (!token) return { ok: false, error: "Graph application credentials not configured" };

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userEmail)}/sendMail`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ message, saveToSentItems: true }),
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    return { ok: false, error: err.error?.message ?? `Graph API error ${res.status}` };
  }

  return { ok: true };
}

/** Check if the recipient has sent any email to the user since the original was sent. */
export async function checkForReply(
  userEmail: string,
  _subject: string,
  recipientEmail: string,
  sentAt?: number,
): Promise<boolean> {
  const token = await getAppToken();
  if (!token) return false;

  // Look for ANY email from this recipient received after the original was sent
  // This catches replies in the same thread AND new threads from the same person
  const sinceDate = sentAt
    ? new Date(sentAt).toISOString()
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // fallback: last 30 days

  const escapedEmail = recipientEmail.replace(/'/g, "''");
  const filter = `from/emailAddress/address eq '${escapedEmail}' and receivedDateTime ge ${sinceDate}`;
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userEmail)}/messages?$filter=${encodeURIComponent(filter)}&$top=1&$select=id,receivedDateTime`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!res.ok) return false;

  const data = (await res.json()) as { value: unknown[] };
  return data.value.length > 0;
}

/** Find the original sent message to get threading IDs for follow-ups. */
export async function getOriginalMessageIds(
  userEmail: string,
  subject: string,
  recipientEmail: string,
): Promise<{ conversationId: string; internetMessageId: string } | null> {
  const token = await getAppToken();
  if (!token) return null;

  try {
    const filter = `subject eq '${subject.replace(/'/g, "''")}' and toRecipients/any(r:r/emailAddress/address eq '${recipientEmail.replace(/'/g, "''")}')`;
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userEmail)}/mailFolders/sentItems/messages?$filter=${encodeURIComponent(filter)}&$top=1&$select=conversationId,internetMessageId&$orderby=sentDateTime desc`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { value: { conversationId?: string; internetMessageId?: string }[] };
    const msg = data.value?.[0];
    if (msg?.conversationId && msg?.internetMessageId) {
      return { conversationId: msg.conversationId, internetMessageId: msg.internetMessageId };
    }
  } catch { /* ignore */ }
  return null;
}

/** Check if application Graph credentials are configured and working. */
export async function isAutoSendAvailable(): Promise<boolean> {
  const token = await getAppToken();
  return token !== null;
}
