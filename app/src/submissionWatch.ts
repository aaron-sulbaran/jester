// "Your clip is in": after a player sends a clip with Submit your own, this tab watches the public bank, and
// when the Chamberlain (or a person at the desk) lets that clip in, the same session hears about it and can
// play it. No login and no push: what was sent is remembered in this tab only (sessionStorage), by the clip's
// fingerprint, the SHA-256 of its file. Every bank clip's id ends in the start of that fingerprint
// (bankIdFor in bankIndex.ts), and its saved guides carry all of it, so the match is exact.

import { sha256Hex } from "./clipside/fingerprint.ts";
import { loadBankGuides, refreshBank, type BankClip } from "./bank.ts";

const KEY = "jester.submitted";
const POLL_MS = 20000;
/**
 * Stop watching a clip after an hour: one that was turned away never joins the bank, and the tab cannot see a
 * rejection, so it would otherwise keep reading the bank for nothing.
 */
const GIVE_UP_MS = 60 * 60 * 1000;

export interface Sent { fingerprint: string; title: string; at: number }

/** Bank clips whose id carries this fingerprint's first 6 characters: the only ones worth checking in full. */
export function candidates(clips: readonly Pick<BankClip, "id">[], fingerprint: string): string[] {
  const piece = fingerprint.toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 6);
  if (piece.length < 6) return [];
  // "<slug>-<hash>" with 6 or more hash characters, or "<slug>-<6 hash>-<n>" for a clip sent again and again.
  const ends = new RegExp(`-${piece}(?:[0-9a-f]*|-\\d+)$`);
  return clips.filter((c) => ends.test(c.id)).map((c) => c.id);
}

/** What this tab sent and has not yet seen let in, minus anything older than the watch lasts. */
export function stillWaiting(sent: readonly Sent[], now: number): Sent[] {
  return sent.filter((s) => typeof s.fingerprint === "string" && /^[0-9a-f]{64}$/.test(s.fingerprint) && now - s.at < GIVE_UP_MS);
}

function readSent(): Sent[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? (raw as Sent[]) : [];
  } catch {
    return [];
  }
}

function writeSent(sent: Sent[]) {
  try { sessionStorage.setItem(KEY, JSON.stringify(sent)); } catch { /* A private window may refuse: the watch then lasts this page only. */ }
}

let memory: Sent[] = [];

/** Remembers a clip this tab just sent, so the watch can recognise it in the bank. */
export async function rememberSubmission(file: File, title: string): Promise<void> {
  const fingerprint = await sha256Hex(file);
  memory = [...stillWaiting([...readSent(), ...memory], Date.now()).filter((s) => s.fingerprint !== fingerprint), { fingerprint, title, at: Date.now() }];
  writeSent(memory);
}

/**
 * Checks the bank every 20 seconds while this tab has a clip waiting, and calls `onReady` once for each one that
 * has joined it. With nothing waiting (none sent, all found, or older than an hour) it makes no request at all.
 * Returns a stop function.
 */
export function watchSubmissions(onReady: (clip: BankClip, sent: Sent) => void): () => void {
  let stopped = false;
  let checking = false;
  const check = async () => {
    if (stopped || checking) return;
    const waiting = stillWaiting([...readSent(), ...memory], Date.now());
    // Nothing waiting (none sent, all found, or older than an hour): no request at all.
    if (waiting.length === 0) return;
    checking = true;
    try {
      const bank = await refreshBank();
      if (bank.error !== null) return;
      const found: string[] = [];
      for (const s of waiting) {
        for (const id of candidates(bank.data, s.fingerprint)) {
          const clip = bank.data.find((c) => c.id === id)!;
          const guides = await loadBankGuides(clip);
          if (guides.error === null && guides.data.every((g) => g.fingerprint === s.fingerprint)) {
            found.push(s.fingerprint);
            onReady(clip, s);
            break;
          }
        }
      }
      if (found.length) {
        memory = waiting.filter((s) => !found.includes(s.fingerprint));
        writeSent(memory);
      }
    } finally {
      checking = false;
    }
  };
  // The timer stays so a clip sent later in this tab is watched too; while nothing waits it only reads sessionStorage.
  const timer = window.setInterval(() => void check(), POLL_MS);
  void check();
  return () => { stopped = true; clearInterval(timer); };
}
