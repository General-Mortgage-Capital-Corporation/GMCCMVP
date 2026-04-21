"use client";

import SignatureEditor from "./SignatureEditor";
import { COMPANY_NAME, COMPANY_NMLS, COMPANY_DISCLAIMER } from "@/lib/signature-store";

interface SignatureFixModalProps {
  onClose: () => void;
  /** Called when the user saves a signature — parent can refresh its hasSignature() check. */
  onSaved: () => void;
}

/**
 * Lightweight modal that overlays the SignatureEditor on top of the current UI
 * (e.g. an EmailModal) so the user can configure their signature without losing
 * progress on what they were doing.
 */
export default function SignatureFixModal({ onClose, onSaved }: SignatureFixModalProps) {
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-lg rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3.5">
          <span className="text-sm font-semibold text-gray-800">Set Up Email Signature</span>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Content — just the signature editor + compliance block */}
        <div className="max-h-[75vh] overflow-y-auto p-5">
          <SignatureEditor onSave={onSaved} />
        </div>
      </div>
    </div>
  );
}
