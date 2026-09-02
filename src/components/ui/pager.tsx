import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

// Windowed page numbers with ellipses — always shows first, last, current,
// and one neighbour on each side, so the control stays a fixed compact width
// no matter whether there are 3 pages or 200.
function pageWindow(page: number, totalPages: number): (number | "…")[] {
  const pages = new Set([1, totalPages, page, page - 1, page + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  const result: (number | "…")[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) result.push("…");
    result.push(p);
    prev = p;
  }
  return result;
}

// Shared pagination control — centered Prev/Next + numbered page window +
// a "Go to page" jump input. Used identically by Employee 360 and Task
// Management so every paginated list in the app behaves the same way.
export function Pager({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (p: number) => void }) {
  const [jumpValue, setJumpValue] = useState(String(page));
  useEffect(() => setJumpValue(String(page)), [page]);

  const commitJump = () => {
    const n = Number(jumpValue);
    if (Number.isFinite(n)) onChange(Math.min(totalPages, Math.max(1, Math.round(n))));
    else setJumpValue(String(page));
  };

  return (
    <div className="px-4 py-3 bg-surface-muted/30 flex flex-wrap items-center justify-center gap-1">
      <button
        onClick={() => onChange(Math.max(1, page - 1))}
        disabled={page <= 1}
        className="h-8 px-2.5 rounded-md bg-card text-xs font-medium shadow-[0_2px_10px_rgba(15,23,42,0.04)] hover:bg-surface-muted transition-colors inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <ChevronLeft className="size-3.5" /> Prev
      </button>

      {pageWindow(page, totalPages).map((p, i) =>
        p === "…" ? (
          <span key={`ellipsis-${i}`} className="px-1.5 text-xs text-muted-foreground">…</span>
        ) : (
          <button
            key={p}
            onClick={() => onChange(p)}
            className={cn(
              "h-8 min-w-8 px-2 rounded-md text-xs font-medium tabular-nums transition-colors",
              p === page ? "bg-primary text-primary-foreground" : "bg-card hover:bg-surface-muted shadow-[0_2px_10px_rgba(15,23,42,0.04)]",
            )}
          >
            {p}
          </button>
        ),
      )}

      <button
        onClick={() => onChange(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
        className="h-8 px-2.5 rounded-md bg-card text-xs font-medium shadow-[0_2px_10px_rgba(15,23,42,0.04)] hover:bg-surface-muted transition-colors inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Next <ChevronRight className="size-3.5" />
      </button>

      <span className="ml-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        Go to
        <input
          value={jumpValue}
          onChange={(e) => setJumpValue(e.target.value)}
          onBlur={commitJump}
          onKeyDown={(e) => e.key === "Enter" && commitJump()}
          className="h-8 w-14 px-1.5 rounded-md bg-card border border-border text-xs text-center tabular-nums focus:outline-none focus:ring-2 focus:ring-ring/30"
        />
        of {totalPages.toLocaleString("en-IN")}
      </span>
    </div>
  );
}
