import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Real elapsed time from a genuine timestamp — e.g. the notification bell's
// items, which used to carry fabricated strings like "10 mins ago" with no
// underlying date at all.
export function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

// Indian date convention (DD Mon YYYY) for the many backend fields that come
// through as plain "YYYY-MM-DD" strings — displaying those raw reads in ISO
// order, and the browser default locale used to render some as MM/DD.
export function formatDate(dateStr?: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr.length <= 10 ? `${dateStr}T00:00:00` : dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

// Same, for the "YYYY-MM" (month-only) fields like an employee's retirement window.
export function formatMonthYear(monthStr?: string | null): string {
  if (!monthStr) return "—";
  const d = new Date(`${monthStr}-01T00:00:00`);
  if (Number.isNaN(d.getTime())) return monthStr;
  return d.toLocaleDateString("en-IN", { month: "short", year: "numeric" });
}
