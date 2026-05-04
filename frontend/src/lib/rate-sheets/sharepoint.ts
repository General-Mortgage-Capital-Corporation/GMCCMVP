/**
 * Microsoft Graph helpers for the rate-sheet sync.
 *
 * Two operations:
 *   1. listSharedFolderChildren — given a SharePoint sharing URL like
 *      https://{tenant}.sharepoint.com/:f:/r/sites/X/Shared%20Documents/...,
 *      list every file in that folder via the /shares/{shareId}/driveItem
 *      endpoint. Skips subfolders (the rate-sheet folders are flat).
 *
 *   2. createOrgViewLink — for one driveItem, create a stable view-only
 *      sharing link scoped to the org. We persist the resulting URL so the
 *      LO sees the same kind of link that's hardcoded today.
 */

import { getAppToken } from "@/lib/graph-client";

export interface DriveItem {
  id: string;
  name: string;
  webUrl: string;
  /** Parent driveId; needed for createLink. */
  parentReference: { driveId: string };
  /** present on files, absent on folders */
  file?: { mimeType?: string };
  /** present on folders */
  folder?: { childCount?: number };
}

/**
 * Encode a SharePoint URL into the `u!{base64url}` shape Graph uses for the
 * /shares endpoint. See:
 * https://learn.microsoft.com/en-us/graph/api/shares-get
 */
export function encodeShareId(url: string): string {
  const b64 = Buffer.from(url, "utf8").toString("base64");
  // base64url: '+' → '-', '/' → '_', strip '='
  const b64url = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `u!${b64url}`;
}

/**
 * List every file (excluding subfolders) in a shared SharePoint folder.
 * Uses paging; stops once @odata.nextLink is exhausted.
 */
export async function listSharedFolderChildren(
  folderShareUrl: string,
): Promise<{ ok: boolean; items?: DriveItem[]; error?: string }> {
  const token = await getAppToken();
  if (!token) return { ok: false, error: "Graph application credentials not configured." };

  const shareId = encodeShareId(folderShareUrl);
  const select = "id,name,webUrl,parentReference,file,folder";

  const items: DriveItem[] = [];
  let url:
    | string
    | null = `https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem/children?$select=${select}&$top=200`;

  while (url) {
    const res: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      return {
        ok: false,
        error: err.error?.message ?? `Graph /shares/children returned ${res.status}`,
      };
    }
    const data = (await res.json()) as {
      value: DriveItem[];
      "@odata.nextLink"?: string;
    };
    for (const item of data.value) {
      // Skip subfolders. We only want files.
      if (item.folder) continue;
      items.push(item);
    }
    url = data["@odata.nextLink"] ?? null;
  }

  return { ok: true, items };
}

/**
 * Create a tenant-scoped view-only sharing link for a driveItem. This is the
 * stable URL we persist — it doesn't expire when the file is renamed (the
 * sharing token follows the item by ID).
 *
 * If createLink fails (e.g., permission denied), falls back to the item's
 * default `webUrl`.
 */
export async function createOrgViewLink(item: DriveItem): Promise<string> {
  const token = await getAppToken();
  if (!token) return item.webUrl;

  const driveId = item.parentReference.driveId;
  const itemId = item.id;
  if (!driveId || !itemId) return item.webUrl;

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/createLink`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "view", scope: "organization" }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) return item.webUrl;
  const data = (await res.json()) as { link?: { webUrl?: string } };
  return data.link?.webUrl ?? item.webUrl;
}
