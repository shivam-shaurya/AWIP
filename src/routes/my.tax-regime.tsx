import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Percent, Info } from "lucide-react";
import { Section, Panel, Pill } from "@/components/layout/section";
import { coreApi } from "@/lib/api-client";
import { useAuth } from "@/context/auth-context";

export const Route = createFileRoute("/my/tax-regime")({
  head: () => ({ meta: [{ title: "Tax Regime · AWIP" }] }),
  component: MyTaxRegimePage,
});

function inr(n: number) {
  return `₹${Math.round(Math.max(0, n)).toLocaleString("en-IN")}`;
}

// Simplified illustrative slabs (individual, non-senior, excludes cess and
// rebate nuances) — for comparison purposes only, not a filing calculation.
const STANDARD_DEDUCTION = 50000;

function taxFromSlabs(taxableIncome: number, slabs: { upto: number; rate: number }[]) {
  let remaining = Math.max(0, taxableIncome);
  let tax = 0;
  let prevUpto = 0;
  for (const slab of slabs) {
    const band = Math.min(remaining, slab.upto - prevUpto);
    if (band > 0) tax += band * slab.rate;
    remaining -= band;
    prevUpto = slab.upto;
    if (remaining <= 0) break;
  }
  return tax;
}

const NEW_REGIME_SLABS = [
  { upto: 300000, rate: 0 },
  { upto: 600000, rate: 0.05 },
  { upto: 900000, rate: 0.10 },
  { upto: 1200000, rate: 0.15 },
  { upto: 1500000, rate: 0.20 },
  { upto: Infinity, rate: 0.30 },
];

const OLD_REGIME_SLABS = [
  { upto: 250000, rate: 0 },
  { upto: 500000, rate: 0.05 },
  { upto: 1000000, rate: 0.20 },
  { upto: Infinity, rate: 0.30 },
];

function MyTaxRegimePage() {
  const { user } = useAuth();
  const employeeId = user?.employeeId ?? "";

  const { data: e, isLoading: empLoading } = useQuery({
    queryKey: ["employee", employeeId],
    queryFn: () => coreApi.getEmployee(employeeId),
    enabled: !!employeeId,
  });
  const { data: compliance, isLoading: compLoading } = useQuery({
    queryKey: ["employee-compliance", employeeId],
    queryFn: () => coreApi.getEmployeeCompliance(employeeId),
    enabled: !!employeeId,
  });

  const comp = e?.compensation as { grossPay: number } | undefined;
  const annualGrossDefault = comp ? comp.grossPay * 12 : 0;
  const annualTds = compliance?.tdsMonthlyDeduction ? compliance.tdsMonthlyDeduction * 12 : 0;

  const [annualGross, setAnnualGross] = useState(0);
  const [oldRegimeDeductions, setOldRegimeDeductions] = useState(0);
  useEffect(() => { if (annualGrossDefault) setAnnualGross(annualGrossDefault); }, [annualGrossDefault]);

  const { newTax, oldTax } = useMemo(() => {
    const newTaxable = Math.max(0, annualGross - STANDARD_DEDUCTION);
    const oldTaxable = Math.max(0, annualGross - STANDARD_DEDUCTION - oldRegimeDeductions);
    return {
      newTax: taxFromSlabs(newTaxable, NEW_REGIME_SLABS),
      oldTax: taxFromSlabs(oldTaxable, OLD_REGIME_SLABS),
    };
  }, [annualGross, oldRegimeDeductions]);

  const isLoading = empLoading || compLoading;
  const cheaper = newTax <= oldTax ? "New Regime" : "Old Regime";

  return (
    <div className="min-h-full bg-gradient-to-br from-background via-background to-primary-soft/40 px-5 py-4 max-w-3xl mx-auto">
      <div className="flex items-center gap-2 mb-4">
        <div className="size-9 rounded-lg bg-primary/10 text-primary grid place-items-center"><Percent className="size-4.5" /></div>
        <div>
          <div className="text-lg font-semibold tracking-tight">Tax Regime Comparison</div>
          <div className="text-xs text-muted-foreground">Old vs New regime — illustrative estimate</div>
        </div>
      </div>

      <div className="rounded-lg bg-info/10 border border-info/30 p-3 mb-5 flex items-start gap-2 text-xs text-muted-foreground">
        <Info className="size-3.5 text-info shrink-0 mt-0.5" />
        <span>This is a simplified, illustrative comparison using standard slabs and a flat standard deduction — it excludes cess, rebates, and every deduction category, and is not a substitute for actual tax filing advice.</span>
      </div>

      {isLoading ? (
        <div className="p-10 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading your salary details…
        </div>
      ) : (
        <>
          <Panel className="space-y-3 mb-5">
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Annual Gross Pay</label>
              <input
                type="number"
                value={annualGross}
                onChange={(ev) => setAnnualGross(Number(ev.target.value) || 0)}
                className="mt-1 h-9 w-full px-2 rounded-md bg-surface border border-border text-sm focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
              <div className="text-[10px] text-muted-foreground mt-1">Prefilled from your compensation record ({inr(annualGrossDefault)}/yr) — edit to try other scenarios.</div>
            </div>
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Old Regime Deductions (80C, 80D, HRA, etc.)</label>
              <input
                type="number"
                value={oldRegimeDeductions}
                onChange={(ev) => setOldRegimeDeductions(Number(ev.target.value) || 0)}
                className="mt-1 h-9 w-full px-2 rounded-md bg-surface border border-border text-sm focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
              <div className="text-[10px] text-muted-foreground mt-1">Old regime allows these; new regime doesn't — enter your total to see its real impact.</div>
            </div>
          </Panel>

          <Section title="Comparison">
            <div className="grid grid-cols-2 gap-3 mb-3">
              <Panel className={cheaper === "New Regime" ? "ring-2 ring-success/60" : ""}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold">New Regime</span>
                  {cheaper === "New Regime" && <Pill tone="success">Lower Tax</Pill>}
                </div>
                <div className="text-2xl font-bold tabular-nums">{inr(newTax)}</div>
                <div className="text-[10px] text-muted-foreground mt-1">Estimated annual tax · standard deduction only</div>
              </Panel>
              <Panel className={cheaper === "Old Regime" ? "ring-2 ring-success/60" : ""}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold">Old Regime</span>
                  {cheaper === "Old Regime" && <Pill tone="success">Lower Tax</Pill>}
                </div>
                <div className="text-2xl font-bold tabular-nums">{inr(oldTax)}</div>
                <div className="text-[10px] text-muted-foreground mt-1">Estimated annual tax · with your deductions above</div>
              </Panel>
            </div>
            <Panel>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Currently deducted (TDS on file, annualized)</span>
                <span className="font-semibold tabular-nums">{inr(annualTds)}</span>
              </div>
            </Panel>
          </Section>
        </>
      )}
    </div>
  );
}
