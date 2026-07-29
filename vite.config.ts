import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { execSync } from "node:child_process";

/**
 * A short, human-checkable identifier for the running build.
 *
 * Testing happens on a phone, where "is this actually the new version?" is
 * otherwise unanswerable — GitHub Pages, the service worker cache and the
 * installed PWA can each serve a stale bundle, and a fix that is already live
 * looks identical to one that never shipped. Surfacing the commit removes the
 * guesswork.
 */
function buildId(): string {
  try {
    const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    return sha || "dev";
  } catch {
    return "dev";
  }
}

export default defineConfig(({ mode }) => ({
  // GitHub Pages serves a project site from /<repo>/, so the production build
  // must be prefixed or every asset 404s. Dev is served from the root.
  base: mode === 'production' ? '/mathfallx/' : '/',
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [
    react(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
