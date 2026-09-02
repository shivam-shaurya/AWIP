// Real weather data for Ahmedabad (AWIP only covers this one city, so a
// single lat/long is sufficient — no per-zone geocoding data exists/is
// needed). Backs the Weather Staff Planner agent (agents.js) with actual
// rainfall instead of a hardcoded monsoon-months calendar check.
//
// Open-Meteo (https://open-meteo.com) — free, no API key required, no
// realistic rate-limit concern at this call volume. Chosen since AWIP has no
// other external paid API keys configured (server-ai only talks to a local
// Ollama model).
const AHMEDABAD_COORDS = { lat: 23.03, lon: 72.58 };

const FORECAST_URL =
  `https://api.open-meteo.com/v1/forecast?latitude=${AHMEDABAD_COORDS.lat}&longitude=${AHMEDABAD_COORDS.lon}` +
  `&daily=precipitation_sum&current=precipitation,weather_code&past_days=31&forecast_days=7&timezone=Asia%2FKolkata`;

// India Meteorological Department's published daily-rainfall intensity
// bands (mm/day) — real, cited thresholds, not invented for this app.
const IMD_BANDS = [
  { max: 2.4, label: 'No Rain' },
  { max: 15.5, label: 'Light Rain' },
  { max: 64.4, label: 'Moderate Rain' },
  { max: 115.5, label: 'Heavy Rain' },
  { max: Infinity, label: 'Very Heavy Rain' },
];
function classifyRainfall(mmPerDay) {
  return IMD_BANDS.find((b) => mmPerDay <= b.max).label;
}

// Cached in-memory so repeated agent ticks (or a manual force-run) within
// the same window don't hit the free API more than necessary.
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;
let cache = null; // { at: number, data: object }

async function fetchLive() {
  const res = await fetch(FORECAST_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Open-Meteo returned ${res.status}`);
  const json = await res.json();

  const todayKey = new Date().toISOString().slice(0, 10);
  const days = json.daily.time.map((date, i) => ({ date, mm: json.daily.precipitation_sum[i] }));
  const monthKey = todayKey.slice(0, 7); // "YYYY-MM"
  const monthToDate = days.filter((d) => d.date.startsWith(monthKey) && d.date <= todayKey);
  const next7Day = days.filter((d) => d.date > todayKey).slice(0, 7);

  const monthToDateRainMm = Math.round(monthToDate.reduce((s, d) => s + d.mm, 0) * 10) / 10;
  const next7DayForecastMm = Math.round(next7Day.reduce((s, d) => s + d.mm, 0) * 10) / 10;
  const recentDailyMax = Math.max(0, ...days.filter((d) => d.date <= todayKey).slice(-7).map((d) => d.mm));

  return {
    available: true,
    currentPrecipitationMm: json.current?.precipitation ?? 0,
    conditionLabel: classifyRainfall(Math.max(json.current?.precipitation ?? 0, recentDailyMax)),
    monthToDateRainMm,
    next7DayForecastMm,
    fetchedAt: new Date().toISOString(),
  };
}

export async function getAhmedabadWeather() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  try {
    const data = await fetchLive();
    cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    // Never fabricate a weather reading — callers must degrade gracefully
    // (lower confidence, explain data is unavailable) rather than guess.
    return { available: false, error: String(err?.message || err) };
  }
}
