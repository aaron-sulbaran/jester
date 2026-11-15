import { defineConfig } from "vite";
import { bankDevServer } from "./bank-dev-server.ts";

// The shell imports ../engine and ../spikes/pose-match directly, so the dev server may read the repo root.
export default defineConfig({
  base: "./",
  server: { port: 5173, fs: { allow: [".."] } },
  // Dev only: JESTER_BANK_DIR serves a local video bank folder at /bank (see bank-dev-server.ts).
  plugins: [bankDevServer(process.env.JESTER_BANK_DIR)],
  // Two pages in the build: the game and the online room page.
  build: { rollupOptions: { input: { main: "index.html", room: "room.html" } } },
});
