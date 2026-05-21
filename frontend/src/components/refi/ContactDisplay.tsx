"use client";

import type { UnlockedContact, UnlockedPerson } from "./RefiUnlockModal";

// Strip non-dialable chars for the tel: link target (PR formats as
// "501-258-5697"; tel: needs "+15012585697" or just digits).
function telHref(phone: string): string {
  const digits = phone.replace(/[^0-9+]/g, "");
  return `tel:${digits.length === 10 ? "+1" + digits : digits}`;
}

function ownerLabel(p: UnlockedPerson): string {
  return p.name?.trim() || "(owner)";
}

/**
 * Compact, table-friendly display.
 * Each person gets a small name header followed by phones and emails on
 * separate lines. Click-to-call (tel:) and click-to-email (mailto:) where
 * relevant. Empty persons (no phone, no email) are skipped.
 */
export function ContactCell({ contact }: { contact: UnlockedContact | undefined }) {
  // Not fetched yet
  if (!contact) {
    return <span className="text-[11px] text-gray-400">select &amp; click Fetch</span>;
  }

  // Prefer structured per-person data when available
  const persons = (contact.persons ?? []).filter(
    (p) => (p.phones?.length ?? 0) > 0 || (p.emails?.length ?? 0) > 0,
  );

  if (persons.length === 0) {
    // Fetched, but PR returned no contact data for any owner
    const tip = `${contact.phone_error ?? ""}${contact.phone_error && contact.email_error ? " · " : ""}${contact.email_error ?? ""}`.trim();
    return (
      <div className="text-[11px] text-amber-700" title={tip || "PR returned no contact for this property"}>
        no contact on file
      </div>
    );
  }

  return (
    <div className="space-y-1.5 text-xs">
      {persons.map((p, pi) => (
        <div key={p.person_key ?? pi} className={pi > 0 ? "border-t border-gray-100 pt-1.5" : ""}>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
            {ownerLabel(p)}
            {p.role && <span className="ml-1 font-normal normal-case text-gray-400">· {p.role}</span>}
          </div>
          {p.phones?.length > 0 && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-gray-900">
              <span aria-hidden className="text-gray-400">📞</span>
              {p.phones.map((ph, i) => (
                <span key={ph}>
                  {i > 0 && <span className="text-gray-300">·</span>}{" "}
                  <a href={telHref(ph)} className="font-medium hover:text-red-600 hover:underline">{ph}</a>
                </span>
              ))}
            </div>
          )}
          {p.emails?.length > 0 && (
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1 text-gray-700">
              <span aria-hidden className="text-gray-400">✉</span>
              {p.emails.map((em) => (
                <a key={em} href={`mailto:${em}`} className="break-all hover:text-red-600 hover:underline">
                  {em}
                </a>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Fuller display for the property detail modal — same structure as
 * ContactCell but with more breathing room and one-line-per-item layout.
 */
export function ContactSection({ contact }: { contact: UnlockedContact | undefined }) {
  if (!contact) {
    return <div className="text-sm text-gray-500">Fetch contacts from the table to populate.</div>;
  }
  const persons = (contact.persons ?? []).filter(
    (p) => (p.phones?.length ?? 0) > 0 || (p.emails?.length ?? 0) > 0,
  );
  if (persons.length === 0) {
    return <div className="text-sm text-amber-700">PR returned no contact for any owner on this property.</div>;
  }
  return (
    <div className="space-y-3">
      {persons.map((p, pi) => (
        <div key={p.person_key ?? pi} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
          <div className="text-sm font-semibold text-gray-900">
            {ownerLabel(p)}
            {p.role && <span className="ml-2 text-xs font-normal text-gray-500">{p.role}</span>}
            {p.is_primary && <span className="ml-2 rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700">Primary</span>}
          </div>
          {p.phones?.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 text-sm">
              {p.phones.map((ph) => (
                <li key={ph} className="flex items-baseline gap-2 text-gray-800">
                  <span aria-hidden className="text-gray-400">📞</span>
                  <a href={telHref(ph)} className="font-medium hover:text-red-600 hover:underline tabular-nums">{ph}</a>
                </li>
              ))}
            </ul>
          )}
          {p.emails?.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-sm">
              {p.emails.map((em) => (
                <li key={em} className="flex items-baseline gap-2 text-gray-700">
                  <span aria-hidden className="text-gray-400">✉</span>
                  <a href={`mailto:${em}`} className="break-all hover:text-red-600 hover:underline">{em}</a>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
