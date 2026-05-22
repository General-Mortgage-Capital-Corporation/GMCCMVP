/**
 * Server-side Microsoft Graph helpers for group membership checks.
 *
 * Used by the Refi Finder access gate to dynamically resolve which users
 * belong to the configured distribution / M365 group (e.g. ai@gmccloan.com),
 * so we don't have to manually maintain an email allowlist as the team
 * grows.
 *
 * Requires:
 *   - Azure AD app permission `GroupMember.Read.All` (Application) with
 *     admin consent granted.
 *   - The same AZURE_CLIENT_ID + AZURE_CLIENT_SECRET that graph-client.ts
 *     uses for sendMail (already configured for follow-ups).
 *   - One of:
 *       REFI_FINDER_GROUP_ID   — group's Object ID (UUID, preferred)
 *       REFI_FINDER_GROUP_MAIL — group's mail address (resolved on first
 *                                use, cached). Slower because it requires
 *                                an extra GET /groups?$filter call.
 */

import { getAppToken } from "@/lib/graph-client";

const GRAPH = "https://graph.microsoft.com/v1.0";

// Per-Node-instance caches. Vercel functions are ephemeral; each warm
// instance caches for the TTL window, cold starts re-resolve. Acceptable
// for a check that runs once per UI session per user.
const _idByMailCache = new Map<string, { id: string; expiresAt: number }>();
const _membersCache = new Map<string, { members: Set<string>; expiresAt: number }>();

const GROUP_ID_TTL_MS = 60 * 60 * 1000;     // 1 hour — group IDs effectively never change
const MEMBERS_TTL_MS = 10 * 60 * 1000;       // 10 minutes — picks up team changes within a coffee break


/**
 * Resolve a group's Object ID from its mail address. Cached for 1 hour.
 * Returns null on failure (insufficient permissions, group not found, etc.).
 */
async function resolveGroupIdByMail(mail: string): Promise<string | null> {
  const key = mail.toLowerCase().trim();
  const cached = _idByMailCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.id;

  const token = await getAppToken();
  if (!token) return null;

  // Graph $filter requires escaping single quotes
  const escaped = key.replace(/'/g, "''");
  const url = `${GRAPH}/groups?$filter=mail eq '${escaped}'&$select=id&$top=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    console.warn("[graph-groups] resolveGroupIdByMail HTTP", res.status, mail);
    return null;
  }
  const data = (await res.json()) as { value?: { id: string }[] };
  const id = data.value?.[0]?.id;
  if (!id) return null;
  _idByMailCache.set(key, { id, expiresAt: Date.now() + GROUP_ID_TTL_MS });
  return id;
}


/**
 * Fetch every member email for a group (paginated). Cached for 10 min.
 * Returns null on Graph failure (caller falls back to allowlist).
 */
async function fetchGroupMemberEmails(groupId: string): Promise<Set<string> | null> {
  const cached = _membersCache.get(groupId);
  if (cached && cached.expiresAt > Date.now()) return cached.members;

  const token = await getAppToken();
  if (!token) return null;

  const emails = new Set<string>();
  let url: string | null = `${GRAPH}/groups/${groupId}/members?$select=id,mail,userPrincipalName&$top=100`;
  // Walk @odata.nextLink for groups larger than one page (100 members).
  while (url) {
    const res: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn("[graph-groups] member list HTTP", res.status, groupId);
      return null;
    }
    const data = (await res.json()) as {
      value?: { mail?: string | null; userPrincipalName?: string | null }[];
      "@odata.nextLink"?: string;
    };
    for (const m of data.value ?? []) {
      // mail can be null for some accounts (no exchange mailbox); fall back to UPN
      const email = (m.mail ?? m.userPrincipalName)?.toLowerCase();
      if (email) emails.add(email);
    }
    url = data["@odata.nextLink"] ?? null;
  }
  _membersCache.set(groupId, { members: emails, expiresAt: Date.now() + MEMBERS_TTL_MS });
  return emails;
}


/** True if the email belongs to the configured Refi Finder group. */
export async function isEmailInRefiGroup(email: string): Promise<boolean> {
  if (!email) return false;
  const groupId =
    process.env.REFI_FINDER_GROUP_ID ??
    (process.env.REFI_FINDER_GROUP_MAIL
      ? await resolveGroupIdByMail(process.env.REFI_FINDER_GROUP_MAIL)
      : null);
  if (!groupId) return false;
  const members = await fetchGroupMemberEmails(groupId);
  if (!members) return false;
  return members.has(email.toLowerCase().trim());
}
