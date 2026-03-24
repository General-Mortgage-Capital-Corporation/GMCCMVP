"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatPrice } from "@/lib/utils";
import { getHeadshot } from "@/lib/headshot-store";
import { getLOInfo, setLOInfo, type LOInfo } from "@/lib/lo-info-store";
import { useAuth } from "@/contexts/AuthContext";
import type { RentCastListing, CensusData } from "@/types";
import type { RealtorInfo } from "@/components/flier/FlierButton";

// ---------------------------------------------------------------------------
// Data model: ColumnGroup → SubColumn (LoanScenario)
// ---------------------------------------------------------------------------

export interface LoanScenario {
  id: string;
  name: string;
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
  principalInterest: number | null;
}

interface ColumnGroup {
  id: string;
  name: string; // "Conventional / Jumbo", "Non-QM", etc.
  subColumns: LoanScenario[];
}

// ---------------------------------------------------------------------------
// Default configuration (easily editable)
// ---------------------------------------------------------------------------

interface SubColTemplate { name: string; termMonths: number }
interface GroupTemplate { name: string; subs: SubColTemplate[] }

const DEFAULT_GROUPS: GroupTemplate[] = [
  {
    name: "Conventional / Jumbo",
    subs: [
      { name: "30-Year Fixed", termMonths: 360 },
      { name: "7/6 ARM", termMonths: 360 },
    ],
  },
  {
    name: "Universe / Massive No Ratio No DTI",
    subs: [
      { name: "30-Year Fixed", termMonths: 360 },
      { name: "5/1 ARM", termMonths: 360 },
    ],
  },
  {
    name: "Non-QM",
    subs: [
      { name: "DSCR", termMonths: 360 },
    ],
  },
];

const DEFAULT_CLOSING_COST = 3000;

let _nextId = 1;
function genId() { return `id_${_nextId++}_${Date.now()}`; }

function createSub(t: SubColTemplate, price: number, hoaFee: number | null, estTax: number | null): LoanScenario {
  const dp = Math.round(price * 0.2);
  return {
    id: genId(), name: t.name,
    loanAmount: price - dp, downPayment: dp, downPaymentPct: 20,
    termMonths: t.termMonths, interestRate: null, apr: null, points: null,
    closingCost: DEFAULT_CLOSING_COST,
    propertyTax: estTax, insurance: null, hoaFees: hoaFee, pmi: null,
    principalInterest: null,
  };
}

function createGroup(t: GroupTemplate, price: number, hoa: number | null, tax: number | null): ColumnGroup {
  return { id: genId(), name: t.name, subColumns: t.subs.map((s) => createSub(s, price, hoa, tax)) };
}

// ---------------------------------------------------------------------------
// Mortgage math
// ---------------------------------------------------------------------------

function calcPI(la: number | null, rate: number | null, term: number): number | null {
  if (!la || !rate || !term || la <= 0 || rate <= 0) return null;
  const r = rate / 100 / 12;
  return Math.round(la * (r * Math.pow(1 + r, term)) / (Math.pow(1 + r, term) - 1));
}

function totalMonthly(s: LoanScenario): number | null {
  const pi = s.principalInterest;
  if (pi == null) return null;
  return pi + (s.propertyTax ?? 0) + (s.insurance ?? 0) + (s.hoaFees ?? 0) + (s.pmi ?? 0);
}

// ---------------------------------------------------------------------------
// Editable cell (click to edit)
// ---------------------------------------------------------------------------

function EditableCell({
  value, onChange, format = "currency", highlight = false, bold = false, className = "",
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  format?: "currency" | "percent" | "number" | "months";
  highlight?: boolean;
  bold?: boolean;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing && ref.current) { ref.current.focus(); ref.current.select(); } }, [editing]);

  function display(): string {
    if (value == null) return "\u2014";
    if (format === "currency") return "$" + value.toLocaleString();
    if (format === "percent") return value.toFixed(3) + "%";
    return String(value);
  }

  function commit() {
    setEditing(false);
    const num = parseFloat(text.replace(/[,$%]/g, ""));
    onChange(isNaN(num) ? null : num);
  }

  if (editing) {
    return (
      <input ref={ref} type="text" value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        className={`w-full rounded border border-red-300 bg-white px-1.5 py-0.5 text-right text-xs focus:outline-none focus:ring-1 focus:ring-red-400 ${className}`}
      />
    );
  }

  return (
    <div
      onClick={() => { setText(value != null ? String(value) : ""); setEditing(true); }}
      className={`cursor-pointer rounded px-1.5 py-0.5 text-right text-xs transition-colors ${
        highlight ? "bg-amber-50 ring-1 ring-amber-200/60" : "hover:bg-red-50"
      } ${bold ? "font-bold" : ""} ${className}`}
      title="Click to edit"
    >
      {display()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editable text (click to edit inline)
// ---------------------------------------------------------------------------

function EditableText({
  value, onChange, highlight = false, className = "",
}: {
  value: string; onChange: (v: string) => void; highlight?: boolean; className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing && ref.current) { ref.current.focus(); ref.current.select(); } }, [editing]);

  function commit() { setEditing(false); if (text.trim()) onChange(text.trim()); }

  if (editing) {
    return (
      <input ref={ref} type="text" value={text}
        onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        className={`w-full rounded border border-red-300 bg-white px-1 py-0.5 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-red-400 ${className}`}
      />
    );
  }

  return (
    <div
      onClick={() => { setText(value); setEditing(true); }}
      className={`cursor-pointer rounded px-1 py-0.5 text-xs font-semibold transition-colors ${
        highlight ? "bg-amber-50 ring-1 ring-amber-200/60" : "hover:bg-red-100"
      } ${className}`}
      title="Click to rename"
    >
      {value}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row definitions — reordered per user request
// ---------------------------------------------------------------------------

interface RowDef {
  key: string;
  label: string;
  field: keyof LoanScenario;
  format: "currency" | "percent" | "number" | "months";
  editable: boolean;
  isBold?: boolean;
  isRateRow?: boolean; // special highlight for interest rate
  tooltip?: string;
}

const TABLE_ROWS: RowDef[] = [
  { key: "loanAmount", label: "Loan Amount:", field: "loanAmount", format: "currency", editable: true },
  { key: "downPayment", label: "Down Payment:", field: "downPayment", format: "currency", editable: true },
  { key: "downPaymentPct", label: "Down Payment %:", field: "downPaymentPct", format: "percent", editable: true },
  { key: "termMonths", label: "Term (Months):", field: "termMonths", format: "months", editable: true },
  { key: "interestRate", label: "Interest Rate:", field: "interestRate", format: "percent", editable: true, isBold: true, isRateRow: true },
  { key: "apr", label: "APR:", field: "apr", format: "percent", editable: true },
  { key: "points", label: "Points:", field: "points", format: "number", editable: true, tooltip: "MLO comp % + pricing. Above par \u2192 net, below par \u2192 add." },
  { key: "closingCost", label: "Closing Cost:", field: "closingCost", format: "currency", editable: true },
  // Monthly payment breakdown
  { key: "propertyTax", label: "  - Property Tax:", field: "propertyTax", format: "currency", editable: true },
  { key: "insurance", label: "  - Homeowners Insurance:", field: "insurance", format: "currency", editable: true },
  { key: "hoaFees", label: "  - HOA/Dues/Fees:", field: "hoaFees", format: "currency", editable: true },
  { key: "pmi", label: "  - PMI:", field: "pmi", format: "currency", editable: true },
  { key: "principalInterest", label: "  - Principal & Interest:", field: "principalInterest", format: "currency", editable: false },
  // Total at the bottom
  { key: "totalMonthly", label: "Total Monthly Payment:", field: "principalInterest", format: "currency", editable: false, isBold: true },
];

// ---------------------------------------------------------------------------
// Broker info
// ---------------------------------------------------------------------------

interface BrokerInfo { label: string; name: string; company: string; phone: string; email: string }

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface LoanComparisonFlyerProps {
  listing: RentCastListing | null;
  census: CensusData | null;
  realtorInfo: RealtorInfo;
  propertyImage?: string;
  zillowPhotos: string[];
}

export default function LoanComparisonFlyer({
  listing, census, realtorInfo, propertyImage, zillowPhotos,
}: LoanComparisonFlyerProps) {
  const price = listing?.price ?? 0;
  const flyerRef = useRef<HTMLDivElement>(null);
  const headshot = getHeadshot();
  const [exporting, setExporting] = useState(false);

  // LO info
  const { user } = useAuth();
  const [loInfo, setLoInfoState] = useState<LOInfo>(getLOInfo);
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
    setLoInfoState((prev) => { const next = { ...prev, [field]: value }; setLOInfo(next); return next; });
  }, []);

  // Tagline
  const [tagline, setTagline] = useState("CALL ME");

  // Broker info
  const agent = listing?.listingAgent;
  const office = listing?.listingOffice;
  const [brokers, setBrokers] = useState<BrokerInfo[]>([]);
  useEffect(() => {
    const initial: BrokerInfo[] = [];
    // Add listing agent as primary broker
    if (agent?.name) {
      initial.push({ label: "Listing Broker", name: agent.name, company: office?.name ?? "", phone: agent.phone ?? "", email: agent.email ?? "" });
    }
    // Add listing office as separate entry if it has its own contact details
    if (office?.name && (office?.phone || office?.email)) {
      const isDuplicate = agent?.name && !office.email && !office.phone;
      if (!isDuplicate) {
        initial.push({ label: "Listing Office", name: office.name, company: "", phone: office.phone ?? "", email: office.email ?? "" });
      }
    }
    setBrokers(initial);
  }, [agent?.name, agent?.phone, agent?.email, office?.name, office?.phone, office?.email]);
  const addBroker = useCallback(() => setBrokers((p) => [...p, { label: "Co-Listing Broker", name: "", company: "", phone: "", email: "" }]), []);
  const removeBroker = useCallback((i: number) => setBrokers((p) => p.filter((_, idx) => idx !== i)), []);
  const updateBroker = useCallback((i: number, f: keyof BrokerInfo, v: string) => {
    setBrokers((p) => p.map((b, idx) => idx === i ? { ...b, [f]: v } : b));
  }, []);

  // RentCast data
  const hoaFee = listing?.hoa?.fee ?? null;
  const estimatedMonthlyTax = listing?.taxAssessedValue ? Math.round((listing.taxAssessedValue * 0.011) / 12) : null;
  const heroImg = propertyImage ?? (zillowPhotos.length > 0 ? zillowPhotos[0] : null);

  // Column groups with sub-columns
  const [groups, setGroups] = useState<ColumnGroup[]>(() =>
    DEFAULT_GROUPS.map((g) => createGroup(g, price || 500000, hoaFee, estimatedMonthlyTax)),
  );

  // Recalculate when price changes
  useEffect(() => {
    if (!price) return;
    setGroups((prev) => prev.map((g) => ({
      ...g,
      subColumns: g.subColumns.map((s) => {
        const dpPct = s.downPaymentPct ?? 20;
        const dp = Math.round(price * dpPct / 100);
        const la = price - dp;
        return { ...s, loanAmount: la, downPayment: dp, principalInterest: calcPI(la, s.interestRate, s.termMonths) };
      }),
    })));
  }, [price]);

  // Flatten all sub-columns for table rendering
  const allSubs = groups.flatMap((g) => g.subColumns);

  // Update a sub-column field
  const updateField = useCallback((subId: string, field: keyof LoanScenario, value: number | null) => {
    setGroups((prev) => prev.map((g) => ({
      ...g,
      subColumns: g.subColumns.map((s) => {
        if (s.id !== subId) return s;
        const u = { ...s, [field]: value };
        if (field === "downPaymentPct" && value != null && price > 0) {
          u.downPayment = Math.round(price * value / 100); u.loanAmount = price - u.downPayment;
        } else if (field === "downPayment" && value != null && price > 0) {
          u.downPaymentPct = Math.round((value / price) * 10000) / 100; u.loanAmount = price - value;
        } else if (field === "loanAmount" && value != null && price > 0) {
          u.downPayment = price - value; u.downPaymentPct = Math.round((u.downPayment / price) * 10000) / 100;
        }
        if (["loanAmount", "downPayment", "downPaymentPct", "interestRate", "termMonths"].includes(field)) {
          u.principalInterest = calcPI(u.loanAmount, u.interestRate, u.termMonths);
        }
        return u;
      }),
    })));
  }, [price]);

  // Group operations
  const addGroup = useCallback(() => {
    setGroups((p) => [...p, {
      id: genId(), name: "New Program",
      subColumns: [createSub({ name: "30-Year Fixed", termMonths: 360 }, price || 500000, hoaFee, estimatedMonthlyTax)],
    }]);
  }, [price, hoaFee, estimatedMonthlyTax]);

  const removeGroup = useCallback((gid: string) => setGroups((p) => p.filter((g) => g.id !== gid)), []);

  const renameGroup = useCallback((gid: string, name: string) => {
    setGroups((p) => p.map((g) => g.id === gid ? { ...g, name } : g));
  }, []);

  // Sub-column operations
  const addSubColumn = useCallback((gid: string) => {
    setGroups((p) => p.map((g) => g.id === gid ? {
      ...g,
      subColumns: [...g.subColumns, createSub({ name: "New Option", termMonths: 360 }, price || 500000, hoaFee, estimatedMonthlyTax)],
    } : g));
  }, [price, hoaFee, estimatedMonthlyTax]);

  const removeSubColumn = useCallback((gid: string, sid: string) => {
    setGroups((p) => p.map((g) => g.id === gid ? { ...g, subColumns: g.subColumns.filter((s) => s.id !== sid) } : g));
  }, []);

  const renameSubColumn = useCallback((sid: string, name: string) => {
    setGroups((p) => p.map((g) => ({ ...g, subColumns: g.subColumns.map((s) => s.id === sid ? { ...s, name } : s) })));
  }, []);

  // Drag reorder groups
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const handleDragStart = useCallback((i: number) => setDragIdx(i), []);
  const handleDragOver = useCallback((e: React.DragEvent, ti: number) => {
    e.preventDefault();
    if (dragIdx == null || dragIdx === ti) return;
    setGroups((p) => { const n = [...p]; const [m] = n.splice(dragIdx, 1); n.splice(ti, 0, m); return n; });
    setDragIdx(ti);
  }, [dragIdx]);
  const handleDragEnd = useCallback(() => setDragIdx(null), []);

  // ── PDF Export ──
  const exportPDF = useCallback(async () => {
    if (!flyerRef.current) return;
    setExporting(true);
    try {
      const html2canvas = (await import("html2canvas-pro")).default;
      const { jsPDF } = await import("jspdf");
      const el = flyerRef.current;

      console.log("[PDF Export] v4 — input→div swap + subcolumns");
      const origClassName = el.className;
      const origOverflow = el.style.overflow;
      const origRadius = el.style.borderRadius;
      el.className = el.className.replace(/overflow-hidden/g, "").replace(/rounded-xl/g, "");
      el.style.overflow = "visible";
      el.style.borderRadius = "0";
      el.classList.add("flyer-exporting");

      // Strip amber highlight from all editable fields for clean PDF
      const highlighted = el.querySelectorAll(".bg-amber-50");
      highlighted.forEach((h) => {
        (h as HTMLElement).classList.remove("bg-amber-50");
        (h as HTMLElement).style.boxShadow = "none";
      });

      // Swap inputs with divs — wrapped in try/finally to guarantee DOM restoration
      const swaps: { input: HTMLInputElement; div: HTMLElement; parent: Node }[] = [];
      let canvas: HTMLCanvasElement;
      try {
        el.querySelectorAll("input[type='text'], input:not([type])").forEach((input) => {
          const inp = input as HTMLInputElement;
          const parent = inp.parentNode;
          if (!parent) return;
          const div = document.createElement("div");
          div.textContent = inp.value || inp.placeholder || "";
          div.className = inp.className;
          div.style.border = "none"; div.style.outline = "none"; div.style.background = "transparent";
          if (!inp.value) div.style.color = "#d1d5db";
          swaps.push({ input: inp, div, parent });
          parent.replaceChild(div, inp);
        });

        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        canvas = await html2canvas(el, { scale: 1.5, useCORS: true, backgroundColor: "#ffffff", logging: false });
      } finally {
        // Always restore DOM even if html2canvas throws
        for (const { input, div, parent } of swaps) {
          try { parent.replaceChild(input, div); } catch { /* already restored */ }
        }
        highlighted.forEach((h) => { (h as HTMLElement).classList.add("bg-amber-50"); (h as HTMLElement).style.boxShadow = ""; });
        el.className = origClassName; el.style.overflow = origOverflow; el.style.borderRadius = origRadius;
      }

      const imgData = canvas.toDataURL("image/jpeg", 0.85);
      const pdfW = 612;
      const pdfH = (canvas.height / canvas.width) * pdfW;
      const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: [pdfW, Math.max(pdfH, 792)] });
      pdf.addImage(imgData, "JPEG", 0, 0, pdfW, pdfH);

      // Page 2: Disclaimers
      pdf.addPage("letter");
      const pw = pdf.internal.pageSize.getWidth();
      const ph = pdf.internal.pageSize.getHeight();
      const m = 40; const cw = pw - m * 2; let dy = m + 10;
      pdf.setFontSize(18); pdf.setFont("helvetica", "bold"); pdf.setTextColor(31, 41, 55);
      pdf.text("General Disclosures", m, dy); dy += 22;
      pdf.setFontSize(8.5); pdf.setFont("helvetica", "normal"); pdf.setTextColor(55, 65, 81);
      const bl = pdf.splitTextToSize(DISC_BODY, cw);
      const lh = pdf.getLineHeight() / pdf.internal.scaleFactor;
      pdf.text(bl, m, dy); dy += bl.length * lh + 24;
      pdf.setFontSize(7); pdf.setTextColor(107, 114, 128);
      const ll = pdf.splitTextToSize(DISC_LIC, cw);
      pdf.text(ll, m, dy); dy += ll.length * (pdf.getLineHeight() / pdf.internal.scaleFactor) + 30;
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
    } catch (err) { console.error("PDF export error:", err); } finally { setExporting(false); }
  }, [listing]);

  // Total sub-column count for table colspan
  const totalSubs = groups.reduce((n, g) => n + g.subColumns.length, 0);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-gray-800">Home Financing Options Flyer <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase text-amber-700">Beta</span></h3>
        <button onClick={exportPDF} disabled={exporting}
          className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50">
          {exporting ? <>
            <svg className="h-3 w-3 animate-spin" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" /></svg>
            Exporting...
          </> : <>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 2v8M5 7l3 3 3-3M3 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            Download PDF
          </>}
        </button>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5">
        <p className="text-sm font-medium text-amber-800">
          <span className="font-bold">All highlighted fields are editable</span> — click any cell to change its value. Drag column headers to reorder. Auto-calculations update as you type.
        </p>
        <p className="mt-1 text-xs text-amber-600">
          Highlights, edit buttons, and UI controls are only visible here — the downloaded PDF will be clean.
        </p>
      </div>

      {/* Hide edit-only elements in PDF export */}
      <style>{`
        .flyer-exporting .edit-only { display: none !important; }
        .flyer-exporting .bg-amber-50 { background-color: transparent !important; }
        .flyer-exporting .ring-amber-200\\/60 { --tw-ring-color: transparent !important; box-shadow: none !important; }
      `}</style>

      {/* ═══ Flyer Preview ═══ */}
      <div ref={flyerRef} className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm" style={{ maxWidth: 960 }}>

        {/* ── Header — wraps on mobile ── */}
        <div className="flex flex-col gap-2 border-b border-gray-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/gmcc-logo.png" alt="GMCC" className="h-10 w-auto" />
            <div>
              <div className="text-sm font-bold text-gray-900">General Mortgage Capital Corporation</div>
              <div className="text-[0.6rem] text-gray-400">NMLS #254895 | Licensed in 49 States</div>
            </div>
          </div>
          <div className="sm:text-right">
            <div className="text-lg font-bold text-red-700">Home Financing Options</div>
          </div>
        </div>

        {/* ── Photo + LO Contact — stacks on mobile ── */}
        <div data-pdf="hero-row" className="flex flex-col sm:flex-row" style={{ width: "100%", minHeight: "12rem" }}>
          <div className="relative min-h-[10rem] w-full bg-gray-100 sm:w-[60%] sm:shrink-0">
            {heroImg ? (
              <img src={heroImg} alt="Property" style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "center" }} />
            ) : (
              <div className="flex h-full items-center justify-center text-gray-300">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>
              </div>
            )}
          </div>
          <div className="flex w-full flex-col items-center justify-center border-t border-red-100 bg-red-50/40 px-5 py-4 text-center sm:w-[40%] sm:shrink-0 sm:border-l sm:border-t-0">
            {/* Editable tagline — at the top */}
            <input value={tagline} onChange={(e) => setTagline(e.target.value)}
              className="mb-2 w-full border-0 bg-transparent text-center text-xl font-extrabold tracking-wide text-red-700 placeholder-red-300 focus:outline-none focus:ring-0"
              placeholder="CALL ME" />
            {headshot && <img src={headshot} alt="LO" className="mb-2 h-28 w-28 rounded-lg border-2 border-red-500 object-cover shadow-md" />}
            <input value={loInfo.name} onChange={(e) => updateLO("name", e.target.value)} placeholder="Your Name"
              className="w-full border-0 bg-transparent text-center text-base font-bold text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-0" />
            <div className="flex items-center justify-center gap-1">
              <span className="text-[0.65rem] text-gray-400">NMLS#</span>
              <input value={loInfo.nmls} onChange={(e) => updateLO("nmls", e.target.value)} placeholder="000000"
                className="w-16 border-0 bg-transparent text-center text-[0.7rem] text-gray-500 placeholder-gray-300 focus:outline-none focus:ring-0" />
            </div>
            <input value={loInfo.title} onChange={(e) => updateLO("title", e.target.value)} placeholder="Title"
              className="w-full border-0 bg-transparent text-center text-[0.65rem] text-gray-400 placeholder-gray-300 focus:outline-none focus:ring-0" />
            <div className="mt-1 flex items-center justify-center gap-1">
              <span className="text-[0.65rem] text-gray-400">Phone:</span>
              <input value={loInfo.phone} onChange={(e) => updateLO("phone", e.target.value)} placeholder="(xxx) xxx-xxxx"
                className="w-28 border-0 bg-transparent text-center text-[0.7rem] text-gray-600 placeholder-gray-300 focus:outline-none focus:ring-0" />
            </div>
            <input value={loInfo.email} onChange={(e) => updateLO("email", e.target.value)} placeholder="your.email@gmccloan.com"
              className="w-full border-0 bg-transparent text-center text-[0.65rem] text-gray-500 placeholder-gray-300 focus:outline-none focus:ring-0" />
          </div>
        </div>

        {/* ── Property Details ── */}
        <div className="border-y border-gray-200 bg-white px-4 py-3 sm:px-6">
          <div className="text-base font-bold text-gray-900">{listing?.formattedAddress ?? "Property Address"}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-gray-600">
            {price > 0 && <span className="text-sm font-bold text-red-700">{formatPrice(price)}</span>}
            {listing?.bedrooms != null && <span>{listing.bedrooms} bd | {listing?.bathrooms ?? "?"} ba</span>}
            {listing?.squareFootage && <span>{listing.squareFootage.toLocaleString()} sq ft</span>}
            {listing?.yearBuilt && <span>Year Built: {listing.yearBuilt}</span>}
            {listing?.lotSize && <span>Lot: {listing.lotSize.toLocaleString()} sq ft</span>}
          </div>
        </div>

        {/* ── Broker Info — wraps on mobile ── */}
        <div data-pdf="broker-row" className="border-b border-gray-100 px-4 py-3 sm:px-6">
          <div className="flex flex-wrap justify-center gap-4 sm:justify-end sm:gap-8">
            {brokers.map((b, idx) => (
              <div key={idx} className="min-w-[140px] text-center sm:min-w-[160px]">
                <div className="mb-1 flex items-center justify-center gap-2">
                  <input value={b.label} onChange={(e) => updateBroker(idx, "label", e.target.value)}
                    className="w-24 border-0 bg-transparent p-0 text-center text-[0.6rem] font-semibold uppercase tracking-wider text-gray-400 placeholder-gray-300 focus:outline-none focus:ring-0 focus:text-gray-600"
                    placeholder="Label" />
                  <button onClick={() => removeBroker(idx)}
                    className="edit-only flex h-3.5 w-3.5 items-center justify-center rounded-full bg-gray-200 text-gray-400 hover:bg-red-100 hover:text-red-500" title="Remove broker">
                    <svg width="6" height="6" viewBox="0 0 16 16" fill="none"><path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>
                  </button>
                </div>
                <input value={b.name} onChange={(e) => updateBroker(idx, "name", e.target.value)} placeholder="Broker name"
                  className="mb-0.5 block w-full border-0 bg-transparent p-0 text-center text-xs font-semibold text-gray-800 placeholder-gray-300 focus:outline-none focus:ring-0" />
                <input value={b.company} onChange={(e) => updateBroker(idx, "company", e.target.value)} placeholder="Company"
                  className="mb-0.5 block w-full border-0 bg-transparent p-0 text-center text-[0.65rem] text-gray-500 placeholder-gray-300 focus:outline-none focus:ring-0" />
                <input value={b.phone} onChange={(e) => updateBroker(idx, "phone", e.target.value)} placeholder="Broker phone"
                  className="mb-0.5 block w-full border-0 bg-transparent p-0 text-center text-[0.6rem] text-gray-500 placeholder-gray-300 focus:outline-none focus:ring-0" />
                <input value={b.email} onChange={(e) => updateBroker(idx, "email", e.target.value)} placeholder="Email"
                  className="block w-full border-0 bg-transparent p-0 text-center text-[0.6rem] text-gray-500 placeholder-gray-300 focus:outline-none focus:ring-0" />
              </div>
            ))}
            <button onClick={addBroker}
              className="edit-only inline-flex items-center gap-1 self-center text-[0.65rem] font-medium text-gray-400 transition-colors hover:text-red-600" style={{ marginTop: "0.75rem" }}>
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
              Add Broker
            </button>
          </div>
        </div>

        {/* ═══ Loan Comparison Table ═══ */}
        <div className="overflow-x-auto px-4 py-4">
          <table className="w-full border-collapse text-xs">
            <thead>
              {/* Group header row (with colspan for sub-columns) */}
              <tr>
                <th className="w-40 border-b-2 border-red-600 px-2 py-1.5 text-left text-gray-500" />
                {groups.map((g, gi) => (
                  <th key={g.id} colSpan={g.subColumns.length} className="border-b-2 border-red-600 px-1 py-1.5"
                    draggable onDragStart={() => handleDragStart(gi)} onDragOver={(e) => handleDragOver(e, gi)} onDragEnd={handleDragEnd}
                    style={{ cursor: "grab" }}>
                    <div className="flex items-center justify-center gap-1">
                      <span className="edit-only shrink-0 cursor-grab text-gray-300" title="Drag to reorder">
                        <svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor"><circle cx="5" cy="4" r="1.5"/><circle cx="11" cy="4" r="1.5"/><circle cx="5" cy="8" r="1.5"/><circle cx="11" cy="8" r="1.5"/><circle cx="5" cy="12" r="1.5"/><circle cx="11" cy="12" r="1.5"/></svg>
                      </span>
                      <EditableText value={g.name} onChange={(v) => renameGroup(g.id, v)} highlight
                        className="text-center text-[0.7rem] font-bold uppercase tracking-wide text-red-700" />
                      {groups.length > 1 && (
                        <button onClick={() => removeGroup(g.id)}
                          className="edit-only flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-gray-300 hover:bg-red-100 hover:text-red-500" title="Remove column group">
                          <svg width="8" height="8" viewBox="0 0 16 16" fill="none"><path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg>
                        </button>
                      )}
                    </div>
                  </th>
                ))}
                {/* Add group button as a column */}
                <th className="edit-only w-8 border-b-2 border-gray-200 px-1 py-1.5 align-middle">
                  <button onClick={addGroup} title="Add column group"
                    className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 text-gray-400 transition-colors hover:bg-red-100 hover:text-red-600">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                  </button>
                </th>
              </tr>
              {/* Sub-column name row */}
              <tr className="bg-gray-50">
                <th className="px-2 py-1.5 text-left text-[0.65rem] font-medium text-gray-400" />
                {groups.map((g) => g.subColumns.map((s) => (
                  <th key={s.id} className="px-1 py-1">
                    <div className="flex items-center justify-center gap-0.5">
                      <EditableText value={s.name} onChange={(v) => renameSubColumn(s.id, v)} highlight
                        className="text-center text-gray-700" />
                      {g.subColumns.length > 1 && (
                        <button onClick={() => removeSubColumn(g.id, s.id)}
                          className="edit-only flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-gray-300 hover:bg-red-100 hover:text-red-500" title="Remove sub-column">
                          <svg width="6" height="6" viewBox="0 0 16 16" fill="none"><path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>
                        </button>
                      )}
                    </div>
                  </th>
                )))}
                <th className="edit-only w-8" />
              </tr>
              {/* Add sub-column buttons row */}
              <tr className="edit-only">
                <th className="px-2 py-0.5" />
                {groups.map((g) => (
                  <th key={g.id} colSpan={g.subColumns.length} className="px-1 py-0.5">
                    <button onClick={() => addSubColumn(g.id)}
                      className="mx-auto flex items-center gap-0.5 rounded-full bg-gray-50 px-2 py-0.5 text-[0.6rem] text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500">
                      <svg width="8" height="8" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                      sub
                    </button>
                  </th>
                ))}
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {TABLE_ROWS.map((row) => {
                // Total Monthly row (at the bottom, bold)
                if (row.key === "totalMonthly") {
                  return (
                    <tr key={row.key} className="border-t-2 border-gray-300 bg-red-50">
                      <td className="px-2 py-2 text-xs font-bold text-red-800">{row.label}</td>
                      {allSubs.map((s) => (
                        <td key={s.id} className="px-2 py-2 text-center text-xs font-bold text-red-800">
                          {totalMonthly(s) != null ? "$" + totalMonthly(s)!.toLocaleString() : "\u2014"}
                        </td>
                      ))}
                      <td className="edit-only w-8" />
                    </tr>
                  );
                }

                const isRate = row.isRateRow;

                return (
                  <tr key={row.key} className={`border-b border-gray-100 ${isRate ? "bg-red-50/60" : ""}`}>
                    <td className={`px-2 py-1.5 text-xs ${row.isBold || isRate ? "font-bold text-gray-800" : "text-gray-600"}`}>
                      {row.label}
                      {row.tooltip && (
                        <span className="edit-only group/tip relative ml-1 inline-flex cursor-help text-gray-400 hover:text-gray-600">
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="inline"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5"/><path d="M6.5 6a1.5 1.5 0 013 0c0 1-1.5 1-1.5 2M8 11h.01" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                          <span className="pointer-events-none absolute bottom-full left-0 z-[100] mb-1.5 hidden w-52 rounded-md bg-gray-800 px-2.5 py-1.5 text-[10px] leading-snug text-white shadow-lg group-hover/tip:block">
                            {row.tooltip}
                            <span className="absolute left-2 top-full border-4 border-transparent border-t-gray-800" />
                          </span>
                        </span>
                      )}
                    </td>
                    {allSubs.map((s) => (
                      <td key={s.id} className="px-1 py-0.5 text-center">
                        {row.editable ? (
                          <EditableCell
                            value={s[row.field] as number | null}
                            onChange={(v) => updateField(s.id, row.field, v)}
                            format={row.format}
                            highlight
                            bold={!!isRate}
                          />
                        ) : (
                          <div className={`px-1.5 py-0.5 text-right text-xs ${row.isBold ? "font-bold text-red-800" : "text-gray-700"}`}>
                            {(s[row.field] as number | null) != null ? "$" + (s[row.field] as number).toLocaleString() : "\u2014"}
                          </div>
                        )}
                      </td>
                    ))}
                    <td className="edit-only w-8" />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* ── Footer Disclaimer ── */}
        <div className="border-t border-gray-200 bg-blue-50 px-6 py-3">
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[0.65rem] font-bold text-white">i</div>
            <p className="text-[0.7rem] font-medium leading-relaxed text-gray-700">
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
// Disclaimer text
// ---------------------------------------------------------------------------

const DISC_BODY = `Interest rates and annual percentage rates (APRs) are based on current market rates, are for informational purposes only, are subject to change without notice and may be subject to pricing add-ons related to property type, loan amount, loan-to-value, credit score and other variables\u2014call for details. This is not a credit decision or a commitment to lend. Depending on loan guidelines, mortgage insurance may be required. If mortgage insurance is required, the mortgage insurance premium could increase the APR and the monthly mortgage payment. Additional loan programs may be available.

APR reflects the effective cost of your loan on a yearly basis, considering such items as interest, most closing costs, discount points (also referred to as \u201cpoints\u201d) and loan-origination fees. One point is 1% of the mortgage amount (e.g., $1,000 on a $100,000 loan). Your monthly payment is not based on APR, but instead on the interest rate on your note.

Adjustable-rate mortgage (ARM) rates assume no increase in the financial index after the initial fixed period. ARM rates and monthly payments are subject to increase after the fixed period: ARMs assume 30-year term.

Programs are subject to change without notice. Additional conditions may apply. All Loans are subject to underwriting approval & credit review. This does not represent credit approval.`;

const DISC_LIC = `General Mortgage Capital Corporation: 1350 Bayshore Hwy Ste 740, Burlingame CA 94010: Ph: 866-462-2929 (866-GMCC-WAY) and 650-340-7800 / Email: info@gmccloan.com; NMLS \u2013 254895 / CFL: 60DBO-66060

Real Estate Broker, CA Department of Real Estate: CA DRE: 01509029  Disclosures and Licensing: https://www.gmccloan.com/Disclosures.html  For all state licensing information go to: www.nmlsconsumeraccess.org  Licensed by The Department of Financial Protection and Innovation under the California Finance Lenders Act; Licensed by the NJ Dept of Banking and Insurance; Licensed Mortgage Banker-NYS Department of Financial Services  Rhode Island Licensed Lender

Texas: Any consumer complaints please click below https://www.sml.texas.gov/wp-content/uploads/2021/07/rmlo_81_200_c_recovery_fund_notice.pdf
Illinois: https://www.ilga.gov/legislation/ilcs/ilcs5.asp?ActID=1196&ChapterID=20`;
