import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  // No caching config previously meant every query refetched on every mount
  // AND every window/tab focus — a large driver of unnecessary network
  // egress (heavy endpoints like /api/v1/employees were being re-fetched in
  // full just from switching tabs back to the app).
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        refetchOnWindowFocus: false,
      },
    },
  });

  // Mirror Vite's `base` (VITE_BASE_PATH at build time) so the app can be
  // served under a subpath (e.g. /awip/) behind a reverse proxy.
  const basepath = (import.meta.env.BASE_URL || "/").replace(/\/$/, "") || "/";

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    basepath,
  });

  return router;
};
