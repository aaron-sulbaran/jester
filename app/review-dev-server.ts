// Dev server only: the review queue for Submit your own, behind the Chamberlain's desk (review.html).
// It holds the server-side keys, read by absolute path from the file JESTER_REVIEW_ENV points at (outside
// every repo, never a VITE_ setting, so they never reach a browser or a build). With the Supabase service
// role it reads pending submissions, streams their videos to the desk and writes each decision back to the
// row's status. With the Anthropic key it runs the Chamberlain (review-agent.ts). Decisions and their
// reasons go in jester-review-log.json beside that env file, since the table has no column for them.
//
// What leaves the laptop: the four frames, the analysis facts, and the submitter's title and credit go to
// Anthropic for each review. Nothing else does. Videos come down from Supabase and stay here.
//
// Routes under /__review, answered only to this dev server's own pages (Host must be localhost or
// 127.0.0.1, against DNS rebinding; and Sec-Fetch-Site same-origin or the x-jester-review header):
//   GET  status          which settings are missing, the model, the bank folder approvals must land in
//   GET  pending         pending submissions, each with its logged decision if it has one
//   GET  video?path=     one submission's video
//   POST judge           { title, credit, facts, frames } -> the Chamberlain's decision
//   POST decide          { id, video_path, title, status: "approved" | "rejected", by, reason, bankId? }
//   POST flag            { id, video_path, title, reason, ... } -> logged as waiting for a person
//   GET  log             the latest decisions
//   POST publish         publish the bank: runs deploy-bank.sh beside the bank folder a few seconds later
//
// Publishing: the public bank is its own small site, published by jester-deploy/deploy-bank.sh (about 20 s).
// It runs after every approval, and the bank lab asks for it after every clip it adds. Requests a few seconds
// apart share one run, and a run never overlaps another.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { createClient } from "@supabase/supabase-js";
import { readBankIndex } from "./src/bankIndex.ts";
import { DEFAULT_MODEL, reviewSubmission, type ReviewInput } from "./review-agent.ts";

const PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|webm|mov)$/;
const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BANK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const TYPES: Record<string, string> = { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" };
const MAX_BODY = 8 * 1024 * 1024;

interface Finding { from: string; text: string }
interface LogEntry {
  id: string;
  video_path: string;
  title: string | null;
  verdict: "approved" | "rejected" | "ask_a_person";
  by: "agent" | "aaron" | "check";
  reason: string;
  bankId?: string;
  steps?: string[];
  findings?: Finding[];
  framesCheck?: string;
  at: string;
}

/** KEY=VALUE lines; quotes around a value are dropped. Missing file: nothing. */
function readEnvFile(path: string | undefined): Record<string, string> {
  if (!path) return {};
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && m[2]) out[m[1]!] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("The request is too big.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("The request is not JSON.")); }
    });
    req.on("error", reject);
  });
}

/** This dev server's own pages only: a local Host (no rebinding), and a same-origin request or our header. */
function fromOurPage(req: IncomingMessage): boolean {
  if (!LOCAL_HOST.test(req.headers.host ?? "")) return false;
  return req.headers["sec-fetch-site"] === "same-origin" || req.headers["x-jester-review"] === "1";
}

const strings = (x: unknown): string[] | undefined => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string").slice(0, 20) : undefined);
const findingsOf = (x: unknown): Finding[] | undefined => (Array.isArray(x)
  ? x.filter((f): f is Finding => typeof f?.from === "string" && typeof f?.text === "string").slice(0, 10)
  : undefined);

export function reviewDevServer(options: { envFile: string | undefined; supabaseUrl: string | undefined }): Plugin {
  const bankDir = process.env.JESTER_BANK_DIR;
  const logPath = options.envFile ? join(dirname(options.envFile), "jester-review-log.json") : undefined;
  const readLog = (): LogEntry[] => {
    if (!logPath) return [];
    try { return JSON.parse(readFileSync(logPath, "utf8")) as LogEntry[]; } catch { return []; }
  };
  const addLog = (entry: Omit<LogEntry, "at">) => {
    if (!logPath) return;
    log.push({ ...entry, at: new Date().toISOString() });
    writeFileSync(logPath, JSON.stringify(log.slice(-500), null, 2) + "\n");
  };
  let log: LogEntry[] = [];
  // ---- Publishing the bank ----
  const publishScript = bankDir ? join(dirname(bankDir), "deploy-bank.sh") : undefined;
  const PUBLISH_DELAY_MS = 5000;
  let publish: { state: "idle" | "waiting" | "running" | "done" | "failed"; at: string | null; detail: string } = { state: "idle", at: null, detail: "" };
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  let publishing = false;
  let publishAgain = false;
  const now = () => new Date().toISOString();
  const runPublish = () => {
    if (!publishScript || !existsSync(publishScript)) {
      publish = { state: "failed", at: now(), detail: "There is no deploy-bank.sh beside the bank folder, so the bank was not published." };
      return;
    }
    if (publishing) { publishAgain = true; return; }
    publishing = true;
    publish = { state: "running", at: now(), detail: "Publishing the bank to the site..." };
    execFile("/bin/bash", [publishScript], { timeout: 180000 }, (err, stdout) => {
      publishing = false;
      const url = /https:\/\/[^\s"]*vercel\.app/.exec(String(stdout))?.[0];
      publish = err
        ? { state: "failed", at: now(), detail: "The bank did not publish. Run jester-deploy/deploy-bank.sh by hand." }
        : { state: "done", at: now(), detail: url ? `The bank is published (${url}).` : "The bank is published." };
      if (publishAgain) { publishAgain = false; schedulePublish(); }
    });
  };
  const schedulePublish = () => {
    clearTimeout(publishTimer);
    if (!publishing) publish = { state: "waiting", at: now(), detail: "Publishing the bank in a few seconds..." };
    publishTimer = setTimeout(runPublish, PUBLISH_DELAY_MS);
  };

  /** The project URL Vite loaded for the page (app/.env.local or the live site's public settings). */
  let pageUrl: string | undefined;

  /** Read on every request, so filling in the env file needs no restart. */
  const settings = () => {
    const env = readEnvFile(options.envFile);
    const url = env.SUPABASE_URL || options.supabaseUrl || pageUrl;
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
    const anthropicKey = env.ANTHROPIC_API_KEY;
    const model = env.JESTER_REVIEW_MODEL || DEFAULT_MODEL;
    const queueMissing = [
      ...(options.envFile ? [] : ["JESTER_REVIEW_ENV (the dev server was started without it)"]),
      ...(url ? [] : ["SUPABASE_URL"]),
      ...(serviceKey ? [] : ["SUPABASE_SERVICE_ROLE_KEY"]),
    ];
    const judgeMissing = anthropicKey ? [] : ["ANTHROPIC_API_KEY"];
    /** No key value may ever leave in a message, whatever the libraries put in their errors. */
    const scrub = (text: string) => [serviceKey, anthropicKey].reduce((t, k) => (k ? t.split(k).join("[key]") : t), text);
    return { url, serviceKey, anthropicKey, model, queueMissing, judgeMissing, scrub };
  };

  /** The bank's own index, so a row is marked approved only once its clip is really in the bank. */
  const inBank = (id: string): boolean => {
    if (!bankDir) return false;
    try {
      const read = readBankIndex(JSON.parse(readFileSync(join(bankDir, "index.json"), "utf8")));
      return read.error === null && read.data.some((c) => c.id === id);
    } catch {
      return false;
    }
  };

  return {
    name: "jester-review-dev",
    apply: "serve",
    configResolved(config) {
      pageUrl = config.env.VITE_SUPABASE_URL as string | undefined;
    },
    configureServer(server) {
      server.middlewares.use("/__review", async (req, res) => {
        const s = settings();
        const ok = (data: unknown) => send(res, 200, { data, error: null });
        const fail = (status: number, error: string) => send(res, status, { data: null, error: s.scrub(error) });
        if (!fromOurPage(req)) return fail(403, "Only the Chamberlain's desk may use the review queue.");
        const route = (req.url ?? "/").split("?")[0]!.replace(/^\/+/, "");
        const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
        log = readLog();
        try {
          if (route === "status") {
            return ok({
              missing: [...s.queueMissing, ...s.judgeMissing], canQueue: s.queueMissing.length === 0, canJudge: s.queueMissing.length === 0 && s.judgeMissing.length === 0,
              model: s.model, bankFolder: bankDir ? basename(bankDir) : null, envFile: options.envFile ? basename(options.envFile) : null,
              publish,
            });
          }
          if (route === "log") return ok(log.slice(-40).reverse());
          if (route === "publish" && req.method === "POST") {
            schedulePublish();
            return ok(publish);
          }
          if (s.queueMissing.length || !s.url || !s.serviceKey) return fail(503, `The review queue is missing: ${s.queueMissing.join(", ")}.`);
          const db = createClient(s.url, s.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

          if (route === "pending" && req.method === "GET") {
            const { data, error } = await db.from("submissions")
              .select("id, created_at, video_path, title, credit")
              .eq("status", "pending").order("created_at", { ascending: true }).limit(50);
            if (error) return fail(502, `Reading the queue failed: ${error.message}`);
            const last = (id: string) => [...log].reverse().find((e) => e.id === id) ?? null;
            return ok((data ?? []).map((row) => ({ ...row, logged: last(row.id as string) })));
          }

          if (route === "video" && req.method === "GET") {
            const path = query.get("path") ?? "";
            if (!PATH.test(path)) return fail(400, "That is not a submission's video.");
            const { data, error } = await db.storage.from("submissions").download(path);
            if (error || !data) return fail(404, "The video never arrived.");
            const bytes = Buffer.from(await data.arrayBuffer());
            res.statusCode = 200;
            res.setHeader("Content-Type", TYPES[path.split(".").pop()!] ?? "application/octet-stream");
            res.setHeader("Content-Length", String(bytes.length));
            res.setHeader("Cache-Control", "no-store");
            return res.end(bytes);
          }

          if (req.method !== "POST") return fail(404, "No such review route.");
          const body = (await readBody(req)) as Record<string, unknown>;

          if (route === "judge") {
            if (s.judgeMissing.length || !s.anthropicKey) return fail(503, `The Chamberlain is missing: ${s.judgeMissing.join(", ")}. You can still decide by hand.`);
            const input = body as unknown as ReviewInput;
            if (!input.facts || !Array.isArray(input.frames) || input.frames.length > 8) return fail(400, "The review needs the clip's facts and up to 8 frames.");
            try {
              return ok(await reviewSubmission(input, { apiKey: s.anthropicKey, model: s.model }));
            } catch (err) {
              return fail(502, `The Chamberlain could not run: ${(err as Error).message}`);
            }
          }

          const id = String(body.id ?? "");
          const videoPath = String(body.video_path ?? "");
          const title = typeof body.title === "string" ? body.title.slice(0, 80) : null;
          const reason = String(body.reason ?? "").slice(0, 600);
          if (!ROW_ID.test(id) || !PATH.test(videoPath)) return fail(400, "That is not a submission.");
          const extra = {
            ...(strings(body.steps) ? { steps: strings(body.steps)! } : {}),
            ...(findingsOf(body.findings) ? { findings: findingsOf(body.findings)! } : {}),
            ...(typeof body.framesCheck === "string" ? { framesCheck: body.framesCheck.slice(0, 600) } : {}),
          };

          if (route === "decide") {
            const status = body.status === "approved" ? "approved" : body.status === "rejected" ? "rejected" : null;
            const by = body.by === "aaron" ? "aaron" : body.by === "check" ? "check" : "agent";
            if (!status) return fail(400, "A decision is approved or rejected.");
            const bankId = typeof body.bankId === "string" && BANK_ID.test(body.bankId) ? body.bankId : null;
            if (status === "approved" && (!bankId || !inBank(bankId))) {
              return fail(409, bankDir
                ? `The clip is not in the bank folder "${basename(bankDir)}" this dev server serves, so it stays pending. Pick that folder on the desk.`
                : "This dev server was started without JESTER_BANK_DIR, so it cannot check the clip is in the bank.");
            }
            const { error } = await db.from("submissions").update({ status }).eq("id", id).eq("status", "pending");
            if (error) return fail(502, `Saving the decision failed: ${error.message}`);
            addLog({ id, video_path: videoPath, title, verdict: status, by, reason, ...(bankId ? { bankId } : {}), ...extra });
            if (status === "approved") schedulePublish();
            return ok({ id, status });
          }

          if (route === "flag") {
            addLog({ id, video_path: videoPath, title, verdict: "ask_a_person", by: "agent", reason, ...extra });
            return ok({ id });
          }

          return fail(404, "No such review route.");
        } catch (err) {
          return fail(500, `The review queue failed: ${(err as Error).message}`);
        }
      });
    },
  };
}
