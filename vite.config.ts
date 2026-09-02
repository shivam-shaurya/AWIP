// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Optional subpath deploy (e.g. serving at https://host/awip/ behind nginx):
// set VITE_BASE_PATH=/awip/ at build time. Defaults to root for local dev.
const base = process.env.VITE_BASE_PATH || "/";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  // Production deploys run the SSR server on plain Node (Docker), not Cloudflare.
  // Set NITRO_PRESET=node-server at build time; default stays Cloudflare for Lovable.
  ...(process.env.NITRO_PRESET ? { nitro: { preset: process.env.NITRO_PRESET } } : {}),
  vite: { base },
});
