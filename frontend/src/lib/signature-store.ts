/**
 * Email signature persistence using localStorage.
 *
 * Two-part signature system:
 * 1. User-editable part: name, title, custom rich HTML content (images, links, etc.)
 * 2. Company block (non-editable): GMCC company info, NMLS, and compliance disclaimer.
 *
 * Both parts are always appended to outgoing emails.
 * Users cannot send emails until the editable part is saved.
 */

const STORAGE_KEY = "gmcc_email_signature";

// ---------------------------------------------------------------------------
// Company constants (non-editable)
// ---------------------------------------------------------------------------

export const COMPANY_NAME = "General Mortgage Capital Corporation";
export const COMPANY_NMLS = "254895";

export const COMPANY_DISCLAIMER = `${COMPANY_NAME} | NMLS #${COMPANY_NMLS} | CA DRE #01509029
1350 Bayshore Highway, Ste 740, Burlingame, CA 94010
Ph: 866-GMCC-WAY (866-462-2929) | info@gmccloan.com | www.gmccloan.com

All loan programs and rates are subject to underwriting approval and change without advance notice. Additional restrictions may apply. This does not represent a credit decision or commitment to lend. Rates are not guaranteed and are subject to change at any given time. Equal Housing Lender.

Disclosures & Licensing: https://www.gmccloan.com/Disclosures.html
NMLS Consumer Access: www.nmlsconsumeraccess.org`;

export const COMPANY_DISCLAIMER_HTML = `<div style="margin-top:16px;padding-top:12px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;line-height:1.5">
<p style="margin:0 0 4px;font-weight:600;color:#6b7280">${COMPANY_NAME} | NMLS #${COMPANY_NMLS} | CA DRE #01509029</p>
<p style="margin:0 0 4px">1350 Bayshore Highway, Ste 740, Burlingame, CA 94010<br>Ph: 866-GMCC-WAY (866-462-2929) | <a href="mailto:info@gmccloan.com" style="color:#6b7280">info@gmccloan.com</a> | <a href="https://www.gmccloan.com" style="color:#6b7280">www.gmccloan.com</a></p>
<p style="margin:8px 0 4px">All loan programs and rates are subject to underwriting approval and change without advance notice. Additional restrictions may apply. This does not represent a credit decision or commitment to lend. Rates are not guaranteed and are subject to change at any given time. Equal Housing Lender.</p>
<p style="margin:4px 0 0">Disclosures &amp; Licensing: <a href="https://www.gmccloan.com/Disclosures.html" style="color:#6b7280">gmccloan.com/Disclosures.html</a> | NMLS Consumer Access: <a href="https://www.nmlsconsumeraccess.org" style="color:#6b7280">nmlsconsumeraccess.org</a></p>
</div>`;

// ---------------------------------------------------------------------------
// User signature (editable part)
// ---------------------------------------------------------------------------

export function getSignatureHtml(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setSignatureHtml(html: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, html);
  } catch {
    // storage full or unavailable
  }
}

export function clearSignature(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // unavailable
  }
}

/** Whether the user has saved any editable signature content. */
export function hasSignature(): boolean {
  const html = getSignatureHtml();
  return !isSignatureContentEmpty(html) && !findSignaturePlaceholder(html);
}

// ---------------------------------------------------------------------------
// Signature content validation (pure — safe on both client and server)
// ---------------------------------------------------------------------------

/**
 * Returns the placeholder token found in the signature, or null if clean.
 * The signature editor prefills a preset that may contain "Your Name" or
 * "NMLS# _______" when the LO profile is incomplete — those must never go
 * out in a real email, so saves and sends both reject them.
 */
export function findSignaturePlaceholder(html: string): string | null {
  if (!html) return null;
  if (html.includes("Your Name")) return "Your Name";
  const underscores = html.match(/_{3,}/);
  if (underscores) return underscores[0];
  return null;
}

/** True when the HTML has no visible text and no image (e.g. "<div><br></div>"). */
export function isSignatureContentEmpty(html: string): boolean {
  if (!html) return true;
  if (/<img\b/i.test(html)) return false;
  return html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").trim().length === 0;
}

/**
 * Wraps a plain-text email body + user signature + company disclaimer
 * into a complete HTML email body for Microsoft Graph API.
 */
export function buildHtmlBodyWithSignature(
  plainBody: string,
  signatureHtml: string,
): string {
  // Convert plain text body to HTML paragraphs
  const bodyHtml = plainBody
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;color:#333">
${bodyHtml}
<br><br>
<div style="border-top:1px solid #ccc;padding-top:12px;margin-top:12px">
${signatureHtml}
</div>
${COMPANY_DISCLAIMER_HTML}
</div>`;
}
