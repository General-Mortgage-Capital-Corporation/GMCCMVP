"use client";

import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import LoadingSpinner from "@/components/LoadingSpinner";
import EmailModal from "./EmailModal";

const PROGRAM_CONFIG: Record<string, { productId: string; guidelineUrl?: string }> = {
  "GMCC Jumbo CRA":          { productId: "jumbo-cra", guidelineUrl:"https://netorgft1191593.sharepoint.com/:b:/r/sites/LOTraining/Shared%20Documents/GMCC%20PPT/Cronus%20Jumbo%20CRA%201.2.24.pdf?csf=1&web=1&e=iRQFYD" },
  "GMCC Diamond":            { productId: "diamond-community-lending", guidelineUrl:"https://netorgft1191593.sharepoint.com/:p:/r/sites/LOTraining/Shared%20Documents/GMCC%20PPT/Essential%20-%20GMCC%20CRA%20programs.pptx?d=w8ff4ac9ad1cc4de08b6c4262a0a60302&csf=1&web=1&e=ZN2Si0" },
  "GMCC Fabulous Jumbo":     { productId: "fabulous", guidelineUrl:"https://netorgft1191593.sharepoint.com/:p:/r/sites/LOTraining/Shared%20Documents/GMCC%20PPT/Essential%20-%20Fabulous%20-%20AUS%20jumbo.pptx?d=wbd3caa7c5f294a2695e36a1555480b9b&csf=1&web=1&e=WF6PIU" },
  "GMCC Grandslam":          { productId: "grandslam", guidelineUrl:"https://netorgft1191593.sharepoint.com/:b:/r/sites/LOTraining/Shared%20Documents/GMCC%20PPT/Cronus%20Jumbo%20CRA%201.2.24.pdf?csf=1&web=1&e=iRQFYD" },
  "GMCC $10K Grant":         { productId: "celebrity-10k", guidelineUrl: "https://netorgft1191593.sharepoint.com/:p:/r/sites/LOTraining/Shared%20Documents/GMCC%20PPT/Celebrity%2010K%20Grant%20(FHA%20only)-%20CA%20MA,%20GA,%20NC,%20SC%20%20v7%205-29-2025.pptx?d=w4721a487aad64e749e884ee57a4ce086&csf=1&web=1&e=YyakVa" },
  "GMCC Special Conforming": { productId: "conforming-special", guidelineUrl:"https://netorgft1191593.sharepoint.com/:p:/r/sites/LOTraining/Shared%20Documents/GMCC%20PPT/Essential%20-%20GMCC%20Cronus%20SPCP,%20Home%20Run,%20CRA%208-8-2024.pptx?d=w719601fc686a4c14bfdbf08dc226ef0c&csf=1&web=1&e=bWeW06" },
};

export interface RealtorInfo {
  name: string;
  phone: string;
  email: string;
  nmls: string;
  company: string;
}

interface FlierButtonProps {
  programName: string;
  propertyAddress?: string;
  listingPrice?: number;
  realtorInfo: RealtorInfo;
}

export default function FlierButton({
  programName,
  propertyAddress,
  listingPrice,
  realtorInfo,
}: FlierButtonProps) {
  const { user, signIn, getIdToken } = useAuth();
  const [loadingAction, setLoadingAction] = useState<"preview" | "download" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);

  const config = PROGRAM_CONFIG[programName];
  if (!config) return null;
  const { productId, guidelineUrl } = config;

  async function fetchPdf(): Promise<Blob | null> {
    setError(null);
    try {
      if (!user) await signIn();
      const idToken = await getIdToken();
      if (!idToken) {
        setError("Session expired. Please sign in again.");
        return null;
      }

      const body: Record<string, string | undefined> = {
        productId,
        userId: user!.email,
        ...(propertyAddress ? { address: propertyAddress } : {}),
        ...(listingPrice ? { listingPrice: String(listingPrice) } : {}),
        ...(realtorInfo.name ? { realtorName: realtorInfo.name } : {}),
        ...(realtorInfo.phone ? { realtorPhone: realtorInfo.phone } : {}),
        ...(realtorInfo.email ? { realtorEmail: realtorInfo.email } : {}),
        ...(realtorInfo.nmls ? { realtorNmls: realtorInfo.nmls } : {}),
        ...(realtorInfo.company ? { realtorCompany: realtorInfo.company } : {}),
      };

      const res = await fetch("/api/generate-flier", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({ error: "Flier generation failed." }))) as {
          error?: string;
          detail?: string;
        };
        setError(err.detail ?? err.error ?? "Flier generation failed.");
        return null;
      }

      return await res.blob();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Flier generation failed.");
      return null;
    }
  }

  async function handlePreview() {
    setLoadingAction("preview");
    try {
      const blob = await fetchPdf();
      if (!blob) return;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleDownload() {
    setLoadingAction("download");
    try {
      const blob = await fetchPdf();
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${productId}-flier.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setLoadingAction(null);
    }
  }

  function closePreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
  }

  const btnBase =
    "inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors disabled:opacity-40";

  return (
    <>
      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={handlePreview}
          disabled={!!loadingAction}
          className={`${btnBase} bg-blue-50 text-blue-700 hover:bg-blue-100`}
          title="Preview flier"
        >
          {loadingAction === "preview" ? (
            <LoadingSpinner size="sm" />
          ) : (
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
              <path
                d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          )}
          Preview
        </button>

        <button
          onClick={handleDownload}
          disabled={!!loadingAction}
          className={`${btnBase} bg-violet-50 text-violet-700 hover:bg-violet-100`}
          title="Download flier"
        >
          {loadingAction === "download" ? (
            <LoadingSpinner size="sm" />
          ) : (
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
              <path
                d="M8 2v8M5 7l3 3 3-3M3 13h10"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
          Download
        </button>

        <button
          onClick={() => setEmailOpen(true)}
          disabled={!!loadingAction}
          className={`${btnBase} bg-emerald-50 text-emerald-700 hover:bg-emerald-100`}
          title="Email flier"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <rect x="1" y="3" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M1 5l7 5 7-5" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          Email
        </button>

        <button
          onClick={() => guidelineUrl && window.open(guidelineUrl, "_blank", "noopener,noreferrer")}
          disabled={!guidelineUrl}
          className={`${btnBase} ${guidelineUrl ? "bg-amber-50 text-amber-700 hover:bg-amber-100" : "cursor-not-allowed bg-gray-50 text-gray-400"}`}
          title={guidelineUrl ? "View program guideline" : "Guideline coming soon"}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <path
              d="M3 2h10v12H3V2z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
            <path
              d="M5 6h6M5 9h6M5 12h4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          Guideline
        </button>

        {error && <span className="ml-1 text-xs text-red-600">{error}</span>}
      </div>

      {/* Email Modal */}
      {emailOpen && (
        <EmailModal
          programName={programName}
          productId={productId}
          propertyAddress={propertyAddress}
          listingPrice={listingPrice}
          realtorInfo={realtorInfo}
          onClose={() => setEmailOpen(false)}
          fetchPdf={fetchPdf}
        />
      )}

      {/* PDF Preview Modal */}
      {previewUrl && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
          onClick={closePreview}
        >
          <div
            className="relative flex h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2.5">
              <span className="text-sm font-semibold text-gray-800">
                {programName} — Flier Preview
              </span>
              <div className="flex items-center gap-3">
                <button
                  onClick={handleDownload}
                  className="text-xs font-medium text-violet-700 hover:text-violet-900"
                >
                  Download
                </button>
                <button
                  onClick={closePreview}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M12 4L4 12M4 4l8 8"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            </div>
            <iframe src={previewUrl} className="w-full flex-1" title="Flier Preview" />
          </div>
        </div>
      )}
    </>
  );
}
