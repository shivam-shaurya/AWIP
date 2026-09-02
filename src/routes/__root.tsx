import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  useNavigate,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { AppHeader } from "@/components/layout/app-header";
import { DepartmentProvider } from "@/context/department-context";
import { AuthProvider, useAuth } from "@/context/auth-context";
import { UIProvider } from "@/context/ui-context";
import { FloatingAssistant } from "@/components/ai/floating-assistant";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">The page you're looking for doesn't exist.</p>
        <div className="mt-6">
          <Link to="/" className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
            Go to Command Centre
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">This page didn't load</h1>
        <p className="mt-2 text-sm text-muted-foreground">Something went wrong. Try again or return home.</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => { router.invalidate(); reset(); }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Try again
          </button>
          <a href="/" className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent">
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "AWIP — AI Workforce Intelligence Platform · AMC" },
      { name: "description", content: "AI-powered Workforce Operating System for Ahmedabad Municipal Corporation." },
      { property: "og:title", content: "AWIP — AI Workforce Intelligence Platform" },
      { property: "og:description", content: "AI-powered Workforce Operating System for AMC." },
      { property: "og:type", content: "website" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en-IN">
      <head><HeadContent /></head>
      <body>{children}<Scripts /></body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <UIProvider>
        <AuthProvider>
          <DepartmentProvider>
            <AuthGate />
          </DepartmentProvider>
        </AuthProvider>
      </UIProvider>
    </QueryClientProvider>
  );
}

// Employee role is confined to its own 360 profile, the /my/* self-service
// pages, and the shared org calendar — everything else is HR/Dept-Head admin
// surface. The reverse (an admin wandering into /my/*) is blocked too, since
// those pages assume a linked employeeId an admin login may not have.
function isAllowedForRole(role: string, pathname: string, employeeId: string | null) {
  if (role !== "Employee") return !pathname.startsWith("/my/");
  return (
    pathname.startsWith("/my/") ||
    pathname.startsWith("/calendar") ||
    (employeeId != null && pathname.startsWith(`/employees/${employeeId}`))
  );
}

function AuthGate() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isLogin = pathname === "/login";

  useEffect(() => {
    if (!user && !isLogin) { navigate({ to: "/login" }); return; }
    if (user && !isLogin && !isAllowedForRole(user.role, pathname, user.employeeId)) {
      navigate({ to: user.role === "Employee" && user.employeeId ? `/employees/${user.employeeId}` : "/" });
    }
  }, [user, isLogin, pathname, navigate]);

  if (isLogin || !user) {
    return <Outlet />;
  }

  return (
    <div className="flex h-screen w-full bg-background text-foreground">
      <AppSidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <AppHeader />
        <main className="flex-1 overflow-y-auto scrollbar-thin">
          <Outlet />
        </main>
      </div>
      <FloatingAssistant />
    </div>
  );
}
