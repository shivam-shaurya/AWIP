import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  ShieldCheck,
  UserCog,
  Users2,
  User,
  Lock,
  Mail,
  ArrowRight,
  Eye,
  EyeOff,
  ShieldAlert,
  CheckCircle2
} from "lucide-react";
import { DEMO_CREDENTIALS, useAuth, ApiError, type Role, type AuthUser } from "@/context/auth-context";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Sign in · AWIP AMC" },
      { name: "description", content: "Sign in to AWIP — the workforce intelligence platform for Ahmedabad Municipal Corporation." },
    ],
  }),
  component: LoginPage,
});

// Types the headline out character by character on mount, like it's being
// keyed in live — skips straight to the full text for reduced-motion users
// instead of forcing them to sit through it.
function TypedHeadline({ text }: { text: string }) {
  const prefersReducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [count, setCount] = useState(prefersReducedMotion ? text.length : 0);

  useEffect(() => {
    if (prefersReducedMotion || count >= text.length) return;
    const t = setTimeout(() => setCount((c) => c + 1), 45);
    return () => clearTimeout(t);
  }, [count, text, prefersReducedMotion]);

  return (
    <h1 className="text-3xl font-semibold leading-tight tracking-tight min-h-[4.5rem]">
      {text.slice(0, count)}
      {count < text.length && (
        <span className="inline-block w-[2px] h-[0.85em] align-middle bg-primary-foreground/80 ml-0.5 animate-caret-blink" />
      )}
    </h1>
  );
}

const ROLE_META: Record<Role, { icon: typeof UserCog; tagline: string; scope: string; name: string }> = {
  "HR Admin": {
    icon: UserCog,
    name: "Meera Trivedi",
    tagline: "Workforce payroll, service-book & cadre authority",
    scope: "24 departments · 10,000 employees",
  },
  "Department Head": {
    icon: Users2,
    name: "Anil Shah",
    tagline: "Departmental approvals, postings & appraisal control",
    scope: "Engineering · 1,533 employees",
  },
  "Employee": {
    icon: User,
    name: "Employee Self-Service",
    tagline: "Your own attendance, leave, payslip & tasks",
    scope: "Personal access only",
  },
};

// Employee role lands straight on their own 360 profile instead of the
// admin-only Command Centre, which the route guard would bounce them from anyway.
function landingPathFor(u: AuthUser): string {
  return u.role === "Employee" && u.employeeId ? `/employees/${u.employeeId}` : "/";
}

function LoginPage() {
  const navigate = useNavigate();
  const { user, signIn } = useAuth();
  const [role, setRole] = useState<Role>("HR Admin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user) navigate({ to: landingPathFor(user) });
  }, [user, navigate]);

  const autofill = (r: Role) => {
    setRole(r);
    const p = DEMO_CREDENTIALS[r];
    setEmail(p.email);
    setPassword(p.password);
  };

  // Set initial preset autofill values on mount
  useEffect(() => {
    autofill("HR Admin");
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const signedInUser = await signIn(email, password);
      navigate({ to: landingPathFor(signedInUser) });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to reach the AWIP server. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen w-full grid lg:grid-cols-[1.1fr_1fr] bg-background text-foreground select-none">
      
      {/* Official AMC Brand panel — indigo ties directly to the product's own
          identity color instead of a disconnected navy/gold government theme */}
      <aside className="relative hidden lg:flex flex-col justify-between p-10 bg-primary text-primary-foreground overflow-hidden">

        {/* Single restrained glow, same soft-shadow language used app-wide */}
        <div className="absolute -bottom-24 -right-24 w-96 h-96 rounded-full pointer-events-none" style={{ background: "radial-gradient(circle, rgba(255,255,255,0.10), transparent 70%)" }} />

        {/* Shiny crystal-blue shimmer: a diagonal light sweep plus a few
            twinkling facet highlights, like light catching a faceted gem.
            Skipped entirely for reduced-motion users. */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden motion-reduce:hidden">
          <div className="absolute -inset-y-1/3 -inset-x-1/3 rotate-[18deg]">
            <div
              className="absolute inset-y-0 w-1/5 animate-shine-sweep"
              style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.28), transparent)" }}
            />
          </div>
          {[
            { top: "16%", left: "68%", delay: "0s" },
            { top: "52%", left: "18%", delay: "1.2s" },
            { top: "74%", left: "58%", delay: "2.1s" },
            { top: "32%", left: "40%", delay: "0.7s" },
            { top: "88%", left: "30%", delay: "1.7s" },
          ].map((s, i) => (
            <span
              key={i}
              className="absolute size-1 rounded-full bg-white/80 blur-[0.5px] animate-crystal-twinkle"
              style={{ top: s.top, left: s.left, animationDelay: s.delay }}
            />
          ))}
        </div>

        {/* Header - AMC Identity */}
        <div className="relative flex items-center gap-4">
          <div className="size-14 rounded-2xl bg-white grid place-items-center shrink-0 p-2 shadow-[0_8px_30px_rgba(0,0,0,0.15)]">
            <img src={import.meta.env.BASE_URL + "amc-logo.png"} alt="AMC seal" className="size-full object-contain" />
          </div>
          <div>
            <div className="text-[10px] uppercase font-semibold tracking-[0.2em] text-primary-foreground/70 leading-none">Ahmedabad Municipal Corporation</div>
            <div className="text-[11px] font-medium text-primary-foreground/60 mt-1">અમદાવાદ મ્યુનિસિપલ કોર્પોરેશન</div>
            <div className="text-sm font-semibold text-primary-foreground mt-0.5 tracking-wide">AWIP · Workforce Intelligence Platform</div>
          </div>
        </div>

        {/* Pitch / Slogan */}
        <div className="relative space-y-5 max-w-lg my-auto">
          <TypedHeadline text="One system of record for AMC's entire workforce." />

          <p className="text-sm text-primary-foreground/75 leading-relaxed">
            Personnel records, tasks, legal compliance and payroll — unified across all 24 departments, replacing scattered registers and spreadsheets with one live system.
          </p>

          {/* Real, verifiable numbers — not placeholder marketing stats */}
          <div className="grid grid-cols-3 gap-3 pt-2">
            {[
              { k: "Departments", v: "24", labelGu: "વિભાગો" },
              { k: "Employees", v: "10,000", labelGu: "કર્મચારીઓ" },
              { k: "Modules", v: "14", labelGu: "મોડ્યુલ" },
            ].map((s) => (
              <div key={s.k} className="rounded-xl bg-white/10 p-3.5">
                <div className="text-xl font-semibold tracking-wide">{s.v}</div>
                <div className="text-[10px] font-medium uppercase tracking-wider text-primary-foreground/70 mt-1 leading-none">{s.k}</div>
                <div className="text-[9px] text-primary-foreground/55 mt-1">{s.labelGu}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer - Security note */}
        <div className="relative text-[10px] text-primary-foreground/60 flex items-center gap-2 pt-4">
          <ShieldCheck className="size-4 text-primary-foreground/80" />
          <div>Every sign-in is logged and monitored for security and audit compliance.</div>
        </div>
      </aside>

      {/* Form panel */}
      <section className="flex items-center justify-center p-6 sm:p-12 bg-background">
        <div className="w-full max-w-md bg-card rounded-2xl shadow-[0_8px_40px_rgba(0,93,94,0.12)] p-6 sm:p-8 relative">

          {/* Small Mobile Logo */}
          <div className="lg:hidden flex items-center gap-3 mb-6 pb-4">
            <div className="size-10 rounded-xl bg-white grid place-items-center shrink-0 p-1.5 shadow-[0_4px_24px_rgba(0,93,94,0.12)]">
              <img src={import.meta.env.BASE_URL + "amc-logo.png"} alt="AMC" className="size-full object-contain" />
            </div>
            <div>
              <div className="text-[9px] font-semibold uppercase tracking-wider text-primary">Ahmedabad Municipal Corporation</div>
              <div className="text-xs font-bold text-foreground">AWIP Workforce Platform</div>
            </div>
          </div>

          <div className="space-y-1">
            <h2 className="text-xl font-semibold tracking-tight text-foreground">Sign in to AWIP</h2>
            <div className="text-[11px] font-medium text-muted-foreground">તમારા એકાઉન્ટમાં સાઇન ઇન કરો</div>
          </div>

          {/* Role selector tabs */}
          <div className="mt-6 space-y-2">
            <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">Select Operating Scope</label>
            <div className="grid grid-cols-3 gap-2.5">
              {(Object.keys(ROLE_META) as Role[]).map((r) => {
                const Icon = ROLE_META[r].icon;
                const active = role === r;
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => autofill(r)}
                    className={cn(
                      "text-left rounded-xl p-3 transition-all relative overflow-hidden",
                      active
                        ? "bg-primary/10 ring-2 ring-primary/30 shadow-[0_4px_24px_rgba(0,93,94,0.08)]"
                        : "bg-surface-muted hover:bg-surface-muted/70",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <div className={cn("size-7 rounded-lg grid place-items-center shrink-0", active ? "bg-primary text-primary-foreground" : "bg-surface-muted text-muted-foreground")}>
                        <Icon className="size-4" />
                      </div>
                      <div className="text-xs font-bold text-foreground truncate">{r}</div>
                    </div>
                    <div className="mt-2 text-[10px] text-muted-foreground leading-snug truncate">{ROLE_META[r].name}</div>
                    <div className="mt-1 text-[9px] font-bold uppercase tracking-wider text-primary/80 truncate">{ROLE_META[r].scope}</div>
                    
                    {active && (
                      <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Form */}
          <form onSubmit={submit} className="mt-6 space-y-4">
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">
                Official Email ID / સત્તાવાર ઇમેઇલ
              </label>
              <div className="relative">
                <Mail className="size-4.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="username@amc.gov.in"
                  className="w-full h-10 pl-10 pr-3 rounded-lg bg-surface-muted text-xs font-medium focus:outline-none focus:ring-2 focus:ring-ring/30"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">
                Security Password / પાસવર્ડ
              </label>
              <div className="relative">
                <Lock className="size-4.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full h-10 pl-10 pr-10 rounded-lg bg-surface-muted text-xs font-medium focus:outline-none focus:ring-2 focus:ring-ring/30"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>

            {/* Credential Helper Box */}
            {error ? (
              <div className="p-2.5 rounded-lg bg-destructive/10 flex items-start gap-2 text-[10.5px] leading-relaxed text-destructive">
                <ShieldAlert className="size-3.5 shrink-0 mt-0.5" />
                <div>{error}</div>
              </div>
            ) : (
              <div className="p-2.5 rounded-lg bg-surface-muted flex items-start gap-2 text-[10.5px] leading-relaxed text-muted-foreground">
                <CheckCircle2 className="size-3.5 text-success shrink-0 mt-0.5" />
                <div>
                  Demo credentials pre-filled for <span className="font-semibold text-foreground">{ROLE_META[role].name}</span>. Press Sign In to continue.
                </div>
              </div>
            )}

            <div className="flex items-center justify-between text-[11px] pt-1">
              <label className="inline-flex items-center gap-1.5 text-muted-foreground cursor-pointer">
                <input type="checkbox" className="size-3.5 rounded text-primary focus:ring-primary" defaultChecked /> Remember session
              </label>
              <a className="text-primary hover:underline font-semibold" href="#">Contact AMC IT Desk</a>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full h-10 inline-flex items-center justify-center gap-2 rounded-lg bg-primary text-primary-foreground text-xs font-bold hover:opacity-95 transition-all shadow-[0_4px_24px_rgba(0,93,94,0.15)] active:scale-[0.99] disabled:opacity-50"
            >
              {isSubmitting ? (
                <>Signing in…</>
              ) : (
                <>
                  Sign In <ArrowRight className="size-4" />
                </>
              )}
            </button>
          </form>

          {/* Security Notice Footer */}
          <div className="mt-6 pt-4 text-[10px] text-muted-foreground flex gap-2 items-start leading-relaxed">
            <ShieldAlert className="size-4 text-warning shrink-0 mt-0.5" />
            <div>
              <span className="font-bold text-foreground">Notice:</span> Unauthorized access to this system is prohibited and may be prosecuted under the IT Act, 2000.
            </div>
          </div>

        </div>
      </section>
    </div>
  );
}
export default LoginPage;
