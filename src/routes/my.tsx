import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/my")({
  component: MyLayout,
});

function MyLayout() {
  return <Outlet />;
}
