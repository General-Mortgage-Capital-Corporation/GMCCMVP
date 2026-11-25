"use client";

/**
 * Preview one Today card's email exactly as Send would post it (the server
 * builds the same message with the same code, flyer included, and sends
 * nothing), and pick this email's flyer option — shown in the body,
 * attached as a PDF, linked or none. The choice is saved on the card, and
 * Send uses it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import EmailPreviewModal from "@/components/email/EmailPreviewModal";
import { mentionsAttachment } from "@/lib/email/attachment-policy";
import { DESK_FLYER_OPTIONS, deskApi, type DeskDay, type DeskFlyerMode, type DeskItem, type DeskPreview as Preview } from "./api";

export default function DeskPreview({
  item,
  settingsFlyerMode,
  sending,
  onDay,
  onSend,
  onClose,
}: {
  item: DeskItem;
  settingsFlyerMode: DeskFlyerMode;
  sending: boolean;
  onDay: (day: DeskDay) => void;
  onSend: () => Promise<void>;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const n = ++seq.current;
    setPreview(null);
    setError(null);
    try {
      const r = await deskApi.preview(item.id);
      if (n === seq.current) setPreview(r.preview);
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : "Couldn't build the preview.");
    }
  }, [item.id]);

  // Rebuild whenever the card changes (flyer option, edits, program switch).
  useEffect(() => {
    load();
  }, [load, item.flyerMode, item.subject, item.body, item.program]);

  const current = item.flyerMode ?? settingsFlyerMode;
  const choose = async (mode: DeskFlyerMode) => {
    if (mode === current || saving) return;
    setSaving(true);
    setError(null);
    try {
      // Matching the setting clears the override, so later setting changes apply.
      const r = await deskApi.flyer(item.id, mode === settingsFlyerMode ? null : mode);
      onDay(r.day);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change the flyer option.");
    } finally {
      setSaving(false);
    }
  };

  const delivered = preview?.delivery;
  const notes = preview
    ? [
        !item.productId
          ? "This program has no flyer, so none is included."
          : delivered === "embedded"
            ? "The flyer is shown in the email (tap it to open the PDF)."
            : delivered === "attached"
              ? "The flyer is attached as a PDF."
              : delivered === "linked"
                ? "The flyer is linked at the end of the message."
                : "No flyer is included.",
        ...(preview.message.ccRecipients?.length ? ["You're CC'd (Today settings)."] : []),
      ]
    : [];
  const warnings = preview
    ? [
        ...preview.warnings,
        ...(item.productId && mentionsAttachment(item.body) && delivered !== "attached"
          ? ["The message says “attached”, but the flyer isn't attached — edit the wording or pick “Attach PDF”."]
          : []),
      ]
    : [];

  return (
    <EmailPreviewModal
      message={preview?.message ?? null}
      from={preview?.from}
      loading={!preview}
      error={error}
      notes={notes}
      warnings={warnings}
      onClose={onClose}
      onSend={item.status === "ready" ? () => void onSend() : undefined}
      sending={sending}
      sendLabel="Send this email"
      controls={
        item.productId ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-xs font-medium uppercase tracking-wide text-gray-500">Flyer for this email</span>
            <div className="inline-flex flex-wrap gap-1 rounded-xl bg-gray-100/80 p-1" role="radiogroup" aria-label="Flyer for this email">
              {DESK_FLYER_OPTIONS.map((o) => {
                const on = o.key === current;
                return (
                  <button
                    key={o.key}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={saving || sending || item.status !== "ready"}
                    onClick={() => choose(o.key)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-default ${on ? "bg-white text-gray-900 shadow-sm ring-1 ring-gray-200/70" : "text-gray-500 enabled:hover:text-gray-700"}`}
                  >
                    {o.label}
                    {o.key === settingsFlyerMode && <span className="ml-1 font-normal text-gray-400">· default</span>}
                  </button>
                );
              })}
            </div>
            {saving && <span className="text-xs text-gray-400">Saving…</span>}
          </div>
        ) : null
      }
    />
  );
}
