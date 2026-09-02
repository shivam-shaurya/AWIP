import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapContainer, TileLayer, CircleMarker, Popup, Tooltip } from "react-leaflet";
import { BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer, CartesianGrid, Cell } from "recharts";
import "leaflet/dist/leaflet.css";
import "./ward-density-map.css";
import { coreApi } from "@/lib/api-client";
import { Panel, Pill } from "@/components/layout/section";
import { useUI } from "@/context/ui-context";
import { CHART_TOOLTIP_STYLE } from "@/lib/chart-theme";
import { Map as MapIcon, BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";

// Real zone-office coordinates (same source as the earlier Command Centre
// zone map this session — github.com/datameet/Municipal_Spatial_Data,
// Ahmedabad/Zonal_office.geojson). Ward-level GPS boundaries aren't
// available as public data, so each ward is placed at a small, deterministic
// offset from its real zone anchor for visual separation — an approximate
// placement anchored to a real point, not a claim of ward-precise boundaries.
const ZONE_ANCHORS: Record<string, [number, number]> = {
  Central: [23.021259, 72.5859],
  North: [23.0571147, 72.6334883],
  South: [22.998122, 72.603216],
  East: [23.026649, 72.639183],
  West: [23.047767, 72.570012],
  "North-West": [23.039006, 72.514347],
  "South-West": [22.985, 72.53],
};
// Deterministic per-ward offset (degrees) so multiple wards in the same zone
// don't render on top of each other.
const WARD_OFFSETS: Record<string, [number, number]> = {
  Khadia: [0, 0],
  "Saraspur-Rakhial": [0.012, -0.01],
  Thakkarbapanagar: [-0.012, 0.01],
  Navrangpura: [0.01, 0.008],
  Chandkheda: [-0.01, -0.008],
  Bodakdev: [0.014, 0.012],
  Thaltej: [-0.014, 0.014],
  Gota: [0.02, -0.016],
  "Bhaipura-Hatkeshwar": [0.008, 0.006],
  Vastral: [-0.01, -0.01],
  Maktampura: [-0.012, 0.01],
  Lambha: [0.014, -0.012],
};

const STATUS_COLOR: Record<string, string> = {
  Overstaffed: "#DC2626",
  Understaffed: "#2563EB",
  Balanced: "#16A34A",
};
const STATUS_TONE: Record<string, "destructive" | "info" | "success"> = {
  Overstaffed: "destructive",
  Understaffed: "info",
  Balanced: "success",
};

function markerRadius(density: number, max: number) {
  if (!max) return 10;
  const minR = 10, maxR = 30;
  return minR + (maxR - minR) * Math.sqrt(density / max);
}

const TILE_URLS = {
  light: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
  dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
};
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

export function WardDensityMap() {
  const { theme } = useUI();
  const [view, setView] = useState<"map" | "chart">("map");
  const { data, isLoading, isError } = useQuery({
    queryKey: ["ward-density"],
    queryFn: () => coreApi.getWardDensity(),
  });

  const wards = data?.data ?? [];
  const maxDensity = useMemo(() => wards.reduce((m, w) => Math.max(m, w.workersPerSqKm), 0), [wards]);

  return (
    <Panel className="px-4 pt-4 pb-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold">Spatial Workforce Allocation — Ward Density</h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Real ward areas from AMC's own civic audit — sanitation/drainage staff distribution shows the same
            small-ward-overstaffed pattern as the source data. Citywide average: <span className="tabular-nums font-medium">{data?.avgDensity ?? 0}</span> workers/sq km.
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-surface-muted p-0.5 shrink-0">
          <button
            onClick={() => setView("map")}
            className={cn("inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors", view === "map" ? "bg-card shadow-sm" : "text-muted-foreground")}
          >
            <MapIcon className="size-3" /> Map
          </button>
          <button
            onClick={() => setView("chart")}
            className={cn("inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors", view === "chart" ? "bg-card shadow-sm" : "text-muted-foreground")}
          >
            <BarChart3 className="size-3" /> Chart
          </button>
        </div>
      </div>

      {isError && <div className="text-xs text-destructive mb-2">Couldn't load ward density data.</div>}

      {isLoading ? (
        <div className="h-[340px] grid place-items-center text-xs text-muted-foreground">Loading ward data…</div>
      ) : view === "map" ? (
        <div className="ward-map-stack rounded-lg overflow-hidden border border-border" style={{ height: 340 }}>
          <MapContainer center={[23.0225, 72.5714]} zoom={11} scrollWheelZoom={false} style={{ height: "100%", width: "100%" }}>
            <TileLayer attribution={TILE_ATTRIBUTION} url={theme === "dark" ? TILE_URLS.dark : TILE_URLS.light} />
            {wards.map((w) => {
              const anchor = ZONE_ANCHORS[w.zone];
              const offset = WARD_OFFSETS[w.ward] ?? [0, 0];
              if (!anchor) return null;
              const center: [number, number] = [anchor[0] + offset[0], anchor[1] + offset[1]];
              const r = markerRadius(w.workersPerSqKm, maxDensity);
              return (
                <CircleMarker
                  key={w.ward}
                  center={center}
                  radius={r}
                  className="ward-marker-core"
                  color="#FFFFFF"
                  weight={2}
                  fillColor={STATUS_COLOR[w.status]}
                  fillOpacity={0.75}
                >
                  <Tooltip direction="top" offset={[0, -r - 4]} opacity={1}>
                    {w.ward} — {w.workersPerSqKm}/km² ({w.status})
                  </Tooltip>
                  <Popup minWidth={200}>
                    <div className="text-xs space-y-1">
                      <div className="font-semibold">{w.ward} ({w.zone} Zone)</div>
                      <div>{w.workerCount.toLocaleString("en-IN")} workers · {w.areaSqKm} sq km</div>
                      <div className="font-medium">{w.workersPerSqKm} workers/sq km</div>
                      <Pill tone={STATUS_TONE[w.status]}>{w.status}</Pill>
                    </div>
                  </Popup>
                </CircleMarker>
              );
            })}
          </MapContainer>
        </div>
      ) : (
        <div style={{ height: 340 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={wards} layout="vertical" margin={{ left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--color-border)" opacity={0.5} />
              <XAxis type="number" tick={{ fontSize: 10 }} />
              <YAxis type="category" dataKey="ward" width={130} tick={{ fontSize: 10 }} />
              <RTooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(v: number) => [`${v} workers/km²`, "Density"]} />
              <Bar dataKey="workersPerSqKm" radius={[0, 4, 4, 0]}>
                {wards.map((w) => <Cell key={w.ward} fill={STATUS_COLOR[w.status]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
              <th className="pb-1.5 pr-3">Ward</th>
              <th className="pb-1.5 pr-3">Zone</th>
              <th className="pb-1.5 pr-3 text-right">Workers</th>
              <th className="pb-1.5 pr-3 text-right">Area (km²)</th>
              <th className="pb-1.5 pr-3 text-right">Density</th>
              <th className="pb-1.5">Status</th>
            </tr>
          </thead>
          <tbody>
            {wards.map((w) => (
              <tr key={w.ward} className="border-b border-border/50 last:border-0">
                <td className="py-1.5 pr-3 font-medium">{w.ward}</td>
                <td className="py-1.5 pr-3 text-muted-foreground">{w.zone}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{w.workerCount.toLocaleString("en-IN")}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{w.areaSqKm}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums font-semibold">{w.workersPerSqKm}</td>
                <td className="py-1.5"><Pill tone={STATUS_TONE[w.status]}>{w.status}</Pill></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
