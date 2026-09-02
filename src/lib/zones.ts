export const ZONES = [
  "All Zones",
  "Central",
  "North",
  "South",
  "East",
  "West",
  "North-West",
  "South-West",
] as const;

export type Zone = (typeof ZONES)[number];
