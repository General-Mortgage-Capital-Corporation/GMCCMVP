import { useState, useMemo, useEffect, useRef } from "react";

export function usePagination<T>(items: T[], perPage: number) {
  const [currentPage, setCurrentPage] = useState(1);
  const prevLengthRef = useRef(items.length);

  // Reset to page 1 whenever the result set changes size (new search / filter)
  useEffect(() => {
    if (prevLengthRef.current !== items.length) {
      setCurrentPage(1);
      prevLengthRef.current = items.length;
    }
  }, [items.length]);

  const totalPages = Math.max(1, Math.ceil(items.length / perPage));

  // Clamp currentPage so it never exceeds totalPages.
  // Without this, filtering from a large result set to a small one while
  // on a later page would produce an empty slice even though items exist.
  const safePage = Math.min(currentPage, totalPages);

  const paginatedItems = useMemo(() => {
    const start = (safePage - 1) * perPage;
    return items.slice(start, start + perPage);
  }, [items, safePage, perPage]);

  function setPage(page: number) {
    setCurrentPage(Math.max(1, Math.min(page, totalPages)));
  }

  // Expose safePage as currentPage so consumers always see the valid page number
  return { currentPage: safePage, totalPages, paginatedItems, setPage };
}
