"use client";

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

export default function Pagination({
  currentPage,
  totalPages,
  onPageChange,
}: PaginationProps) {
  if (totalPages <= 1) return null;

  // Build page number window: show at most 5 pages centered on current
  const pages: (number | "...")[] = [];
  const maxVisible = 5;
  let start = Math.max(1, currentPage - Math.floor(maxVisible / 2));
  let end = Math.min(totalPages, start + maxVisible - 1);
  if (end - start + 1 < maxVisible) {
    start = Math.max(1, end - maxVisible + 1);
  }

  if (start > 1) {
    pages.push(1);
    if (start > 2) pages.push("...");
  }
  for (let i = start; i <= end; i++) pages.push(i);
  if (end < totalPages) {
    if (end < totalPages - 1) pages.push("...");
    pages.push(totalPages);
  }

  const btnBase =
    "inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors";
  const btnActive = "bg-blue-600 text-white";
  const btnInactive = "bg-white text-gray-700 hover:bg-gray-100 border border-gray-300";
  const btnDisabled = "text-gray-400 cursor-not-allowed";

  return (
    <nav className="flex items-center justify-center gap-1" aria-label="Pagination">
      <button
        className={`${btnBase} ${currentPage === 1 ? btnDisabled : btnInactive}`}
        disabled={currentPage === 1}
        onClick={() => onPageChange(currentPage - 1)}
      >
        &laquo; Prev
      </button>

      {pages.map((p, i) =>
        p === "..." ? (
          <span key={`ellipsis-${i}`} className="px-2 text-gray-400">
            ...
          </span>
        ) : (
          <button
            key={p}
            className={`${btnBase} ${p === currentPage ? btnActive : btnInactive}`}
            onClick={() => onPageChange(p)}
          >
            {p}
          </button>
        ),
      )}

      <button
        className={`${btnBase} ${currentPage === totalPages ? btnDisabled : btnInactive}`}
        disabled={currentPage === totalPages}
        onClick={() => onPageChange(currentPage + 1)}
      >
        Next &raquo;
      </button>
    </nav>
  );
}
