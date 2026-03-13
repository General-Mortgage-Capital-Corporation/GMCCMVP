import type { ProgramResult } from "@/types";

interface ProgBadgeProps {
  prog: ProgramResult;
  compact?: boolean;
}

export default function ProgBadge({ prog, compact = false }: ProgBadgeProps) {
  const isBeta =
    prog.program_name.toLowerCase().includes("diamond") ||
    prog.program_name.toLowerCase().includes("beta");
  const colors =
    prog.status === "Eligible"
      ? "bg-emerald-50 text-emerald-800"
      : "bg-amber-50 text-amber-800";
  const size = compact
    ? "px-2 py-0.5 text-[0.7rem]"
    : "px-2.5 py-0.5 text-xs";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full font-medium ${size} ${colors}`}>
      {prog.program_name}
      {isBeta && (
        <span className="rounded bg-violet-600 px-1 text-[9px] font-bold uppercase leading-4 tracking-wide text-white">
          β
        </span>
      )}
    </span>
  );
}
