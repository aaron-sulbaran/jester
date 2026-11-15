import { defineConfig, loadEnv } from "vite";
import { bankDevServer } from "./bank-dev-server.ts";

// Where a local run asks for the two public Supabase settings when it has no settings file of its own.
// Both values already ship inside the live page's code, so nothing secret travels here.
const LIVE_SETTINGS = "https://jester-pi.vercel.app/public-config.json";

/**
 * Rooms and Submit your own need VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. A run that already has them
 * (app/.env.local, or the deploy's environment) keeps them. Otherwise ask the live site once, so a fresh
 * clone works with no file passed around. With no network the app carries on in one browser only.
 */
async function publicSettings(mode: string): Promise<void> {
  const known = { ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env };
  if (known.VITE_SUPABASE_URL && known.VITE_SUPABASE_ANON_KEY) return;
  try {
    const response = await fetch(LIVE_SETTINGS, { signal: AbortSignal.timeout(4000) });
    const found = (await response.json()) as { supabaseUrl?: string; supabasePublishableKey?: string };
    if (!response.ok || !found.supabaseUrl || !found.supabasePublishableKey) throw new Error("no settings there");
    process.env.VITE_SUPABASE_URL = found.supabaseUrl;
    process.env.VITE_SUPABASE_ANON_KEY = found.supabasePublishableKey;
    console.log("Jester: Supabase settings taken from the live site (no app/.env.local here).");
  } catch {
    console.log("Jester: no Supabase settings found, so rooms work in this browser only and Submit your own is off.");
  }
}

// The shell imports ../engine and ../spikes/pose-match directly, so the dev server may read the repo root.
export default defineConfig(async ({ mode }) => {
  await publicSettings(mode);
  return {
    base: "./",
    server: { port: 5173, fs: { allow: [".."] } },
    // Dev only: JESTER_BANK_DIR serves a local video bank folder at /bank (see bank-dev-server.ts).
    plugins: [bankDevServer(process.env.JESTER_BANK_DIR)],
    // Two pages in the build: the game and the online room page.
    build: { rollupOptions: { input: { main: "index.html", room: "room.html" } } },
  };
});
