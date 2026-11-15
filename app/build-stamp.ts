// The build stamp: a quiet line in the bottom right corner of every page saying which build it is (the first 7
// characters of the commit and the build time, or "local" on a dev server), so two players can see at a glance
// whether they are on the same build. A built page also checks version.json once a minute and, when a newer build
// is live, shows one small line with a Refresh button. It never reloads on its own.
//
// A production build gets it only with JESTER_BUILD_STAMP=1; the build then also writes version.json beside the
// pages. No game file is touched: the script is added to each page's HTML. Class names for restyling:
// .jester-build-stamp, .jester-update-notice, .jester-update-notice__text, .jester-update-notice__refresh.

import { resolve } from "node:path";
import type { Plugin } from "vite";
import { buildInfo, type BuildInfo } from "./build-info.ts";

const CHECK_EVERY_MS = 60_000;

const STYLE = `
body[data-screen]:not(.dev) .jester-build-stamp, body[data-screen]:not(.dev) .jester-update-notice { display: none !important; }
.jester-build-stamp { position: fixed; right: 8px; bottom: 6px; z-index: 2147483000; pointer-events: none; user-select: none;
  font: 11px/1.2 ui-monospace, "Courier New", monospace; color: rgba(30, 27, 24, .5); text-shadow: 0 0 2px rgba(255, 255, 255, .7); }
.jester-update-notice { position: fixed; right: 8px; bottom: 24px; z-index: 2147483000; display: flex; gap: 8px; align-items: center;
  max-width: min(330px, calc(100vw - 16px)); box-sizing: border-box; padding: 6px 8px; font: 12px/1.3 system-ui, sans-serif;
  color: #1e1b18; background: #fffef6; border: 1px solid rgba(30, 27, 24, .25); border-radius: 4px; box-shadow: 2px 3px 0 rgba(30, 27, 24, .15); }
.jester-update-notice__refresh { flex: none; font: inherit; padding: 2px 8px; color: inherit; background: #fff;
  border: 1px solid rgba(30, 27, 24, .4); border-radius: 3px; cursor: pointer; }
`;

/** The page script: plain JavaScript, self-contained, so it runs as is in every page with no bundling. */
function pageScript(build: Pick<BuildInfo, "commit" | "builtAt"> | null): string {
  return `(() => {
  const BUILD = ${JSON.stringify(build)};
  const EVERY = ${CHECK_EVERY_MS};
  if (document.querySelector(".jester-build-stamp")) return;
  const style = document.createElement("style");
  style.textContent = ${JSON.stringify(STYLE)};
  document.head.appendChild(style);
  const stamp = document.createElement("div");
  stamp.className = "jester-build-stamp";
  if (BUILD) {
    const when = new Date(BUILD.builtAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    stamp.textContent = (BUILD.commit ? BUILD.commit.slice(0, 7) : "build") + " · " + when;
    stamp.title = "Build " + (BUILD.commit || "with no commit") + ", made " + BUILD.builtAt;
  } else {
    stamp.textContent = "local";
    stamp.title = "Running on a dev server";
  }
  document.body.appendChild(stamp);
  if (!BUILD || !BUILD.commit) return;
  let shown = false;
  const show = () => {
    shown = true;
    const box = document.createElement("div");
    box.className = "jester-update-notice";
    box.setAttribute("role", "status");
    const text = document.createElement("span");
    text.className = "jester-update-notice__text";
    text.textContent = "A newer version is live. Refresh when you are between rounds.";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "jester-update-notice__refresh";
    button.textContent = "Refresh";
    button.addEventListener("click", () => location.reload());
    box.append(text, button);
    document.body.appendChild(box);
  };
  const check = async () => {
    if (shown || document.hidden) return;
    try {
      const url = new URL("version.json", document.baseURI);
      url.searchParams.set("t", String(Date.now()));
      const response = await fetch(url.href, { cache: "no-store" });
      if (!response.ok) return;
      const live = await response.json();
      if (live && typeof live.commit === "string" && live.commit && live.commit.toLowerCase() !== BUILD.commit) show();
    } catch (err) {
      // No network or no version.json: try again next minute.
    }
  };
  setInterval(check, EVERY);
})();`;
}

export function buildStamp(): Plugin {
  const liveOn = process.env.JESTER_BUILD_STAMP === "1";
  let build: BuildInfo | null = null;
  return {
    name: "jester-build-stamp",
    apply: (_config, env) => env.command === "serve" || liveOn,
    configResolved(config) {
      if (config.command === "build") build = buildInfo(resolve(config.root, ".."));
    },
    transformIndexHtml() {
      return [{ tag: "script", children: pageScript(build ? { commit: build.commit, builtAt: build.builtAt } : null), injectTo: "body" }];
    },
    generateBundle() {
      // The same file the deploy writes; built here too, so the pages and version.json always come from one build.
      if (build) this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ commit: build.commit, builtAt: build.builtAt }) + "\n" });
    },
  };
}
