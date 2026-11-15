import assert from "node:assert/strict";
import { test } from "node:test";
import type { FrameDetections, Track } from "../src/index.ts";
import { evenFrames, grabKey, NOT_A_LINK, parseLink, readStartTime, stitchTracks } from "../../app/src/clipside/link.ts";

const ok = (text: string) => {
  const result = parseLink(text);
  if (result.error !== null) throw new Error(`expected ${text} to parse`);
  return result.data;
};

test("parseLink: YouTube watch, youtu.be, Shorts, embed, with and without a scheme", () => {
  assert.deepEqual(
    { ...ok("https://www.youtube.com/watch?v=9bZkp7q19f0&t=42s") },
    { site: "youtube", videoId: "9bZkp7q19f0", startSeconds: 42, short: false, key: "yt:9bZkp7q19f0", url: "https://www.youtube.com/watch?v=9bZkp7q19f0&t=42s" },
  );
  const be = ok("youtu.be/9bZkp7q19f0?t=1m5s");
  assert.equal(be.site, "youtube");
  assert.equal(be.site === "youtube" && be.startSeconds, 65);
  const short = ok("https://youtube.com/shorts/abcdefghijk?feature=share");
  assert.equal(short.site === "youtube" && short.short, true);
  assert.equal(short.site === "youtube" && short.videoId, "abcdefghijk");
  assert.equal(ok("https://m.youtube.com/watch?v=abcdefghijk").key, "yt:abcdefghijk");
  assert.equal(ok("https://www.youtube.com/embed/abcdefghijk?start=30").site === "youtube", true);
});

test("parseLink: TikTok video and short links, Instagram reels", () => {
  const tt = ok("https://www.tiktok.com/@someone/video/7301234567890123456?lang=en");
  assert.equal(tt.site, "tiktok");
  assert.equal(tt.site === "tiktok" && tt.embedUrl, "https://www.tiktok.com/player/v1/7301234567890123456");
  const shortTt = ok("https://vm.tiktok.com/ZMabc123/");
  assert.equal(shortTt.site === "tiktok" && shortTt.embedUrl, null);
  assert.equal(shortTt.key, "tt:short:ZMabc123");
  const reel = ok("https://www.instagram.com/reels/C1aBcDeFgHi/?igsh=xyz");
  assert.equal(reel.site === "instagram" && reel.embedUrl, "https://www.instagram.com/reel/C1aBcDeFgHi/embed");
});

test("parseLink: anything else is the sentence", () => {
  for (const text of ["", "hello there", "https://vimeo.com/12345", "https://www.youtube.com/watch?v=short", "https://www.instagram.com/someone/", "https://www.tiktok.com/@someone"]) {
    assert.deepEqual(parseLink(text), { data: null, error: NOT_A_LINK });
  }
});

test("readStartTime: plain seconds, h m s, clock form, junk", () => {
  assert.equal(readStartTime("90"), 90);
  assert.equal(readStartTime("1h2m3s"), 3723);
  assert.equal(readStartTime("2:05"), 125);
  assert.equal(readStartTime("abc"), 0);
  assert.equal(readStartTime(null), 0);
});

test("grabKey: link key and range in whole ms", () => {
  assert.equal(grabKey("yt:abcdefghijk", 12000.4, 27000), "yt:abcdefghijk:12000-27000");
});

const frame = (tMs: number, n: number): FrameDetections => ({ tMs, people: [], signature: [n] });

test("evenFrames: one frame per slot, nearest grabbed frame, slot times", () => {
  const grabbed = [frame(1000, 1), frame(1070, 2), frame(1125, 3), frame(1300, 4)];
  const { frames, stretched } = evenFrames(grabbed, 1000, 1300, 15);
  assert.deepEqual(frames.map((f) => f.tMs), [1000, 1067, 1133, 1200, 1267]);
  assert.deepEqual(frames.map((f) => f.signature[0]), [1, 2, 3, 3, 4]);
  // The 1200 slot is 75 ms from its nearest frame, more than one 67 ms slot.
  assert.equal(stretched, 1);
});

test("evenFrames: a long gap counts as stretched; nothing grabbed gives nothing", () => {
  const { frames, stretched } = evenFrames([frame(0, 1), frame(1000, 2)], 0, 1000, 15);
  assert.equal(frames.length, 15);
  assert.ok(stretched > 0);
  assert.deepEqual(evenFrames([], 0, 1000, 15), { frames: [], stretched: 0 });
});

const piece = (id: number, from: number, to: number, cx: number, shot = 0): Track => ({
  id, shot,
  points: Array.from({ length: to - from + 1 }, (_, i) => ({
    frame: from + i, tMs: (from + i) * 66, box: { cx, cy: 0.5, w: 0.2, h: 0.6 }, landmarks: [], outline: null,
  })),
});

test("stitchTracks: one person split three times becomes one track", () => {
  const joined = stitchTracks([piece(1, 0, 39, 0.5), piece(2, 40, 79, 0.55), piece(3, 82, 120, 0.5)]);
  assert.equal(joined.length, 1);
  assert.equal(joined[0]!.id, 1);
  assert.equal(joined[0]!.points.length, 40 + 40 + 39);
});

test("stitchTracks: two people side by side each keep their own pieces", () => {
  const joined = stitchTracks([piece(1, 0, 30, 0.2), piece(2, 0, 30, 0.8), piece(3, 31, 60, 0.82), piece(4, 32, 60, 0.21)]);
  assert.equal(joined.length, 2);
  assert.deepEqual(joined.map((t) => [t.id, t.points.length, t.points.at(-1)!.box.cx]), [[1, 60, 0.21], [2, 61, 0.82]]);
});

test("stitchTracks: overlapping in time, far apart, long gaps and other shots stay apart", () => {
  assert.equal(stitchTracks([piece(1, 0, 30, 0.5), piece(2, 20, 50, 0.5)]).length, 2);
  assert.equal(stitchTracks([piece(1, 0, 30, 0.1), piece(2, 31, 50, 0.9)]).length, 2);
  assert.equal(stitchTracks([piece(1, 0, 30, 0.5), piece(2, 45, 60, 0.5)]).length, 2);
  assert.equal(stitchTracks([piece(1, 0, 30, 0.5), piece(2, 31, 60, 0.5, 1)]).length, 2);
});
