import { createContext, useContext, useState, type ReactNode } from "react";
import type { Department } from "@/lib/departments";
import type { Zone } from "@/lib/zones";

type Ctx = {
  department: Department;
  setDepartment: (d: Department) => void;
  zone: Zone;
  setZone: (z: Zone) => void;
};

const DepartmentContext = createContext<Ctx | null>(null);

export function DepartmentProvider({ children }: { children: ReactNode }) {
  const [department, setDepartment] = useState<Department>("All Departments");
  const [zone, setZone] = useState<Zone>("All Zones");
  return (
    <DepartmentContext.Provider value={{ department, setDepartment, zone, setZone }}>
      {children}
    </DepartmentContext.Provider>
  );
}

export function useDepartment() {
  const ctx = useContext(DepartmentContext);
  if (!ctx) throw new Error("useDepartment must be used within DepartmentProvider");
  return ctx;
}

export function filterByDept<T extends { department: string }>(items: T[], dept: string) {
  if (dept === "All Departments") return items;
  return items.filter((i) => i.department === dept);
}
