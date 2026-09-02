import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

type FilterOption = string | { value: string; label: string };

function normalize(o: FilterOption): { value: string; label: string } {
  return typeof o === "string" ? { value: o, label: o } : o;
}

// Rounded-pill filter dropdown — the app-wide replacement for a plain native
// <select>. Shows a fixed category label until a non-default value is
// picked, then shows that value's label and tints teal, matching the
// Employee 360 filter bar this pattern was first built for.
export function FilterPill({ value, onChange, options, label, size = "default" }: {
  value: string; onChange: (v: string) => void; options: FilterOption[]; label: string; size?: "default" | "compact";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const normalized = options.map(normalize);
  const isDefault = value === normalized[0]?.value;
  const current = normalized.find((o) => o.value === value);
  const compact = size === "compact";

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "rounded-full border font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap",
          compact ? "h-8 pl-3 pr-2 text-[11px]" : "h-10 pl-4 pr-3 text-sm",
          isDefault ? "bg-card border-border text-foreground/80 hover:bg-surface-muted" : "bg-primary-soft border-primary/30 text-primary",
        )}
      >
        {isDefault ? label : (current?.label ?? value)}
        <ChevronDown className={cn(compact ? "size-3" : "size-3.5", "transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute z-20 mt-1.5 left-0 w-56 max-h-72 overflow-y-auto scrollbar-thin rounded-lg border border-border bg-popover shadow-md py-1">
          {normalized.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => { onChange(o.value); setOpen(false); }}
              className={cn(
                "w-full text-left px-3.5 py-1.5 text-sm hover:bg-surface-muted transition-colors",
                o.value === value ? "text-primary font-semibold" : "text-foreground",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
