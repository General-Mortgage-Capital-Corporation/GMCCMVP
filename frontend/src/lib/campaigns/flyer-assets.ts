/**
 * Campaign flyer PDFs live in Firebase Storage, not Firestore.
 *
 * They used to be stored as base64 in `agentCampaignAssets` documents, which
 * capped them at ~700 KB — every real flyer (1.8–3.9 MB) failed that check,
 * so no campaign email ever carried an attachment while the drafts kept
 * promising one. Storage has no such limit; the same service account that
 * runs Firestore writes here.
 */
import "server-only";

import { getStorage } from "firebase-admin/storage";
import { getAdminApp } from "@/lib/firestore-admin";

const BUCKET = process.env.FIREBASE_STORAGE_BUCKET || "gmcc-66e1e.firebasestorage.app";
const PREFIX = "agent-campaign-flyers";

function bucket() {
  const app = getAdminApp();
  if (!app) throw new Error("Firebase Admin not configured");
  return getStorage(app).bucket(BUCKET);
}

export function campaignFlyerPath(campaignId: string, productId: string): string {
  return `${PREFIX}/${campaignId}/${productId}.pdf`;
}

/** Store one program flyer for a campaign; returns its storage path. */
export async function saveCampaignFlyer(campaignId: string, productId: string, base64: string): Promise<string> {
  const path = campaignFlyerPath(campaignId, productId);
  await bucket().file(path).save(Buffer.from(base64, "base64"), {
    contentType: "application/pdf",
    resumable: false,
    metadata: { metadata: { campaignId, productId } },
  });
  return path;
}

/** The flyer as base64, or null when it is gone (campaign finished, bucket issue). */
export async function readCampaignFlyer(path: string): Promise<string | null> {
  try {
    const [buf] = await bucket().file(path).download();
    return buf.length > 1000 ? buf.toString("base64") : null;
  } catch {
    return null;
  }
}

export async function deleteCampaignFlyers(campaignId: string): Promise<void> {
  try {
    await bucket().deleteFiles({ prefix: `${PREFIX}/${campaignId}/` });
  } catch {
    /* best-effort cleanup */
  }
}
