"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatPrice } from "@/lib/utils";
import { getHeadshot } from "@/lib/headshot-store";
import { getLOInfo, setLOInfo, type LOInfo } from "@/lib/lo-info-store";
import { useAuth } from "@/contexts/AuthContext";
import type { RentCastListing, CensusData } from "@/types";
import type { RealtorInfo } from "@/components/flier/FlierButton";

// ---------------------------------------------------------------------------
// Default column configurations (easily editable here)
// ---------------------------------------------------------------------------

export interface LoanScenario {
  id: string;
  name: string;
  category: string; // group header (e.g., "Conventional", "Non-QM")
  loanAmount: number | null;
  downPayment: number | null;
  downPaymentPct: number | null;
  termMonths: number;
  interestRate: number | null;
  apr: number | null;
  points: number | null;
  closingCost: number | null;
  propertyTax: number | null;
  insurance: number | null;
  hoaFees: number | null;
  pmi: number | null;
  principalInterest: number | null; // auto-calculated
}

const DEFAULT_SCENARIOS: Omit<LoanScenario, "id" | "loanAmount" | "downPayment" | "downPaymentPct" | "principalInterest" | "hoaFees">[] = [
  { name: "30-Year Fixed", category: "Conventional", termMonths: 360, interestRate: null, apr: null, points: null, closingCost: null, propertyTax: null, insurance: null, pmi: null },
  { name: "15-Year Fixed", category: "Conventional", termMonths: 180, interestRate: null, apr: null, points: null, closingCost: null, propertyTax: null, insurance: null, pmi: null },
  { name: "FHA 30-Year", category: "Government", termMonths: 360, interestRate: null, apr: null, points: null, closingCost: null, propertyTax: null, insurance: null, pmi: null },
  { name: "Jumbo 7/6 ARM", category: "Jumbo", termMonths: 360, interestRate: null, apr: null, points: null, closingCost: null, propertyTax: null, insurance: null, pmi: null },
];

let _nextId = 1;
function genId() { return `col_${_nextId++}_${Date.now()}`; }

function createScenario(
  template: typeof DEFAULT_SCENARIOS[number],
  price: number,
  downPct: number = 20,
  hoaFee: number | null = null,
): LoanScenario {
  const dp = Math.round(price * downPct / 100);
  const la = price - dp;
  return {
    id: genId(),
    ...template,
    loanAmount: la,
    downPayment: dp,
    downPaymentPct: downPct,
    hoaFees: hoaFee,
    principalInterest: calcPI(la, template.interestRate, template.termMonths),
  };
}

// ---------------------------------------------------------------------------
// Mortgage math
// ---------------------------------------------------------------------------

function calcPI(loanAmount: number | null, annualRate: number | null, termMonths: number): number | null {
  if (!loanAmount || !annualRate || !termMonths || loanAmount <= 0 || annualRate <= 0) return null;
  const r = annualRate / 100 / 12;
  const n = termMonths;
  const payment = loanAmount * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
  return Math.round(payment);
}

function totalMonthly(s: LoanScenario): number | null {
  const pi = s.principalInterest;
  if (pi == null) return null;
  return pi + (s.propertyTax ?? 0) + (s.insurance ?? 0) + (s.hoaFees ?? 0) + (s.pmi ?? 0);
}

// ---------------------------------------------------------------------------
// Editable cell component
// ---------------------------------------------------------------------------

function EditableCell({
  value,
  onChange,
  format = "currency",
  placeholder = "—",
  className = "",
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  format?: "currency" | "percent" | "number" | "months";
  placeholder?: string;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  function startEdit() {
    setText(value != null ? String(value) : "");
    setEditing(true);
  }

  function commit() {
    setEditing(false);
    const num = parseFloat(text.replace(/[,$%]/g, ""));
    onChange(isNaN(num) ? null : num);
  }

  function displayValue(): string {
    if (value == null) return placeholder;
    if (format === "currency") return "$" + value.toLocaleString();
    if (format === "percent") return value.toFixed(3) + "%";
    if (format === "months") return String(value);
    return value.toLocaleString();
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        className={`w-full rounded border border-red-300 bg-white px-1.5 py-0.5 text-right text-xs focus:outline-none focus:ring-1 focus:ring-red-400 ${className}`}
      />
    );
  }

  return (
    <div
      onClick={startEdit}
      className={`cursor-pointer rounded px-1.5 py-0.5 text-right text-xs transition-colors hover:bg-red-50 ${className}`}
      title="Click to edit"
    >
      {displayValue()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editable text cell (for strings like column names)
// ---------------------------------------------------------------------------

function EditableText({
  value,
  onChange,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  function commit() {
    setEditing(false);
    if (text.trim()) onChange(text.trim());
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        className={`w-full rounded border border-red-300 bg-white px-1 py-0.5 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-red-400 ${className}`}
      />
    );
  }

  return (
    <div
      onClick={() => { setText(value); setEditing(true); }}
      className={`cursor-pointer rounded px-1 py-0.5 text-xs font-semibold transition-colors hover:bg-red-100 ${className}`}
      title="Click to rename"
    >
      {value}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row definitions
// ---------------------------------------------------------------------------

interface RowDef {
  key: string;
  label: string;
  field: keyof LoanScenario;
  format: "currency" | "percent" | "number" | "months";
  editable: boolean;
  isHeader?: boolean;
  isBold?: boolean;
  dependsOn?: string[]; // fields that trigger recalc when this changes
}

const TABLE_ROWS: RowDef[] = [
  { key: "loanAmount", label: "Loan Amount:", field: "loanAmount", format: "currency", editable: true },
  { key: "downPayment", label: "Down Payment:", field: "downPayment", format: "currency", editable: true },
  { key: "downPaymentPct", label: "Down Payment %:", field: "downPaymentPct", format: "percent", editable: true },
  { key: "termMonths", label: "Term (Months):", field: "termMonths", format: "months", editable: true },
  { key: "interestRate", label: "Interest Rate:", field: "interestRate", format: "percent", editable: true },
  { key: "apr", label: "APR:", field: "apr", format: "percent", editable: true },
  { key: "points", label: "Points:", field: "points", format: "number", editable: true },
  { key: "closingCost", label: "Closing Cost:", field: "closingCost", format: "currency", editable: true },
  // Monthly payment section
  { key: "monthlyHeader", label: "Total Monthly Payment:", field: "propertyTax", format: "currency", editable: false, isHeader: true },
  { key: "propertyTax", label: "  - Property Tax:", field: "propertyTax", format: "currency", editable: true },
  { key: "insurance", label: "  - Homeowners Insurance:", field: "insurance", format: "currency", editable: true },
  { key: "hoaFees", label: "  - HOA/Dues/Fees:", field: "hoaFees", format: "currency", editable: true },
  { key: "pmi", label: "  - PMI:", field: "pmi", format: "currency", editable: true },
  { key: "principalInterest", label: "  - Principal & Interest:", field: "principalInterest", format: "currency", editable: false, isBold: true },
];

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface BrokerInfo {
  name: string;
  company: string;
  phone: string;
  officePhone: string;
}

interface LoanComparisonFlyerProps {
  listing: RentCastListing | null;
  census: CensusData | null;
  realtorInfo: RealtorInfo;
  propertyImage?: string;
  zillowPhotos: string[];
}

export default function LoanComparisonFlyer({
  listing,
  census,
  realtorInfo,
  propertyImage,
  zillowPhotos,
}: LoanComparisonFlyerProps) {
  const price = listing?.price ?? 0;
  const flyerRef = useRef<HTMLDivElement>(null);
  const headshot = getHeadshot();
  const [exporting, setExporting] = useState(false);

  // LO info — auto-populate from auth on first use, then persist edits
  const { user } = useAuth();
  const [loInfo, setLoInfoState] = useState<LOInfo>(() => {
    const stored = getLOInfo();
    // If name is empty but we have auth data, seed from auth
    if (!stored.name && typeof window !== "undefined") {
      return stored; // will be updated in useEffect below
    }
    return stored;
  });

  // Auto-populate from auth user if LO fields are empty
  useEffect(() => {
    if (!user) return;
    setLoInfoState((prev) => {
      const next = { ...prev };
      let changed = false;
      if (!next.name && user.displayName) { next.name = user.displayName; changed = true; }
      if (!next.email && user.email) { next.email = user.email; changed = true; }
      if (changed) setLOInfo(next);
      return changed ? next : prev;
    });
  }, [user]);

  const updateLO = useCallback((field: keyof LOInfo, value: string) => {
    setLoInfoState((prev) => {
      const next = { ...prev, [field]: value };
      setLOInfo(next);
      return next;
    });
  }, []);

  // Broker info from listing (auto-populated if active listing)
  const agent = listing?.listingAgent;
  const office = listing?.listingOffice;
  const [brokers, setBrokers] = useState<BrokerInfo[]>([]);

  // Auto-populate brokers from listing data
  useEffect(() => {
    const initial: BrokerInfo[] = [];
    if (agent?.name) {
      initial.push({
        name: agent.name,
        company: office?.name ?? "",
        phone: agent.phone ?? "",
        officePhone: office?.phone ?? "",
      });
    }
    setBrokers(initial);
  }, [agent?.name, agent?.phone, office?.name, office?.phone]);

  // Drag-and-drop column reordering
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const addBroker = useCallback(() => {
    setBrokers((prev) => [...prev, { name: "", company: "", phone: "", officePhone: "" }]);
  }, []);

  const removeBroker = useCallback((idx: number) => {
    setBrokers((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const updateBroker = useCallback((idx: number, field: keyof BrokerInfo, value: string) => {
    setBrokers((prev) => prev.map((b, i) => i === idx ? { ...b, [field]: value } : b));
  }, []);

  // HOA fee from RentCast (if available)
  const hoaFee = listing?.hoa?.fee ?? null;
  // Property tax estimate: RentCast provides taxAssessedValue — estimate monthly tax
  // Using a rough 1.1% annual rate (national average), divided by 12
  const estimatedMonthlyTax = listing?.taxAssessedValue
    ? Math.round((listing.taxAssessedValue * 0.011) / 12)
    : null;

  // Initialize scenarios from defaults — auto-fill HOA and tax from RentCast if available
  const [scenarios, setScenarios] = useState<LoanScenario[]>(() =>
    DEFAULT_SCENARIOS.map((t) => {
      const s = createScenario(t, price || 500000, 20, hoaFee);
      if (estimatedMonthlyTax) s.propertyTax = estimatedMonthlyTax;
      return s;
    }),
  );

  // Recalculate when price changes
  useEffect(() => {
    if (!price) return;
    setScenarios((prev) =>
      prev.map((s) => {
        const dpPct = s.downPaymentPct ?? 20;
        const dp = Math.round(price * dpPct / 100);
        const la = price - dp;
        return {
          ...s,
          loanAmount: la,
          downPayment: dp,
          principalInterest: calcPI(la, s.interestRate, s.termMonths),
        };
      }),
    );
  }, [price]);

  // Update a scenario field with auto-recalculation
  const updateField = useCallback((id: string, field: keyof LoanScenario, value: number | null) => {
    setScenarios((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s;
        const updated = { ...s, [field]: value };

        // Auto-calculations
        if (field === "downPaymentPct" && value != null && price > 0) {
          updated.downPayment = Math.round(price * value / 100);
          updated.loanAmount = price - updated.downPayment;
        } else if (field === "downPayment" && value != null && price > 0) {
          updated.downPaymentPct = Math.round((value / price) * 10000) / 100;
          updated.loanAmount = price - value;
        } else if (field === "loanAmount" && value != null && price > 0) {
          updated.downPayment = price - value;
          updated.downPaymentPct = Math.round((updated.downPayment / price) * 10000) / 100;
        }

        // Recalculate P&I whenever loan amount, rate, or term changes
        if (["loanAmount", "downPayment", "downPaymentPct", "interestRate", "termMonths"].includes(field)) {
          updated.principalInterest = calcPI(updated.loanAmount, updated.interestRate, updated.termMonths);
        }

        return updated;
      }),
    );
  }, [price]);

  // Add a new column
  const addColumn = useCallback(() => {
    const template = DEFAULT_SCENARIOS[0];
    const s = createScenario(template, price || 500000, 20, hoaFee);
    if (estimatedMonthlyTax) s.propertyTax = estimatedMonthlyTax;
    setScenarios((prev) => [...prev, s]);
  }, [price, hoaFee, estimatedMonthlyTax]);

  // Remove a column
  const removeColumn = useCallback((id: string) => {
    setScenarios((prev) => prev.filter((s) => s.id !== id));
  }, []);

  // Rename a column
  const renameColumn = useCallback((id: string, name: string) => {
    setScenarios((prev) => prev.map((s) => s.id === id ? { ...s, name } : s));
  }, []);

  // Rename category
  const renameCategory = useCallback((id: string, category: string) => {
    setScenarios((prev) => prev.map((s) => s.id === id ? { ...s, category } : s));
  }, []);

  const heroImg = propertyImage ?? (zillowPhotos.length > 0 ? zillowPhotos[0] : null);

  // Drag handlers for column reordering
  const handleDragStart = useCallback((idx: number) => { setDragIdx(idx); }, []);
  const handleDragOver = useCallback((e: React.DragEvent, targetIdx: number) => {
    e.preventDefault();
    if (dragIdx == null || dragIdx === targetIdx) return;
    setScenarios((prev) => {
      const next = [...prev];
      const [moved] = next.splice(dragIdx, 1);
      next.splice(targetIdx, 0, moved);
      return next;
    });
    setDragIdx(targetIdx);
  }, [dragIdx]);
  const handleDragEnd = useCallback(() => { setDragIdx(null); }, []);

  // Export to PDF — html2canvas captures the exact preview, then jsPDF adds disclaimers page
  const exportPDF = useCallback(async () => {
    if (!flyerRef.current) return;
    setExporting(true);
    try {
      const html2canvas = (await import("html2canvas-pro")).default;
      const { jsPDF } = await import("jspdf");

      const el = flyerRef.current;

      console.log("[PDF Export] v3 — input→span swap");
      // ── Temporarily modify the LIVE element for capture ──
      const origClassName = el.className;
      const origOverflow = el.style.overflow;
      const origRadius = el.style.borderRadius;

      el.className = el.className.replace(/overflow-hidden/g, "").replace(/rounded-xl/g, "");
      el.style.overflow = "visible";
      el.style.borderRadius = "0";
      el.classList.add("flyer-exporting");

      // ── Swap <input> elements with <div> — html2canvas can't render inputs properly ──
      const inputSwaps: { input: HTMLInputElement; replacement: HTMLElement; parent: Node }[] = [];
      el.querySelectorAll("input[type='text'], input:not([type])").forEach((input) => {
        const inp = input as HTMLInputElement;
        const div = document.createElement("div");
        div.textContent = inp.value || inp.placeholder || "";
        // Copy the className so it gets the same Tailwind layout (width, text-align, font, etc.)
        div.className = inp.className;
        // Override input-specific styles that don't apply to divs
        div.style.border = "none";
        div.style.outline = "none";
        div.style.background = "transparent";
        div.style.cursor = "default";
        if (!inp.value) div.style.color = "#d1d5db"; // placeholder color
        if (inp.parentNode) {
          inp.parentNode.replaceChild(div, inp);
          inputSwaps.push({ input: inp, replacement: div, parent: div.parentNode! });
        }
      });

      // Wait for repaint
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const canvas = await html2canvas(el, {
        scale: 1.5,
        useCORS: true,
        backgroundColor: "#ffffff",
        logging: false,
      });

      // ── Restore everything ──
      // Swap divs back to inputs
      for (const { input, replacement, parent } of inputSwaps) {
        parent.replaceChild(input, replacement);
      }
      el.className = origClassName;
      el.style.overflow = origOverflow;
      el.style.borderRadius = origRadius;

      // Convert to JPEG for smaller file size
      const imgData = canvas.toDataURL("image/jpeg", 0.85);

      // Create PDF sized to the canvas aspect ratio, letter width
      const pdfW = 612; // letter width in pt
      const pdfH = (canvas.height / canvas.width) * pdfW;
      const pdf = new jsPDF({
        orientation: "portrait",
        unit: "pt",
        format: [pdfW, Math.max(pdfH, 792)], // at least letter height
      });
      pdf.addImage(imgData, "JPEG", 0, 0, pdfW, pdfH);

      // ══════════ PAGE 2: DISCLAIMERS ══════════
      pdf.addPage("letter");
      const pw = pdf.internal.pageSize.getWidth();
      const ph = pdf.internal.pageSize.getHeight();
      const m = 40;
      const cw = pw - m * 2;
      let dy = m + 10;

      // Date line
      pdf.setFontSize(7.5); pdf.setFont("helvetica", "bold"); pdf.setTextColor(220, 38, 38);
      const dateStr = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
      pdf.text(`Rates, terms, and fees as of ${dateStr} and subject to change without notice.`, m, dy);
      dy += 28;

      // Heading
      pdf.setFontSize(18); pdf.setFont("helvetica", "bold"); pdf.setTextColor(31, 41, 55);
      pdf.text("General Disclosures", m, dy);
      dy += 22;

      // Body
      pdf.setFontSize(8.5); pdf.setFont("helvetica", "normal"); pdf.setTextColor(55, 65, 81);
      const bodyLines = pdf.splitTextToSize(DISCLAIMER_BODY, cw);
      const lineH = pdf.getLineHeight() / pdf.internal.scaleFactor;
      pdf.text(bodyLines, m, dy);
      dy += bodyLines.length * lineH + 24;

      // Licensing
      pdf.setFontSize(7); pdf.setTextColor(107, 114, 128);
      const licLines = pdf.splitTextToSize(DISCLAIMER_LICENSING, cw);
      pdf.text(licLines, m, dy);
      dy += licLines.length * (pdf.getLineHeight() / pdf.internal.scaleFactor) + 30;

      // Footer
      const fy = Math.max(dy + 20, ph - 90);
      pdf.setFontSize(9); pdf.setFont("helvetica", "bold"); pdf.setTextColor(31, 41, 55);
      pdf.text("GMCC is a direct lender", pw * 0.2, fy, { align: "center" });
      pdf.text("Licensed in 49 states", pw * 0.5, fy, { align: "center" });
      pdf.text("In-house underwriting", pw * 0.8, fy, { align: "center" });
      pdf.setFontSize(8);
      pdf.text("General Mortgage Capital Corporation: 1350 Bayshore Hwy Ste 740, Burlingame CA 94010", pw / 2, fy + 26, { align: "center" });
      pdf.setFontSize(7); pdf.setFont("helvetica", "normal"); pdf.setTextColor(107, 114, 128);
      pdf.text("Ph: 866-462-2929 (866-GMCC-WAY) | Email: info@gmccloan.com; NMLS\u2014254895 | CFL: 60DBO-66060", pw / 2, fy + 38, { align: "center" });

      pdf.save(`Home Financing Options - ${listing?.formattedAddress ?? "property"}.pdf`);
    } catch (err) {
      console.error("PDF export error:", err);
    } finally {
      setExporting(false);
    }
  }, [listing]);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-gray-800">Home Financing Options Flyer</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={addColumn}
            className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Add Column
          </button>
          <button
            onClick={exportPDF}
            disabled={exporting}
            className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
          >
            {exporting ? (
              <>
                <svg className="h-3 w-3 animate-spin" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" />
                </svg>
                Exporting...
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M8 2v8M5 7l3 3 3-3M3 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Download PDF
              </>
            )}
          </button>
        </div>
      </div>

      <p className="text-xs text-gray-400">Click any cell to edit. Drag column headers to reorder. Changes auto-calculate dependent fields.</p>

      {/* Hide edit-only elements during PDF export */}
      <style>{`.flyer-exporting .edit-only { display: none !important; }`}</style>

      {/* ═══ Flyer Preview ═══ */}
      <div
        ref={flyerRef}
        className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm"
        style={{ maxWidth: 900 }}
      >
        {/* ── Header: Logo + Title ── */}
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-3">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/gmcc-logo.png" alt="GMCC" className="h-10 w-auto" />
            <div>
              <div className="text-sm font-bold text-gray-900">General Mortgage Capital Corporation</div>
              <div className="text-[0.6rem] text-gray-400">NMLS #254895 | Licensed in 49 States</div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-lg font-bold text-red-700">Home Financing Options</div>
          </div>
        </div>

        {/* ── LO Contact + Property Photo ── */}
        {/* Using inline flex + percentage widths instead of CSS grid for html2canvas compatibility */}
        {/* Height is driven by the LO card content — photo fills to match */}
        <div data-pdf="hero-row" style={{ display: "flex", width: "100%", minHeight: "12rem" }}>
          {/* Property photo (60% width) — fills parent height */}
          <div style={{ width: "60%", flexShrink: 0, position: "relative" }} className="bg-gray-100">
            {heroImg ? (
              <img src={heroImg} alt="Property" style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "center" }} />
            ) : (
              <div className="flex h-full items-center justify-center text-gray-300">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="M21 15l-5-5L5 21" />
                </svg>
              </div>
            )}
          </div>

          {/* LO contact card (40% width) — editable, persisted in localStorage */}
          <div style={{ width: "40%", flexShrink: 0 }} className="flex flex-col items-center justify-center border-l border-red-100 bg-red-50/40 px-5 py-4 text-center">
            <div className="mb-2 text-[0.6rem] font-semibold uppercase tracking-widest text-red-400">
              Mortgage Information Contact
            </div>
            {headshot && (
              <img src={headshot} alt="LO" className="mb-2 h-28 w-28 rounded-lg border-2 border-red-500 object-cover shadow-md" />
            )}
            <input
              value={loInfo.name}
              onChange={(e) => updateLO("name", e.target.value)}
              placeholder="Your Name"
              className="w-full border-0 bg-transparent text-center text-base font-bold text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-0"
            />
            <div className="flex items-center justify-center gap-1">
              <span className="text-[0.65rem] text-gray-400">NMLS#</span>
              <input
                value={loInfo.nmls}
                onChange={(e) => updateLO("nmls", e.target.value)}
                placeholder="000000"
                className="w-16 border-0 bg-transparent text-center text-[0.7rem] text-gray-500 placeholder-gray-300 focus:outline-none focus:ring-0"
              />
            </div>
            <input
              value={loInfo.title}
              onChange={(e) => updateLO("title", e.target.value)}
              placeholder="Title"
              className="w-full border-0 bg-transparent text-center text-[0.65rem] text-gray-400 placeholder-gray-300 focus:outline-none focus:ring-0"
            />
            <div className="mt-1 flex items-center justify-center gap-1">
              <span className="text-[0.65rem] text-gray-400">Phone:</span>
              <input
                value={loInfo.phone}
                onChange={(e) => updateLO("phone", e.target.value)}
                placeholder="(xxx) xxx-xxxx"
                className="w-28 border-0 bg-transparent text-center text-[0.7rem] text-gray-600 placeholder-gray-300 focus:outline-none focus:ring-0"
              />
            </div>
            <input
              value={loInfo.email}
              onChange={(e) => updateLO("email", e.target.value)}
              placeholder="your.email@gmccloan.com"
              className="w-full border-0 bg-transparent text-center text-[0.65rem] text-gray-500 placeholder-gray-300 focus:outline-none focus:ring-0"
            />
          </div>
        </div>

        {/* ── Property Details Bar ── */}
        <div className="border-y border-gray-200 bg-white px-6 py-3">
          <div className="text-base font-bold text-gray-900">
            {listing?.formattedAddress ?? "Property Address"}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-gray-600">
            {price > 0 && (
              <span className="text-sm font-bold text-red-700">{formatPrice(price)}</span>
            )}
            {listing?.bedrooms != null && <span>{listing.bedrooms} bd | {listing?.bathrooms ?? "?"} ba</span>}
            {listing?.squareFootage && <span>{listing.squareFootage.toLocaleString()} sq ft</span>}
            {listing?.yearBuilt && <span>Year Built: {listing.yearBuilt}</span>}
            {listing?.lotSize && <span>Lot: {listing.lotSize.toLocaleString()} sq ft</span>}
          </div>
        </div>

        {/* ── Broker / Realtor Info ── */}
        <div data-pdf="broker-row" className="border-b border-gray-100 px-6 py-3">
          {/* Using inline flex for html2canvas compatibility */}
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: "2rem" }}>
            {brokers.map((b, idx) => (
              <div key={idx} style={{ minWidth: 160, textAlign: "center" }}>
                <div className="mb-1 flex items-center justify-center gap-2">
                  <span className="text-[0.6rem] font-semibold uppercase tracking-wider text-gray-400">
                    {idx === 0 ? "Listing Broker" : "Co-Listing Broker"}
                  </span>
                  <button
                    onClick={() => removeBroker(idx)}
                    className="edit-only flex h-3.5 w-3.5 items-center justify-center rounded-full bg-gray-200 text-gray-400 hover:bg-red-100 hover:text-red-500"
                    title="Remove broker"
                  >
                    <svg width="6" height="6" viewBox="0 0 16 16" fill="none">
                      <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
                <input
                  value={b.name}
                  onChange={(e) => updateBroker(idx, "name", e.target.value)}
                  placeholder="Broker name"
                  className="mb-0.5 block w-full border-0 bg-transparent p-0 text-center text-xs font-semibold text-gray-800 placeholder-gray-300 focus:outline-none focus:ring-0"
                />
                <input
                  value={b.company}
                  onChange={(e) => updateBroker(idx, "company", e.target.value)}
                  placeholder="Company"
                  className="mb-0.5 block w-full border-0 bg-transparent p-0 text-center text-[0.65rem] text-gray-500 placeholder-gray-300 focus:outline-none focus:ring-0"
                />
                <input
                  value={b.phone}
                  onChange={(e) => updateBroker(idx, "phone", e.target.value)}
                  placeholder="Broker phone"
                  className="mb-0.5 block w-full border-0 bg-transparent p-0 text-center text-[0.6rem] text-gray-500 placeholder-gray-300 focus:outline-none focus:ring-0"
                />
                <input
                  value={b.officePhone}
                  onChange={(e) => updateBroker(idx, "officePhone", e.target.value)}
                  placeholder="Office phone"
                  className="block w-full border-0 bg-transparent p-0 text-center text-[0.6rem] text-gray-500 placeholder-gray-300 focus:outline-none focus:ring-0"
                />
              </div>
            ))}
            <button
              onClick={addBroker}
              className="edit-only mt-3 inline-flex items-center gap-1 self-center text-[0.65rem] font-medium text-gray-400 transition-colors hover:text-red-600"
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              Add Broker
            </button>
          </div>
        </div>

        {/* ── Loan Comparison Table ── */}
        <div className="overflow-x-auto px-4 py-4">
          <table className="w-full border-collapse text-xs">
            <thead>
              {/* Category row */}
              <tr>
                <th className="w-40 border-b-2 border-red-600 px-2 py-1.5 text-left text-gray-500" />
                {scenarios.map((s) => (
                  <th key={s.id} className="border-b-2 border-red-600 px-2 py-1.5 text-center">
                    <EditableText
                      value={s.category}
                      onChange={(v) => renameCategory(s.id, v)}
                      className="text-center text-[0.7rem] font-bold uppercase tracking-wide text-red-700"
                    />
                  </th>
                ))}
              </tr>
              {/* Name + remove + drag row */}
              <tr className="bg-gray-50">
                <th className="px-2 py-1.5 text-left text-[0.65rem] font-medium text-gray-400" />
                {scenarios.map((s, idx) => (
                  <th
                    key={s.id}
                    className={`px-2 py-1 ${dragIdx === idx ? "opacity-50" : ""}`}
                    draggable
                    onDragStart={() => handleDragStart(idx)}
                    onDragOver={(e) => handleDragOver(e, idx)}
                    onDragEnd={handleDragEnd}
                    style={{ cursor: "grab" }}
                  >
                    <div className="flex items-center justify-center gap-1">
                      {/* Drag handle */}
                      <span className="edit-only shrink-0 cursor-grab text-gray-300" title="Drag to reorder">
                        <svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor">
                          <circle cx="5" cy="4" r="1.5" /><circle cx="11" cy="4" r="1.5" />
                          <circle cx="5" cy="8" r="1.5" /><circle cx="11" cy="8" r="1.5" />
                          <circle cx="5" cy="12" r="1.5" /><circle cx="11" cy="12" r="1.5" />
                        </svg>
                      </span>
                      <EditableText
                        value={s.name}
                        onChange={(v) => renameColumn(s.id, v)}
                        className="text-center text-gray-700"
                      />
                      {scenarios.length > 1 && (
                        <button
                          onClick={() => removeColumn(s.id)}
                          className="edit-only flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-gray-300 transition-colors hover:bg-red-100 hover:text-red-500"
                          title="Remove column"
                        >
                          <svg width="8" height="8" viewBox="0 0 16 16" fill="none">
                            <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {TABLE_ROWS.map((row) => {
                if (row.key === "monthlyHeader") {
                  return (
                    <tr key={row.key} className="bg-gray-50">
                      <td className="border-t-2 border-gray-300 px-2 py-2 text-xs font-bold text-gray-800">
                        {row.label}
                      </td>
                      {scenarios.map((s) => (
                        <td key={s.id} className="border-t-2 border-gray-300 px-2 py-2 text-center text-xs font-bold text-gray-800">
                          {totalMonthly(s) != null ? "$" + totalMonthly(s)!.toLocaleString() : "\u2014"}
                        </td>
                      ))}
                    </tr>
                  );
                }

                return (
                  <tr key={row.key} className={`border-b border-gray-100 ${row.isBold ? "bg-red-50" : ""}`}>
                    <td className={`px-2 py-1.5 text-xs ${row.isBold ? "font-bold text-red-800" : "text-gray-600"}`}>
                      {row.label}
                    </td>
                    {scenarios.map((s) => (
                      <td key={s.id} className="px-1 py-0.5 text-center">
                        {row.editable ? (
                          <EditableCell
                            value={s[row.field] as number | null}
                            onChange={(v) => updateField(s.id, row.field, v)}
                            format={row.format}
                          />
                        ) : (
                          <div className={`px-1.5 py-0.5 text-right text-xs ${row.isBold ? "font-bold text-red-800" : "text-gray-700"}`}>
                            {(s[row.field] as number | null) != null
                              ? "$" + (s[row.field] as number).toLocaleString()
                              : "\u2014"}
                          </div>
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* ── Footer Disclaimer ── */}
        <div className="border-t border-gray-200 bg-blue-50 px-6 py-2.5">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-blue-500 text-[0.55rem] font-bold text-white">
              i
            </div>
            <p className="text-[0.6rem] leading-relaxed text-gray-600">
              Your actual rate, payment, and costs could be higher. Get an official Loan Estimate before choosing a loan.
              Interest rates and APRs are based on current market rates, are for informational purposes only, and are subject to change without notice.
            </p>
          </div>
        </div>

        {/* ── Bottom Bar ── */}
        <div className="flex items-center justify-between bg-gray-800 px-6 py-2.5 text-[0.6rem] text-gray-300">
          <span>General Mortgage Capital Corporation | NMLS #254895</span>
          <span>1350 Bayshore Hwy Ste 740, Burlingame CA 94010 | 866-462-2929</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Disclaimer text for page 2
// ---------------------------------------------------------------------------

const DISCLAIMER_BODY = `Interest rates and annual percentage rates (APRs) are based on current market rates, are for informational purposes only, are subject to change without notice and may be subject to pricing add-ons related to property type, loan amount, loan-to-value, credit score and other variables\u2014call for details. This is not a credit decision or a commitment to lend. Depending on loan guidelines, mortgage insurance may be required. If mortgage insurance is required, the mortgage insurance premium could increase the APR and the monthly mortgage payment. Additional loan programs may be available.

APR reflects the effective cost of your loan on a yearly basis, considering such items as interest, most closing costs, discount points (also referred to as \u201cpoints\u201d) and loan-origination fees. One point is 1% of the mortgage amount (e.g., $1,000 on a $100,000 loan). Your monthly payment is not based on APR, but instead on the interest rate on your note.

Adjustable-rate mortgage (ARM) rates assume no increase in the financial index after the initial fixed period. ARM rates and monthly payments are subject to increase after the fixed period: ARMs assume 30-year term.`;

const DISCLAIMER_LICENSING = `Real Estate Broker, CA Department of Real Estate: CA DRE: 01509029  Disclosures and Licensing: https://www.gmccloan.com/Disclosures.html  For all state licensing information go to: www.nmlsconsumeraccess.org  Licensed by The Department of Financial Protection and Innovation under the California Finance Lenders Act`;
