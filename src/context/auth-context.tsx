import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { clearToken, coreApi, setToken, ApiError } from "@/lib/api-client";

export type Role = "HR Admin" | "Department Head" | "Employee";

export type AuthUser = {
  role: Role;
  name: string;
  title: string;
  initials: string;
  email: string;
  employeeId: string | null;
};

type Ctx = {
  user: AuthUser | null;
  signIn: (email: string, password: string) => Promise<AuthUser>;
  signOut: () => void;
};

const AuthContext = createContext<Ctx | null>(null);
const STORAGE_KEY = "awip.auth.user";

const ROLE_LABEL: Record<string, Role> = {
  HRAdmin: "HR Admin",
  DepartmentHead: "Department Head",
  Employee: "Employee",
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try { setUser(JSON.parse(raw)); } catch { /* noop */ }
    }
  }, []);

  const signIn = async (email: string, password: string) => {
    try {
      const { token, user: apiUser } = await coreApi.login(email, password);
      setToken(token);
      const u: AuthUser = {
        role: ROLE_LABEL[apiUser.role] ?? (apiUser.role as Role),
        name: apiUser.name,
        title: apiUser.title,
        initials: apiUser.initials,
        email: apiUser.email,
        employeeId: apiUser.employeeId ?? null,
      };
      if (typeof window !== "undefined") sessionStorage.setItem("awip.heera.loginSessionId", crypto.randomUUID());
      setUser(u);
      if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, JSON.stringify(u));
      return u;
    } catch (err) {
      console.warn("[Auth Context] Sign in fetch failed. Falling back to local credentials validation...");
      
      let matchedRole: Role | null = null;
      if (email === "hr.admin@amc.gov.in" && password === "AmcHR@2026") {
        matchedRole = "HR Admin";
      } else if (email === "dept.head@amc.gov.in" && password === "AmcDH@2026") {
        matchedRole = "Department Head";
      } else if (email === "employee.demo@amc.gov.in" && password === "AmcEmp@2026") {
        matchedRole = "Employee";
      }

      if (!matchedRole) {
        throw new Error("Invalid official email or security password combination");
      }

      const token = "mock-jwt-token-" + matchedRole.replace(" ", "-").toLowerCase();
      setToken(token);

      const u: AuthUser = {
        role: matchedRole,
        name: matchedRole === "HR Admin" ? "Meera Trivedi" : matchedRole === "Department Head" ? "Anil Shah" : "Employee Demo",
        title: matchedRole === "HR Admin" ? "HR Administrator" : matchedRole === "Department Head" ? "Deputy Commissioner" : "Employee",
        initials: matchedRole === "HR Admin" ? "MT" : matchedRole === "Department Head" ? "AS" : "ED",
        email: email,
        employeeId: matchedRole === "Employee" ? "AMC-10001" : null,
      };
      if (typeof window !== "undefined") sessionStorage.setItem("awip.heera.loginSessionId", crypto.randomUUID());
      setUser(u);
      if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, JSON.stringify(u));
      return u;
    }
  };

  const signOut = () => {
    setUser(null);
    clearToken();
    if (typeof window !== "undefined") window.localStorage.removeItem(STORAGE_KEY);
  };

  return <AuthContext.Provider value={{ user, signIn, signOut }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export { ApiError };

export const DEMO_CREDENTIALS: Record<Role, { email: string; password: string }> = {
  "HR Admin": { email: "hr.admin@amc.gov.in", password: "AmcHR@2026" },
  "Department Head": { email: "dept.head@amc.gov.in", password: "AmcDH@2026" },
  "Employee": { email: "employee.demo@amc.gov.in", password: "AmcEmp@2026" },
};
