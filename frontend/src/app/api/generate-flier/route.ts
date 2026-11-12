import { type NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { getPartnerContext, mintIdTokenForEmail } from "@/lib/partner-server";
import { renderFlyerImage } from "@/lib/email/flyer-image";
import { attachableFlyerPdf } from "@/lib/email/flyer-pdf-compact";
import { fetchWithRetry } from "@/lib/email/retry-flyer-fetch";

export const runtime = "nodejs";

const CLOUD_FUNCTIONS_BASE = "https://us-central1-gmcc-66e1e.cloudfunctions.net";

export async function POST(req: NextRequest) {
  let authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body?.productId || !body?.userId) {
    return NextResponse.json({ error: "productId and userId are required." }, { status: 400 });
  }

  // Partner sessions can't satisfy fillPdfFlier's userId-must-match-token
  // check (the flyer carries the OWNING LO's panel, not theirs). Verify the
  // partner's own token, pin userId to their LO, and swap in a server-minted
  // LO token for the Cloud Function call. LO callers pass through untouched —
  // fillPdfFlier remains their authorization boundary.
  const caller = await requireAuth(req, { allowPartner: true });
  if (!caller) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  if (caller.role === "partner") {
    const ctx = await getPartnerContext(caller.mloEmail!, caller.partnerId);
    if (!ctx) {
      return NextResponse.json(
        { error: "Your partner access is no longer active." },
        { status: 403 },
      );
    }
    body.userId = ctx.mlo.email;
    try {
      authHeader = `Bearer ${await mintIdTokenForEmail(ctx.mlo.email)}`;
    } catch (err) {
      console.error("[generate-flier] LO token mint failed for partner call:", err);
      return NextResponse.json({ error: "Flier generation failed." }, { status: 500 });
    }
  }

  const {
    productId,
    userId,
    address,
    listingPrice,
    propertyImage,
    realtorName,
    realtorPhone,
    realtorEmail,
    realtorNmls,
    realtorCompany,
    branch,
    slogan,
    title,
  } = body as Record<string, string | undefined>;

  const payload = {
    productId,
    data: {
      loanOfficer: {
        userId,
        ...(title ? { title } : {}),
        ...(branch ? { branch } : {}),
        ...(slogan ? { slogan } : {}),
      },
      ...(address || listingPrice || propertyImage
        ? {
            property: {
              ...(address ? { address } : {}),
              ...(listingPrice ? { listingPrice: String(listingPrice) } : {}),
              ...(propertyImage ? { photo: propertyImage } : {}),
            },
          }
        : {}),
      ...(realtorName || realtorPhone || realtorEmail || realtorNmls || realtorCompany
        ? {
            realtor: {
              ...(realtorName ? { name: realtorName } : {}),
              ...(realtorPhone ? { phoneNumber: realtorPhone } : {}),
              ...(realtorEmail ? { email: realtorEmail } : {}),
              ...(realtorNmls ? { nmls: realtorNmls } : {}),
              ...(realtorCompany ? { company: realtorCompany } : {}),
            },
          }
        : {}),
    },
    previewMode: false,
  };

  try {
    const res = await fetchWithRetry(() =>
      fetch(`${CLOUD_FUNCTIONS_BASE}/fillPdfFlier`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      }),
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Flier generation failed." })) as { error?: string; detail?: string };
      return NextResponse.json(
        { error: err.error ?? "Flier generation failed.", detail: err.detail },
        { status: res.status },
      );
    }

    const pdfBytes = await res.arrayBuffer();
    const safeProductId = (productId ?? "flyer").replace(/[^a-zA-Z0-9-]/g, "");
    // format: "jpeg" = page 1 as an image, for embedding in an email body.
    if (body.format === "jpeg") {
      const image = await renderFlyerImage(new Uint8Array(pdfBytes));
      return new Response(Buffer.from(image.base64, "base64"), {
        headers: {
          "Content-Type": "image/jpeg",
          "Content-Disposition": `inline; filename="${safeProductId}-flyer.jpg"`,
        },
      });
    }
    // maxBytes = the PDF is going to be attached to an email: shrink it to fit
    // instead of the sender having to link it (X-Flyer-Compacted says so).
    const maxBytes = Number(body.maxBytes);
    let pdfOut: Uint8Array = new Uint8Array(pdfBytes);
    let compacted = false;
    if (Number.isFinite(maxBytes) && maxBytes > 0 && pdfOut.byteLength > maxBytes) {
      try {
        ({ pdf: pdfOut, compacted } = await attachableFlyerPdf(pdfOut, maxBytes));
      } catch (err) {
        console.error("[generate-flier] could not shrink the flyer:", productId, err);
      }
    }
    return new Response(Buffer.from(pdfOut), {
      headers: {
        ...(compacted ? { "X-Flyer-Compacted": "1" } : {}),
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${safeProductId}-flier.pdf"`,
      },
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("timeout")) {
      return NextResponse.json({ error: "Flier generation timed out." }, { status: 504 });
    }
    console.error("[generate-flier] failed:", productId, body.format ?? "pdf", err);
    return NextResponse.json({ error: "Flier generation failed." }, { status: 500 });
  }
}
