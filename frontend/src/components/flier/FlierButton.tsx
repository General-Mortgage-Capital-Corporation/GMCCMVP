"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import LoadingSpinner from "@/components/LoadingSpinner";
import EmailModal from "./EmailModal";

const GMCC_PPT_FOLDER = "https://netorgft1191593.sharepoint.com/sites/LOTraining/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FLOTraining%2FShared%20Documents%2FGMCC%20PPT&viewid=591beb65%2D297e%2D416f%2D8cd2%2Dd6f131d2897a&csf=1&ovuser=9f605dae%2Dab54%2D4576%2D8337%2De008c4b7b2ce%2Cnaitik%2Epoddar%40gmccloan%2Ecom&OR=Teams%2DHL&CT=1773678041332&clickparams=eyJBcHBOYW1lIjoiVGVhbXMtRGVza3RvcCIsIkFwcFZlcnNpb24iOiIxNDE1LzI2MDIxMjE1MTIzIiwiSGFzRmVkZXJhdGVkVXNlciI6ZmFsc2V9&CID=ff9900a2%2D1013%2D0000%2D6083%2De298ce971416&cidOR=SPO&FolderCTID=0x012000CF752C56A7846845A87DA40CB38AE1E9&pageCorrelationId=c7a900a2%2D0046%2D0000%2D6083%2Dee003eccde92&timeStamp=1773698366725";

export const PROGRAM_CONFIG: Record<string, { productId?: string; guidelineUrl?: string; ratesheetUrl?: string }> = {
  // ── Hot Programs ──────────────────────────────────────────────────────────
  "GMCC Buy Without Sell First": { productId: "buy-without-sell-first", guidelineUrl:"https://netorgft1191593.sharepoint.com/:p:/r/sites/LOTraining/_layouts/15/Doc.aspx?sourcedoc=%7B06767681-9543-4612-B0CD-3E2C573C583C%7D&file=Essential%20-%20Buy%20without%20sale%20v2%206-25-2025.pptx&action=edit&mobileredirect=true" },
  "GMCC Universe":             { productId: "universe", guidelineUrl:"https://netorgft1191593.sharepoint.com/:p:/r/sites/LOTraining/_layouts/15/Doc.aspx?sourcedoc=%7B41BF6587-EF43-4F49-B355-9239FCD03F6E%7D&file=Essential%20-%20GMCC%20Universe%20Home%20Outreach%20Program%20(CRA)%206-14-2024.pptx&action=edit&mobileredirect=true", ratesheetUrl: "https://netorgft1191593.sharepoint.com/:b:/r/sites/LOTraining/Shared%20Documents/Self-Service%20Fast-Closing/GMCC%20Universe%20Closing%20Resources/GMCC%20Universe%20Rate%20Sheet.pdf?csf=1&web=1&e=6MxTLq" },
  "GMCC Massive":              { productId: "massive", guidelineUrl:"https://netorgft1191593.sharepoint.com/:p:/r/sites/LOTraining/_layouts/15/Doc.aspx?sourcedoc=%7B69FD90A8-BA34-4567-9C72-672A2EC19394%7D&file=GMCC%20Massive%20-%20NON%20Qm.pptx&action=edit&mobileredirect=true" },
  "GMCC Diamond Express":      { productId: "diamond-express", guidelineUrl: "https://netorgft1191593.sharepoint.com/:p:/r/sites/LOTraining/Shared%20Documents/GMCC%20PPT/Essential%20-%20GMCC%20Diamond%20-%20Jumbo%20AUS%20.pptx?d=w390ee9388a094613a6bfbd6e8983d2e9&csf=1&web=1&e=JpDwhW" },
  "GMCC DSCR Rental Flow":     { productId: "dscr", guidelineUrl: GMCC_PPT_FOLDER },
  "GMCC Ocean":                { productId: "ocean", guidelineUrl:"https://netorgft1191593.sharepoint.com/:p:/r/sites/LOTraining/Shared%20Documents/GMCC%20PPT/Essential%20-%20GMCC%20Ocean%2002-06-2026%20v4.pptx?d=w1c903e89e42b47518d6a8329783a3ece&csf=1&web=1&e=zhf5fT", ratesheetUrl: "https://netorgft1191593.sharepoint.com/:b:/r/sites/LOTraining/Shared%20Documents/GMCC%20Ocean%20Rate%20Sheet%202.3.2026.pdf?csf=1&web=1&e=pU18Bj" },
  "GMCC Hermes":               { productId: "hermes", guidelineUrl:"https://netorgft1191593.sharepoint.com/:p:/r/sites/LOTraining/Shared%20Documents/GMCC%20PPT/Essential%20-%20GMCC%20Hermes%20v11%2012-23-2025.pptx?d=wd8d8b9e042984d99a5cbbc7c9f95ea33&csf=1&web=1&e=Owz3q1" },
  "GMCC Radiant":              { productId: "radiant", guidelineUrl:"https://netorgft1191593.sharepoint.com/:p:/r/sites/LOTraining/Shared%20Documents/GMCC%20PPT/Essential%20-%20GMCC%20Radiant%20AU%20Program%2012-26-2025.pptx?d=wc61f3d43cbd349f789ef9641cde9eb22&csf=1&web=1&e=hykKqt", ratesheetUrl: "https://netorgft1191593.sharepoint.com/:b:/r/sites/LOTraining/Shared%20Documents/GMCC%20Portfolio%20Ratesheet/GMCC%20Special%20Programs/Non-QM/GMCC%20Radiant%20Rate%20Sheet%202.10.2026.pdf?csf=1&web=1&e=Xe0GOy" },
  "GMCC WVOE P&L":             { guidelineUrl: GMCC_PPT_FOLDER },
  "GMCC Bank Statement Self Employed": { productId: "bank-statement", guidelineUrl: GMCC_PPT_FOLDER },
  "GMCC Fabulous Jumbo":       { productId: "fabulous-program", guidelineUrl:"https://netorgft1191593.sharepoint.com/:p:/r/sites/LOTraining/Shared%20Documents/GMCC%20PPT/Essential%20-%20Fabulous%20-%20AUS%20jumbo.pptx?d=wbd3caa7c5f294a2695e36a1555480b9b&csf=1&web=1&e=WF6PIU" },

  // ── Community Lending Programs (CRA) ──────────────────────────────────────
  "GMCC CRA: Celebrity $10K Grant":              { productId: "celebrity-10k", guidelineUrl: "https://netorgft1191593.sharepoint.com/:p:/r/sites/LOTraining/Shared%20Documents/GMCC%20PPT/Celebrity%2010K%20Grant%20(FHA%20only)-%20CA%20MA,%20GA,%20NC,%20SC%20%20v7%205-29-2025.pptx?d=w4721a487aad64e749e884ee57a4ce086&csf=1&web=1&e=YyakVa" },
  "GMCC CRA: Celebrity Community Opportunity":   { guidelineUrl:"https://netorgft1191593.sharepoint.com/:p:/r/sites/LOTraining/Shared%20Documents/GMCC%20PPT/GMCC%20Celebrity%20-%20Community%20program.pptx?d=wa3ccdd5bb1b348088858ee48b5faa8ce&csf=1&web=1&e=mc3fue" },
  "GMCC CRA: Celebrity Forgivable $10K DPA 2nd": { productId: "forgivable-15k", guidelineUrl:"https://netorgft1191593.sharepoint.com/:p:/r/sites/LOTraining/Shared%20Documents/GMCC%20PPT/Celebrity%20Forgivable%20loan.pptx?d=w285e6457f8de42059865678d47c1b6a7&csf=1&web=1&e=omhTuc" },
  "GMCC CRA: Cronus Grand Slam":                 { productId: "grandslam", guidelineUrl:"https://netorgft1191593.sharepoint.com/:b:/r/sites/LOTraining/Shared%20Documents/GMCC%20PPT/Cronus%20Jumbo%20CRA%201.2.24.pdf?csf=1&web=1&e=iRQFYD" },
  "GMCC CRA: Cronus Special Conforming":         { productId: "conforming-special", guidelineUrl:"https://netorgft1191593.sharepoint.com/:p:/r/sites/LOTraining/Shared%20Documents/GMCC%20PPT/Essential%20-%20GMCC%20Cronus%20SPCP,%20Home%20Run,%20CRA%208-8-2024.pptx?d=w719601fc686a4c14bfdbf08dc226ef0c&csf=1&web=1&e=bWeW06" },
  "GMCC CRA: Cronus Jumbo CRA":                  { productId: "jumbo-cra", guidelineUrl:"https://netorgft1191593.sharepoint.com/:b:/r/sites/LOTraining/Shared%20Documents/GMCC%20PPT/Cronus%20Jumbo%20CRA%201.2.24.pdf?csf=1&web=1&e=iRQFYD" },
  "GMCC CRA: Diamond CRA":                       { productId: "diamond-community-lending", guidelineUrl:"https://netorgft1191593.sharepoint.com/:p:/r/sites/LOTraining/Shared%20Documents/GMCC%20PPT/Essential%20-%20GMCC%20CRA%20programs.pptx?d=w8ff4ac9ad1cc4de08b6c4262a0a60302&csf=1&web=1&e=ZN2Si0" },
  "GMCC Celebrity Jumbo":      { productId: "celebrity-jumbo", guidelineUrl:"https://netorgft1191593.sharepoint.com/:p:/r/sites/LOTraining/Shared%20Documents/GMCC%20PPT/Essential%20-%20GMCC%20Celebrity%20Jumbo%20with%20Asset%20Depletion%20Updated%20on%2007-07-2024%20(1).pptx?d=wb9ce8eb4c48e4179a06c304cb549bb3a&csf=1&web=1&e=4pRUIh" },
};

/** Returns true if this program has a flyer that can be generated. */
export function programHasFlyer(name: string): boolean {
  return !!PROGRAM_CONFIG[name]?.productId;
}

/** Preferred display order for highlighted (hot) programs. Lower index = shown first. */
const HIGHLIGHTED_ORDER: string[] = [
  "GMCC Buy Without Sell First",
  "GMCC Universe",
  "GMCC Massive",
  "GMCC Diamond Express",
  "GMCC DSCR Rental Flow",
  "GMCC Ocean",
  "GMCC Hermes",
  "GMCC Radiant",
  "GMCC WVOE P&L",
  "GMCC Bank Statement Self Employed",
  "GMCC Fabulous Jumbo",
];

/** Sort programs by preferred display order. Programs not in the order list appear after those that are. */
export function sortByHighlightOrder<T extends { program_name: string }>(programs: T[]): T[] {
  return [...programs].sort((a, b) => {
    const ai = HIGHLIGHTED_ORDER.indexOf(a.program_name);
    const bi = HIGHLIGHTED_ORDER.indexOf(b.program_name);
    const aIdx = ai === -1 ? HIGHLIGHTED_ORDER.length : ai;
    const bIdx = bi === -1 ? HIGHLIGHTED_ORDER.length : bi;
    return aIdx - bIdx;
  });
}

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
  propertyImage?: string;
}

export default function FlierButton({
  programName,
  propertyAddress,
  listingPrice,
  realtorInfo,
  propertyImage,
}: FlierButtonProps) {
  const { user, signIn, getIdToken } = useAuth();
  const [loadingAction, setLoadingAction] = useState<"preview" | "download" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);

  // Revoke blob URL on unmount to avoid memory leaks
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const config = PROGRAM_CONFIG[programName];
  if (!config) return null;
  const { productId, guidelineUrl, ratesheetUrl } = config;

  async function fetchPdf(): Promise<Blob | null> {
    setError(null);
    try {
      let email = user?.email;
      let idToken: string | null = null;
      if (!email) {
        // Just signed in — use the returned user's token directly
        // (getIdToken closure still has stale user=null at this point)
        const freshUser = await signIn();
        email = freshUser.email;
        idToken = freshUser.idToken;
      } else {
        idToken = await getIdToken();
      }
      if (!idToken) {
        setError("Session expired. Please sign in again.");
        return null;
      }

      const body: Record<string, string | undefined> = {
        productId,
        userId: email,
        ...(propertyAddress ? { address: propertyAddress } : {}),
        ...(listingPrice ? { listingPrice: String(listingPrice) } : {}),
        ...(realtorInfo.name ? { realtorName: realtorInfo.name } : {}),
        ...(realtorInfo.phone ? { realtorPhone: realtorInfo.phone } : {}),
        ...(realtorInfo.email ? { realtorEmail: realtorInfo.email } : {}),
        ...(realtorInfo.nmls ? { realtorNmls: realtorInfo.nmls } : {}),
        ...(realtorInfo.company ? { realtorCompany: realtorInfo.company } : {}),
        ...(propertyImage ? { propertyImage } : {}),
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
        const err = (await res.json().catch(() => ({ error: "Flyer generation failed." }))) as {
          error?: string;
          detail?: string;
        };
        setError(err.detail ?? err.error ?? "Flyer generation failed.");
        return null;
      }

      return await res.blob();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Flyer generation failed.");
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
      a.download = `${productId}-flyer.pdf`;
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
        {productId && (
          <>
            <button
              onClick={handlePreview}
              disabled={!!loadingAction}
              className={`${btnBase} bg-red-50 text-red-700 hover:bg-red-100`}
              title="Preview flyer"
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
              title="Download flyer"
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
              title="Email flyer"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                <rect x="1" y="3" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
                <path d="M1 5l7 5 7-5" stroke="currentColor" strokeWidth="1.5" />
              </svg>
              Email
            </button>
          </>
        )}

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

        {ratesheetUrl && (
          <button
            onClick={() => window.open(ratesheetUrl, "_blank", "noopener,noreferrer")}
            className={`${btnBase} bg-blue-50 text-blue-700 hover:bg-blue-100`}
            title="View rate sheet"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
              <path
                d="M2 2h8l4 4v8H2V2z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
              <path
                d="M10 2v4h4M5 9h6M5 12h4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            Rates
          </button>
        )}

        {error && <span className="ml-1 text-xs text-red-600">{error}</span>}
      </div>

      {/* Email Modal */}
      {productId && emailOpen && (
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
                {programName} — Flyer Preview
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
            <iframe src={previewUrl} className="w-full flex-1" title="Flyer Preview" />
          </div>
        </div>
      )}
    </>
  );
}
