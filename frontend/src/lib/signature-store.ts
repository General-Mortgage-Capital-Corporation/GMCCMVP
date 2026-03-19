/**
 * Email signature persistence using localStorage.
 *
 * Stores rich HTML content that can include inline images, links,
 * bold/italic formatting — whatever the user pastes from Outlook/Gmail/Word.
 */

const STORAGE_KEY = "gmcc_email_signature";

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

export function hasSignature(): boolean {
  return getSignatureHtml().trim().length > 0;
}

/**
 * Wraps a plain-text email body + HTML signature into a complete HTML email body
 * suitable for Microsoft Graph API (contentType: "HTML").
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
</div>`;
}
