// What code a build or a dev server is running: the commit, when it was built, and a hash of the engine's code.
// Shared by the round log (round-log-plugin.ts) and the build stamp (build-stamp.ts). Runs in Node only.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface BuildInfo {
  /** Full commit hash, or null when neither the deploy nor git can say. */
  commit: string | null;
  builtAt: string;
  /** First 12 hex digits of a SHA-1 over engine/src/*.ts, so a round can be matched to the scorer code even with no git. */
  engineHash: string | null;
}

export function git(repo: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

export function engineHash(repo: string): string | null {
  try {
    const dir = join(repo, "engine", "src");
    const hash = createHash("sha1");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts")).sort()) hash.update(f).update(readFileSync(join(dir, f)));
    return hash.digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}

const cache = new Map<string, BuildInfo>();

/**
 * Once per build. The deploy builds from an export with no git history and sets VERCEL_GIT_COMMIT_SHA, so that
 * comes first; git is the fallback for a build run in a checkout.
 */
export function buildInfo(repo: string): BuildInfo {
  const known = cache.get(repo);
  if (known) return known;
  const fromDeploy = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
  const info: BuildInfo = {
    commit: fromDeploy && /^[0-9a-f]{7,40}$/i.test(fromDeploy) ? fromDeploy.toLowerCase() : git(repo, "rev-parse", "HEAD"),
    builtAt: new Date().toISOString(),
    engineHash: engineHash(repo),
  };
  cache.set(repo, info);
  return info;
}
