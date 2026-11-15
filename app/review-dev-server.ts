// Dev server only: the review queue for Submit your own, for the bank lab's "Review submissions".
// It holds the two server-side keys (read from the file JESTER_REVIEW_ENV points at, never from a VITE_
// setting, so they never reach a browser), reads pending submissions with the Supabase service role, streams
// their videos to the lab, runs the reviewer agent (review-agent.ts), and writes each decision back to the
// row's status. Decisions and their reasons are also kept in a small log file next to that env file.
//
// Routes (all under /__review, answered only to the dev server's own pages):
//   GET  status          which settings are missing
//   GET  pending         pending submissions, each with its logged decision if it has one
//   GET  video?path=     one submission's video
//   POST judge           { title, credit, facts, frames } -> the agent's decision
//   POST decide          { id, video_path, title, status: "approved" | "rejected", by, reason, bankId? }
//   POST flag            { id, video_path, title, reason } -> logged as waiting for a person
//   GET  log             the latest decisions

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { createClient } from "@supabase/supabase-js";
import { reviewSubmission, type ReviewInput } from "./review-agent.ts";

const PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|webm|mov)$/;
const TYPES: Record<string, string> = { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" };
const MAX_BODY = 8 * 1024 * 1024;

interface LogEntry {
  id: string;
  video_path: string;
  title: string | null;
  verdict: "approved" | "rejected" | "ask_a_person";
  by: "agent" | "aaron" | "check";
  reason: string;
  bankId?: string;
  steps?: string[];
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
const ok = (res: ServerResponse, data: unknown) => send(res, 200, { data, error: null });
const fail = (res: ServerResponse, status: number, error: string) => send(res, status, { data: null, error });

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("too big")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

/** Only the dev server's own pages: same-origin fetches and video loads, or a request carrying our header. */
function fromOurPage(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  return site === "same-origin" || req.headers["x-jester-review"] === "1";
}

export function reviewDevServer(options: { envFile: string | undefined; supabaseUrl: string | undefined }): Plugin {
  const logPath = options.envFile ? join(dirname(options.envFile), "jester-review-log.json") : undefined;
  const readLog = (): LogEntry[] => {
    if (!logPath) return [];
    try { return JSON.parse(readFileSync(logPath, "utf8")) as LogEntry[]; } catch { return []; }
  };
  const addLog = (entry: Omit<LogEntry, "at">) => {
    if (!logPath) return;
    const log = readLog().filter((e) => !(e.id === entry.id && e.verdict === "ask_a_person" && entry.verdict !== "ask_a_person"));
    log.push({ ...entry, at: new Date().toISOString() });
    writeFileSync(logPath, JSON.stringify(log.slice(-500), null, 2) + "\n");
  };

  /** Read on every request, so filling in the env file needs no restart. */
  const settings = () => {
    const env = readEnvFile(options.envFile);
    const url = env.SUPABASE_URL || options.supabaseUrl;
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const anthropicKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    const missing = [
      ...(options.envFile ? [] : ["JESTER_REVIEW_ENV (the dev server was started without it)"]),
      ...(url ? [] : ["SUPABASE_URL"]),
      ...(serviceKey ? [] : ["SUPABASE_SERVICE_ROLE_KEY"]),
      ...(anthropicKey ? [] : ["ANTHROPIC_API_KEY"]),
    ];
    return { url, serviceKey, anthropicKey, missing };
  };
  const admin = (url: string, key: string) => createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  return {
    name: "jester-review-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__review", async (req, res) => {
        if (!fromOurPage(req)) return fail(res, 403, "Only the bank lab may use the review queue.");
        const route = (req.url ?? "/").split("?")[0]!.replace(/^\/+/, "");
        const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
        const s = settings();
        try {
          if (route === "status") return ok(res, { missing: s.missing, logFile: logPath ?? null });
          if (route === "log") return ok(res, readLog().slice(-40).reverse());
          if (s.missing.length || !s.url || !s.serviceKey || !s.anthropicKey) return fail(res, 503, `The reviewer is missing: ${s.missing.join(", ")}.`);
          const db = admin(s.url, s.serviceKey);

          if (route === "pending" && req.method === "GET") {
            const { data, error } = await db.from("submissions")
              .select("id, created_at, video_path, title, credit")
              .eq("status", "pending").order("created_at", { ascending: true }).limit(50);
            if (error) return fail(res, 502, `Reading the queue failed: ${error.message}`);
            const log = readLog();
            const last = (id: string) => [...log].reverse().find((e) => e.id === id) ?? null;
            return ok(res, (data ?? []).map((row) => ({ ...row, logged: last(row.id as string) })));
          }

          if (route === "video" && req.method === "GET") {
            const path = query.get("path") ?? "";
            if (!PATH.test(path)) return fail(res, 400, "That is not a submission's video.");
            const { data, error } = await db.storage.from("submissions").download(path);
            if (error || !data) return fail(res, 404, "The video never arrived.");
            const bytes = Buffer.from(await data.arrayBuffer());
            res.statusCode = 200;
            res.setHeader("Content-Type", TYPES[path.split(".").pop()!] ?? "application/octet-stream");
            res.setHeader("Content-Length", String(bytes.length));
            res.setHeader("Cache-Control", "no-store");
            return res.end(bytes);
          }

          if (req.method !== "POST") return fail(res, 404, "No such review route.");
          const body = (await readBody(req)) as Record<string, unknown>;

          if (route === "judge") {
            const input = body as unknown as ReviewInput;
            if (!input.facts || !Array.isArray(input.frames)) return fail(res, 400, "The review needs the clip's facts and frames.");
            try {
              return ok(res, await reviewSubmission(input, s.anthropicKey));
            } catch (err) {
              return fail(res, 502, `The reviewer could not run: ${(err as Error).message}`);
            }
          }

          const id = String(body.id ?? "");
          const videoPath = String(body.video_path ?? "");
          const title = typeof body.title === "string" ? body.title : null;
          const reason = String(body.reason ?? "");
          if (!/^[0-9a-f-]{36}$/.test(id)) return fail(res, 400, "That is not a submission.");

          if (route === "decide") {
            const status = body.status === "approved" ? "approved" : body.status === "rejected" ? "rejected" : null;
            const by = body.by === "aaron" ? "aaron" : body.by === "check" ? "check" : "agent";
            if (!status) return fail(res, 400, "A decision is approved or rejected.");
            const { error } = await db.from("submissions").update({ status }).eq("id", id);
            if (error) return fail(res, 502, `Saving the decision failed: ${error.message}`);
            addLog({ id, video_path: videoPath, title, verdict: status, by, reason, ...(typeof body.bankId === "string" ? { bankId: body.bankId } : {}), ...(Array.isArray(body.steps) ? { steps: body.steps as string[] } : {}) });
            return ok(res, { id, status });
          }

          if (route === "flag") {
            addLog({ id, video_path: videoPath, title, verdict: "ask_a_person", by: "agent", reason, ...(Array.isArray(body.steps) ? { steps: body.steps as string[] } : {}) });
            return ok(res, { id });
          }

          return fail(res, 404, "No such review route.");
        } catch (err) {
          return fail(res, 500, `The review queue failed: ${(err as Error).message}`);
        }
      });
    },
  };
}
