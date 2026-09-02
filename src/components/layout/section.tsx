import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Section({
  title,
  subtitle,
  action,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-3", className)}>
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight uppercase text-foreground/80">{title}</h2>
          {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Panel({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={cn(
        "bg-card rounded-xl border border-border shadow-sm",
        padded && "p-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Pill({
  tone = "neutral",
  children,
  className,
}: {
  tone?: "neutral" | "success" | "warning" | "destructive" | "info" | "primary";
  children: ReactNode;
  className?: string;
}) {
  const cls = {
    neutral: "bg-muted text-muted-foreground",
    success: "bg-success/10 text-success",
    warning: "bg-warning/15 text-warning-foreground",
    destructive: "bg-destructive/10 text-destructive",
    info: "bg-info/10 text-info",
    primary: "bg-primary/10 text-primary",
  }[tone];
  return (
    <span className={cn("inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium whitespace-nowrap", cls, className)}>
      {children}
    </span>
  );
}
