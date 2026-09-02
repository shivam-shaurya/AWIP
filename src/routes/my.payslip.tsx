import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Receipt } from "lucide-react";
import { Section, Panel } from "@/components/layout/section";
import { coreApi } from "@/lib/api-client";
import { useAuth } from "@/context/auth-context";

export const Route = createFileRoute("/my/payslip")({
  head: () => ({ meta: [{ title: "My Payslip · AWIP" }] }),
  component: MyPayslipPage,
});

function inr(n: number) {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

function MyPayslipPage() {
  const { user } = useAuth();
  const employeeId = user?.employeeId ?? "";

  const { data: e, isLoading: empLoading, isError: empError } = useQuery({
    queryKey: ["employee", employeeId],
    queryFn: () => coreApi.getEmployee(employeeId),
    enabled: !!employeeId,
  });
  const { data: compliance, isLoading: compLoading } = useQuery({
    queryKey: ["employee-compliance", employeeId],
    queryFn: () => coreApi.getEmployeeCompliance(employeeId),
    enabled: !!employeeId,
  });

  const comp = e?.compensation as { payGrade: string; basicPay: number; daPercent: number; daAmount: number; hraPercent: number; hraAmount: number; grossPay: number } | undefined;
  const isLoading = empLoading || compLoading;

  const pf = compliance?.pfMonthlyContribution ?? 0;
  const esic = compliance?.esicApplicable ? compliance?.esicMonthlyContribution ?? 0 : 0;
  const tds = compliance?.tdsMonthlyDeduction ?? 0;
  const totalDeductions = pf + esic + tds;
  const netPay = comp ? comp.grossPay - totalDeductions : 0;

  return (
    <div className="min-h-full bg-gradient-to-br from-background via-background to-primary-soft/40 px-5 py-4 max-w-3xl mx-auto">
      <div className="flex items-center gap-2 mb-4">
        <div className="size-9 rounded-lg bg-primary/10 text-primary grid place-items-center"><Receipt className="size-4.5" /></div>
        <div>
          <div className="text-lg font-semibold tracking-tight">My Payslip</div>
          <div className="text-xs text-muted-foreground">Current monthly salary slip</div>
        </div>
      </div>

      {isLoading ? (
        <div className="p-10 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading payslip…
        </div>
      ) : empError || !comp ? (
        <Panel><div className="text-sm text-destructive text-center py-6">No compensation record on file.</div></Panel>
      ) : (
        <Panel className="space-y-5">
          <div className="flex items-center justify-between pb-3 border-b border-border">
            <div>
              <div className="text-sm font-semibold">{e.name}</div>
              <div className="text-xs text-muted-foreground">{e.designation} · {e.department}</div>
            </div>
            <div className="text-right text-xs text-muted-foreground">
              <div>Pay Grade</div>
              <div className="font-semibold text-foreground">{comp.payGrade}</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <Section title="Earnings">
              <div className="space-y-1.5 text-sm">
                <Row label="Basic Pay" value={inr(comp.basicPay)} />
                <Row label={`DA (${comp.daPercent}%)`} value={inr(comp.daAmount)} />
                <Row label={`HRA (${comp.hraPercent}%)`} value={inr(comp.hraAmount)} />
                <Row label="Gross Pay" value={inr(comp.grossPay)} bold />
              </div>
            </Section>
            <Section title="Deductions">
              <div className="space-y-1.5 text-sm">
                <Row label="Provident Fund (PF)" value={inr(pf)} />
                {compliance?.esicApplicable && <Row label="ESIC" value={inr(esic)} />}
                <Row label="TDS" value={inr(tds)} />
                <Row label="Total Deductions" value={inr(totalDeductions)} bold />
              </div>
            </Section>
          </div>

          <div className="pt-3 border-t border-border flex items-center justify-between">
            <span className="text-sm font-semibold">Net Pay (this month)</span>
            <span className="text-xl font-bold text-success">{inr(netPay)}</span>
          </div>
        </Panel>
      )}
    </div>
  );
}

function Row({ label, value, bold = false }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${bold ? "font-semibold pt-1.5 border-t border-border/60" : "text-muted-foreground"}`}>
      <span>{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  );
}
