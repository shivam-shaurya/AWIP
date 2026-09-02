import type { KeyboardEvent } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

// Rounded-full search input — the app-wide replacement for a plain bordered
// rounded-md search box, matching the Employee 360 search bar this pattern
// was first built for.
export function SearchPill({ value, onChange, placeholder, size = "default", className, onKeyDown }: {
  value: string; onChange: (v: string) => void; placeholder?: string; size?: "default" | "compact"; className?: string;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const compact = size === "compact";
  return (
    <div className={cn("relative", className)}>
      <Search className={cn(compact ? "size-3.5 left-3" : "size-4 left-4", "absolute top-1/2 -translate-y-1/2 text-muted-foreground")} />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className={cn(
          "w-full rounded-full bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-primary/40",
          compact ? "h-8 pl-9 pr-3 text-xs" : "h-10 pl-10 pr-4 text-sm",
        )}
      />
    </div>
  );
}
