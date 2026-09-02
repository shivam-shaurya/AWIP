// One-off, non-destructive backfill: assigns a real ward name to every
// currently-seeded employee whose `ward` column is still null. Does NOT
// delete or reset anything — only sets one previously-unused column, unlike
// prisma/seed.js's `main()` which wipes and rebuilds the whole database.
//
// Ward/zone/area data is the same real AMC civic-audit figures used in
// prisma/seed.js's WARD_AREAS (kept as a small duplicate here rather than an
// import, since seed.js is a run-once script, not a shared module).
import { prisma } from '../db.js';

const WARD_AREAS = [
  { name: "Khadia", zone: "Central", areaSqKm: 3.26 },
  { name: "Saraspur-Rakhial", zone: "North", areaSqKm: 3.39 },
  { name: "Thakkarbapanagar", zone: "North", areaSqKm: 3.48 },
  { name: "Navrangpura", zone: "West", areaSqKm: 11.98 },
  { name: "Chandkheda", zone: "West", areaSqKm: 11.90 },
  { name: "Bodakdev", zone: "North-West", areaSqKm: 13.78 },
  { name: "Thaltej", zone: "North-West", areaSqKm: 32.18 },
  { name: "Gota", zone: "North-West", areaSqKm: 30.00 },
  { name: "Bhaipura-Hatkeshwar", zone: "East", areaSqKm: 1.94 },
  { name: "Vastral", zone: "East", areaSqKm: 13.46 },
  { name: "Maktampura", zone: "South-West", areaSqKm: 26.20 },
  { name: "Lambha", zone: "South", areaSqKm: 44.54 },
];
const WARDS_BY_ZONE = new Map();
for (const w of WARD_AREAS) {
  if (!WARDS_BY_ZONE.has(w.zone)) WARDS_BY_ZONE.set(w.zone, []);
  WARDS_BY_ZONE.get(w.zone).push(w);
}
const WARD_DENSITY_DEPARTMENTS = new Set(["Solid Waste Management", "Drainage"]);

function weightedPick(items, weightFn) {
  const total = items.reduce((s, it) => s + weightFn(it), 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= weightFn(it);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

function pickWard(zone, department) {
  const wards = WARDS_BY_ZONE.get(zone);
  if (!wards || !wards.length) return null;
  const skewed = WARD_DENSITY_DEPARTMENTS.has(department);
  return weightedPick(wards, (w) => (skewed ? 1 / w.areaSqKm : w.areaSqKm)).name;
}

async function main() {
  const employees = await prisma.employee.findMany({
    where: { ward: null },
    select: { id: true, zone: true, department: true },
  });
  console.log(`Backfilling ward for ${employees.length} employee(s) with ward = null...`);

  const BATCH = 50;
  let updated = 0;
  for (let i = 0; i < employees.length; i += BATCH) {
    const batch = employees.slice(i, i + BATCH);
    await Promise.all(batch.map(async (e) => {
      if (!e.zone) return;
      const ward = pickWard(e.zone, e.department);
      if (!ward) return;
      await prisma.employee.update({ where: { id: e.id }, data: { ward } });
      updated++;
    }));
    if ((i / BATCH) % 20 === 0) console.log(`  ...${Math.min(i + BATCH, employees.length)}/${employees.length}`);
  }
  console.log(`Done. Updated ${updated} employee(s).`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
