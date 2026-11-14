import { defineConfig } from "vite";

// The shell imports ../engine and ../spikes/pose-match directly, so the dev server may read the repo root.
export default defineConfig({
  base: "./",
  server: { port: 5173, fs: { allow: [".."] } },
});
