// Dev server only: the round log. Every app import of engine/src/index.ts is pointed at src/dev/roundTap.ts,
// which calls the real scorer, returns its result untouched, and afterwards posts the round here. Each round
// is saved to eval/data/rounds/<id>.json (git-ignored) with the commit and engine code that scored it.
// Nothing changes in a production build. JESTER_ROUND_LOG=0 turns it off.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { IncomingMessage } from "node:http";
import type { Plugin } from "vite";
import { looksLikeRecord, type RoundRecord } from "../eval/src/record.ts";

const MAX_BODY_BYTES = 40 * 1024 * 1024;

const clean = (id: string) => resolve(id.split("?")[0]!);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { fail(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

/** The commit, whether the engine has changes not in it, and a hash of the engine code as it is on disk now. */
function codeFacts(repo: string): NonNullable<RoundRecord["app"]> {
  const git = (...args: string[]) => {
    try { return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { return null; }
  };
  const commit = git("rev-parse", "HEAD");
  const status = git("status", "--porcelain", "--", "engine/src");
  let engineHash: string | null = null;
  try {
    const dir = join(repo, "engine", "src");
    const hash = createHash("sha1");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts")).sort()) hash.update(f).update(readFileSync(join(dir, f)));
    engineHash = hash.digest("hex").slice(0, 12);
  } catch {
    engineHash = null;
  }
  return { commit, dirty: status === null ? null : status.length > 0, engineHash };
}

export function roundLogDevServer(): Plugin {
  const enabled = process.env.JESTER_ROUND_LOG !== "0";
  let appRoot = "";
  let engineIndex = "";
  let engineDir = "";
  let tapFile = "";
  let roundsDir = "";
  return {
    name: "jester-round-log",
    apply: "serve",
    enforce: "pre",
    configResolved(config) {
      appRoot = config.root;
      const repo = resolve(appRoot, "..");
      engineDir = join(repo, "engine", "src") + sep;
      engineIndex = join(repo, "engine", "src", "index.ts");
      tapFile = join(appRoot, "src", "dev", "roundTap.ts");
      roundsDir = join(repo, "eval", "data", "rounds");
    },
    async resolveId(source, importer, options) {
      if (!enabled || !importer || !source.includes("engine/src/index")) return null;
      const from = clean(importer);
      if (from === tapFile || from.startsWith(engineDir)) return null;
      const target = await this.resolve(source, importer, { ...options, skipSelf: true });
      return target && clean(target.id) === engineIndex ? tapFile : null;
    },
    configureServer(server) {
      if (!enabled) return;
      const repo = resolve(appRoot, "..");
      server.middlewares.use("/__jester/rounds", (req, res) => {
        const reply = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(body));
        };
        if (req.method !== "POST") return reply(405, { data: null, error: "POST a round record." });
        readBody(req).then((text) => {
          let record: unknown;
          try { record = JSON.parse(text); } catch { return reply(400, { data: null, error: "not JSON" }); }
          if (!looksLikeRecord(record)) return reply(400, { data: null, error: "not a round record" });
          const stamped: RoundRecord = { ...record, app: codeFacts(repo) };
          mkdirSync(roundsDir, { recursive: true });
          writeFileSync(join(roundsDir, stamped.id + ".json"), JSON.stringify(stamped));
          server.config.logger.info(`round log: saved ${stamped.id} (${stamped.mode}, score ${stamped.result.score ?? "none"}${stamped.tag ? ", " + stamped.tag : ""})`, { timestamp: true });
          reply(200, { data: { id: stamped.id }, error: null });
        }, () => reply(413, { data: null, error: "record too large" }));
      });
    },
  };
}
