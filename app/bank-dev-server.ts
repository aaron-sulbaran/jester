// Dev server only: serves a local video bank folder at /bank, so a local run plays the bank's clips
// straight from Aaron's laptop. Start the dev server with JESTER_BANK_DIR set to the folder; without it
// nothing changes and the game reads the public site's bank. Videos get byte ranges so they can seek.

import { createReadStream, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type { Plugin } from "vite";

const TYPES: Record<string, string> = {
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
};

export function bankDevServer(dir: string | undefined): Plugin {
  return {
    name: "jester-bank-dev",
    apply: "serve",
    configureServer(server) {
      if (!dir) return;
      const root = resolve(dir);
      server.middlewares.use("/bank", (req, res, next) => {
        let file: string;
        let size: number;
        try {
          file = resolve(root, "." + decodeURIComponent((req.url ?? "/").split("?")[0]!));
          if (file !== root && !file.startsWith(root + sep)) return next();
          const stat = statSync(file);
          if (!stat.isFile()) return next();
          size = stat.size;
        } catch {
          return next();
        }
        res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Accept-Ranges", "bytes");
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
        if (range && (range[1] || range[2])) {
          const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
          const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
          if (start > end || start >= size) {
            res.statusCode = 416;
            res.setHeader("Content-Range", `bytes */${size}`);
            res.end();
            return;
          }
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
          res.setHeader("Content-Length", String(end - start + 1));
          if (req.method === "HEAD") return void res.end();
          createReadStream(file, { start, end }).pipe(res);
          return;
        }
        res.setHeader("Content-Length", String(size));
        if (req.method === "HEAD") return void res.end();
        createReadStream(file).pipe(res);
      });
    },
  };
}
