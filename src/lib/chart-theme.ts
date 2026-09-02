// Shared recharts styling so Tasks/Legal/Analytics render with the same
// palette, tooltip chrome, and animation instead of each page inventing
// its own slightly-different variant.
export const CHART_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
  "var(--color-primary)",
  "var(--color-success)",
];

export const CHART_TOOLTIP_STYLE = {
  backgroundColor: "var(--color-popover)",
  border: "none",
  borderRadius: "8px",
  boxShadow: "0 4px 24px rgba(0,93,94,0.12)",
  fontSize: "12px",
  color: "var(--color-popover-foreground)",
};

// Snappy, consistent easing for every chart — recharts defaults to a
// slower, less springy animation with no easing configured.
export const CHART_ANIMATION = {
  isAnimationActive: true,
  animationDuration: 400,
  animationEasing: "ease-out" as const,
};
