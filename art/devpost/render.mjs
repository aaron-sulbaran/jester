// Renders every Devpost picture in this folder to app/public/devpost/<name>.png, then rebuilds
// app/public/devpost/preview.html from docs/devpost/story.md.
//
//   node art/devpost/render.mjs                 everything
//   node art/devpost/render.mjs hero track-     only pictures whose name starts with one of these
//
// It needs Playwright (any recent version) and its Chromium: `playwright` or `playwright-core` installed
// where Node can find it, or PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs. Chromium starts with a
// fresh, throwaway profile; it never touches anyone's own browser.
//
// To add a track banner: add one line to TRACKS below and run `node art/devpost/render.mjs track-`.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { deflateSync, inflateSync, crc32 } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { storyToPreview } from "./preview.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT = join(ROOT, "app", "public", "devpost");
const STORY = join(ROOT, "docs", "devpost", "story.md");
const CHECKLIST = join(ROOT, "docs", "devpost", "checklist.md");
const MAX_BYTES = 800 * 1024;

/** One line per track we enter. `name` is drawn in alphabet stickers; sponsor names stay plain text. */
const TRACKS = [
  { slug: "entertainment", name: "Entertainment", line: "Our main track at HackPrinceton Fall 2026" },
];

const HEADINGS = ["inspiration", "what", "how", "stack", "challenges", "wins", "learned", "next"];

/** Every picture: the page, its address query, and its size. `height: "page"` measures the page. */
const JOBS = [
  { name: "hero", page: "hero.html", width: 1600, height: 900 },
  ...HEADINGS.map((s) => ({ name: `heading-${s}`, page: "heading.html", query: { s }, width: 1600, height: 256 })),
  ...TRACKS.map((t) => ({ name: `track-${t.slug}`, page: "track.html", query: { name: t.name, line: t.line }, width: 1600, height: 300 })),
  { name: "diagram-clip-to-guide", page: "diagram-guide.html", width: 1600, height: "page" },
  { name: "diagram-round", page: "diagram-round.html", width: 1600, height: "page" },
];

async function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_MODULE && pathToFileURL(process.env.PLAYWRIGHT_MODULE).href, "playwright", "playwright-core"].filter(Boolean);
  for (const spec of tries) {
    try {
      const mod = await import(spec);
      return mod.chromium ?? mod.default?.chromium;
    } catch { /* try the next one */ }
  }
  throw new Error("Playwright not found. Install it (npm i -D playwright) or set PLAYWRIGHT_MODULE to playwright-core/index.mjs.");
}

/**
 * Lossless: Chromium writes PNGs with fast compression. This joins the image data and deflates it again at
 * level 9, keeping every pixel and the filters as they are. Needs Node 22.2 or newer (zlib.crc32).
 */
function recompress(png) {
  const chunks = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    chunks.push({ type: png.toString("ascii", at + 4, at + 8), data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)));
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const parts = [png.subarray(0, 8)];
  let wroteData = false;
  for (const c of chunks) {
    if (c.type !== "IDAT") parts.push(chunk(c.type, c.data));
    else if (!wroteData) { parts.push(chunk("IDAT", deflateSync(raw, { level: 9, memLevel: 9 }))); wroteData = true; }
  }
  return Buffer.concat(parts);
}

async function render(browser, job) {
  const url = pathToFileURL(join(HERE, job.page));
  for (const [k, v] of Object.entries(job.query ?? {})) url.searchParams.set(k, v);
  const page = await browser.newPage({ viewport: { width: job.width, height: job.height === "page" ? 800 : job.height }, deviceScaleFactor: 1 });
  await page.goto(url.href);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })));
  });
  if (job.height === "page") {
    const height = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
    await page.setViewportSize({ width: job.width, height });
  }
  const file = join(OUT, `${job.name}.png`);
  const png = recompress(await page.screenshot());
  await page.close();
  await writeFile(file, png);
  const size = png.length;
  const kb = Math.round(size / 1024);
  console.log(`${size > MAX_BYTES ? "TOO BIG" : "ok"}  ${job.name}.png  ${kb} KB`);
  return size <= MAX_BYTES;
}

const only = process.argv.slice(2);
const jobs = only.length ? JOBS.filter((j) => only.some((o) => j.name.startsWith(o))) : JOBS;
await mkdir(OUT, { recursive: true });
const chromium = await loadPlaywright();
const browser = await chromium.launch();
let fine = true;
try {
  for (const job of jobs) fine = (await render(browser, job)) && fine;
} finally {
  await browser.close();
}

const story = await readFile(STORY, "utf8").catch(() => null);
const checklist = await readFile(CHECKLIST, "utf8").catch(() => "");
if (story !== null) {
  await writeFile(join(OUT, "preview.html"), storyToPreview(story, checklist));
  console.log("ok  preview.html (from docs/devpost/story.md)");
}
if (!fine) process.exitCode = 1;
