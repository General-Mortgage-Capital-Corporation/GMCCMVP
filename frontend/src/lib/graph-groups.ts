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
// Per-(user, group) membership: keyed by `${email}|${groupId}`. 10 min TTL.
const _userInGroupCache = new Map<string, { inGroup: boolean; expiresAt: number }>();

const GROUP_ID_TTL_MS = 60 * 60 * 1000;     // 1 hour — group IDs effectively never change
const MEMBERS_TTL_MS = 10 * 60 * 1000;       // 10 minutes — picks up team changes within a coffee break
const USER_GROUP_TTL_MS = 10 * 60 * 1000;    // 10 minutes — same horizon as members cache


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
  // transitiveMembers covers nested groups + dynamic membership (vs. /members
  // which only returns direct members).
  let url: string | null = `${GRAPH}/groups/${groupId}/transitiveMembers?$select=id,mail,userPrincipalName&$top=100`;
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


/** Resolve the configured group ID once, with caching. Centralized helper
 *  so the membership check and the debug endpoint share the same path. */
export async function getRefiGroupId(): Promise<string | null> {
  if (process.env.REFI_FINDER_GROUP_ID) return process.env.REFI_FINDER_GROUP_ID;
  if (process.env.REFI_FINDER_GROUP_MAIL) {
    return resolveGroupIdByMail(process.env.REFI_FINDER_GROUP_MAIL);
  }
  return null;
}


/**
 * True if the user belongs to the Refi Finder group.
 *
 * Uses Graph's per-user `checkMemberGroups` endpoint which:
 *   - Resolves the user by either userPrincipalName or primary mail
 *     (handles common mismatches between Firebase email and Azure UPN)
 *   - Returns transitive membership (covers nested groups)
 *   - Is a single round trip per user (vs. listing all members of the group)
 *
 * Falls back to the membership-list endpoint only on per-user errors
 * (e.g. user not found by that email), so the cached all-members path
 * still helps when there's a UPN/mail discrepancy.
 */
export async function isEmailInRefiGroup(email: string): Promise<boolean> {
  if (!email) return false;
  const userKey = email.toLowerCase().trim();
  const groupId = await getRefiGroupId();
  if (!groupId) return false;

  const cacheKey = `${userKey}|${groupId}`;
  const cached = _userInGroupCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.inGroup;

  const token = await getAppToken();
  if (!token) return false;

  // Per-user check: POST /users/{upn-or-mail}/checkMemberGroups
  let inGroup = false;
  try {
    const res = await fetch(
      `${GRAPH}/users/${encodeURIComponent(userKey)}/checkMemberGroups`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ groupIds: [groupId] }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (res.ok) {
      const data = (await res.json()) as { value?: string[] };
      inGroup = Array.isArray(data.value) && data.value.includes(groupId);
    } else if (res.status === 404) {
      // Email doesn't resolve to a user — try the member-list fallback below
      console.warn("[graph-groups] user not found by email", userKey);
    } else {
      console.warn("[graph-groups] checkMemberGroups HTTP", res.status, userKey);
    }
  } catch (err) {
    console.warn("[graph-groups] checkMemberGroups errored", err);
  }

  // Fallback: scan the full members list. Catches edge cases where the
  // user's Firebase email differs from both their Azure UPN and primary
  // mail but their listed group-member entry happens to use the Firebase
  // email (e.g. via aliases / proxyAddresses).
  if (!inGroup) {
    const members = await fetchGroupMemberEmails(groupId);
    if (members?.has(userKey)) inGroup = true;
  }

  _userInGroupCache.set(cacheKey, { inGroup, expiresAt: Date.now() + USER_GROUP_TTL_MS });
  return inGroup;
}


/** Debug helper: returns the full picture of what Graph sees for an email.
 *  Exposed via /api/refi/access?debug=1 — only to static-allowlist users. */
export async function debugGroupCheck(email: string): Promise<{
  email: string;
  group_id: string | null;
  group_source: "env_id" | "env_mail_resolved" | "none";
  app_token_obtained: boolean;
  check_member_groups_inGroup: boolean | null;
  check_member_groups_http?: number | string;
  members_fetched: boolean;
  members_count: number;
  members_sample: string[];
  email_in_members: boolean;
  final_inGroup: boolean;
}> {
  const userKey = email.toLowerCase().trim();
  const result: Awaited<ReturnType<typeof debugGroupCheck>> = {
    email: userKey,
    group_id: null,
    group_source: "none",
    app_token_obtained: false,
    check_member_groups_inGroup: null,
    members_fetched: false,
    members_count: 0,
    members_sample: [],
    email_in_members: false,
    final_inGroup: false,
  };

  if (process.env.REFI_FINDER_GROUP_ID) {
    result.group_id = process.env.REFI_FINDER_GROUP_ID;
    result.group_source = "env_id";
  } else if (process.env.REFI_FINDER_GROUP_MAIL) {
    result.group_id = await resolveGroupIdByMail(process.env.REFI_FINDER_GROUP_MAIL);
    result.group_source = "env_mail_resolved";
  }
  if (!result.group_id) return result;

  const token = await getAppToken();
  result.app_token_obtained = token != null;
  if (!token) return result;

  // checkMemberGroups path
  try {
    const res = await fetch(
      `${GRAPH}/users/${encodeURIComponent(userKey)}/checkMemberGroups`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ groupIds: [result.group_id] }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    result.check_member_groups_http = res.status;
    if (res.ok) {
      const data = (await res.json()) as { value?: string[] };
      result.check_member_groups_inGroup =
        Array.isArray(data.value) && data.value.includes(result.group_id);
    }
  } catch (err) {
    result.check_member_groups_http = String(err);
  }

  // member-list path
  const members = await fetchGroupMemberEmails(result.group_id);
  result.members_fetched = members != null;
  if (members) {
    result.members_count = members.size;
    result.members_sample = Array.from(members).slice(0, 5);
    result.email_in_members = members.has(userKey);
  }

  result.final_inGroup =
    !!result.check_member_groups_inGroup || result.email_in_members;
  return result;
}
