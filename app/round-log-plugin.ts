// The round log. Every app file that imports engine/src/index.ts gets a small generated module instead: the
// engine as is, except scorePoseRound and scoreTrajectoryRound, which come from src/dev/roundTap.ts bound to that
// file's name. The tap calls the real scorer, returns its result untouched, and saves the round when the page is
// idle. No game file knows about it.
//
//   Dev server: on unless JESTER_ROUND_LOG=0. Rounds are posted here and written to eval/data/rounds/<id>.json
//               (git-ignored), stamped with the commit, uncommitted engine changes and the engine's hash.
//   Production: only when the build has JESTER_RECORD_ROUNDS=1; otherwise none of it ships. Rounds go straight to
//               the Supabase table `rounds` with the page's public key, stamped with the build's commit.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { IncomingMessage } from "node:http";
import type { Plugin } from "vite";
import { looksLikeRecord, type RoundRecord } from "../eval/src/record.ts";
import { buildInfo, engineHash, git, type BuildInfo } from "./build-info.ts";

const MAX_BODY_BYTES = 40 * 1024 * 1024;
const VIRTUAL = "\0jester-tap:";

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

/** The commit, whether the engine has changes not in it, and the engine's hash, as the dev server runs it now. */
function codeFacts(repo: string): NonNullable<RoundRecord["app"]> {
  const status = git(repo, "status", "--porcelain", "--", "engine/src");
  return { commit: git(repo, "rev-parse", "HEAD"), dirty: status === null ? false : status.length > 0, engineHash: engineHash(repo) };
}

/**
 * Ghosts on a dev server (app/src/ghostSource.ts) read this laptop's round log with GET: without `ids`, a light row
 * per untagged round with a score and a bank clip; with `ids=a,b`, those rounds' poses, reference, options and results.
 */
function localGhostRows(roundsDir: string, ids: string | null): unknown[] {
  if (!existsSync(roundsDir)) return [];
  const wanted = ids ? new Set(ids.split(",")) : null;
  const out: unknown[] = [];
  for (const file of readdirSync(roundsDir)) {
    if (!file.endsWith(".json") || (wanted && !wanted.has(file.slice(0, -5)))) continue;
    let r: unknown;
    try { r = JSON.parse(readFileSync(join(roundsDir, file), "utf8")); } catch { continue; }
    if (!looksLikeRecord(r) || r.tag !== null || r.result.score === null || !r.clip.bankId) continue;
    out.push(wanted
      ? { id: r.id, score: r.result.score, player: r.player, result: r.result, reference: r.reference, options: r.options }
      : { id: r.id, score: r.result.score, tag: r.tag, bankId: r.clip.bankId, channel: r.channel });
  }
  return out;
}

export function roundLog(): Plugin {
  const devOn = process.env.JESTER_ROUND_LOG !== "0";
  const liveOn = process.env.JESTER_RECORD_ROUNDS === "1";
  let command: "serve" | "build" = "serve";
  let repo = "";
  let appRoot = "";
  let engineIndex = "";
  let engineDir = "";
  let tapFile = "";
  let roundsDir = "";
  let build: BuildInfo | null = null;
  return {
    name: "jester-round-log",
    enforce: "pre",
    apply: (_config, env) => (env.command === "serve" ? devOn : liveOn),
    configResolved(config) {
      command = config.command;
      appRoot = config.root;
      repo = resolve(appRoot, "..");
      engineDir = join(repo, "engine", "src") + sep;
      engineIndex = join(repo, "engine", "src", "index.ts");
      tapFile = join(appRoot, "src", "dev", "roundTap.ts");
      roundsDir = join(repo, "eval", "data", "rounds");
      if (command === "build") build = buildInfo(repo);
    },
    async resolveId(source, importer, options) {
      if (!importer || importer.startsWith("\0") || !source.includes("engine/src/index")) return null;
      const from = clean(importer);
      if (from === tapFile || from.startsWith(engineDir)) return null;
      const target = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!target || clean(target.id) !== engineIndex) return null;
      // "blind", "round", "onlineDuel"; files outside app/src keep their path from the repo root.
      const name = relative(join(appRoot, "src"), from).startsWith("..") ? relative(repo, from) : relative(join(appRoot, "src"), from);
      return VIRTUAL + name.replace(/\\/g, "/").replace(/\.[cm]?[jt]s$/, "");
    },
    load(id) {
      if (!id.startsWith(VIRTUAL)) return null;
      const file = id.slice(VIRTUAL.length);
      // The dev server reads files outside its root through /@fs/; a build takes plain paths.
      const path = (p: string) => JSON.stringify(command === "serve" ? "/@fs" + p.replace(/\\/g, "/") : p);
      return [
        `import { bindTap } from ${path(tapFile)};`,
        `export * from ${path(engineIndex)};`,
        `export const { scorePoseRound, scoreTrajectoryRound } = bindTap(${JSON.stringify(file)}, ${JSON.stringify(build)});`,
      ].join("\n");
    },
    configureServer(server) {
      server.middlewares.use("/__jester/rounds", (req, res) => {
        const reply = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(body));
        };
        if (req.method === "GET") return reply(200, localGhostRows(roundsDir, new URL(req.url ?? "/", "http://dev").searchParams.get("ids")));
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
