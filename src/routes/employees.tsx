import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/employees")({
  component: EmployeesLayout,
});

function EmployeesLayout() {
  return <Outlet />;
}
