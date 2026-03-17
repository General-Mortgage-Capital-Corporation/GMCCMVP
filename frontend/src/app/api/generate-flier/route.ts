import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const CLOUD_FUNCTIONS_BASE = "https://us-central1-gmcc-66e1e.cloudfunctions.net";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body?.productId || !body?.userId) {
    return NextResponse.json({ error: "productId and userId are required." }, { status: 400 });
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
  } = body as Record<string, string | undefined>;

  const payload = {
    productId,
    data: {
      loanOfficer: {
        userId,
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
    const res = await fetch(`${CLOUD_FUNCTIONS_BASE}/fillPdfFlier`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Flier generation failed." })) as { error?: string; detail?: string };
      return NextResponse.json(
        { error: err.error ?? "Flier generation failed.", detail: err.detail },
        { status: res.status },
      );
    }

    const pdfBytes = await res.arrayBuffer();
    return new Response(pdfBytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${productId}-flier.pdf"`,
      },
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("timeout")) {
      return NextResponse.json({ error: "Flier generation timed out." }, { status: 504 });
    }
    return NextResponse.json({ error: "Flier generation failed." }, { status: 500 });
  }
}
