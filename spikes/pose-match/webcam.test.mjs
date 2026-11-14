import { test } from "node:test";
import assert from "node:assert/strict";
import { OneEuroFilter, PoseSmoother, binarizeMask, downsampleMask, maskIoU, extractOutline, buildFrame, HOLD_MS } from "./webcam.mjs";
import { comparePoses } from "./score.mjs";
import { makeStickPose, POSES } from "./synthetic.mjs";

const rng = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;

test("one euro filter reduces jitter on a still signal", () => {
  const noise = rng(7), f = new OneEuroFilter();
  const raw = [], out = [];
  for (let i = 0; i < 200; i++) { const v = 0.5 + noise() * 0.02; raw.push(v); out.push(f.filter(v, i * 33)); }
  const sd = (a) => { const m = a.reduce((x, y) => x + y) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
  assert.ok(sd(out.slice(20)) < sd(raw.slice(20)) * 0.6);
});

test("one euro filter follows a fast move with small lag", () => {
  const f = new OneEuroFilter();
  let v = 0;
  for (let i = 0; i < 30; i++) { v = f.filter(i < 10 ? 0 : 1, i * 33); }
  assert.ok(v > 0.95, "still at " + v);
});

test("smoother returns 33 landmarks and keeps the scorer happy", () => {
  const pose = makeStickPose(POSES.tPose);
  const s = new PoseSmoother();
  let last;
  for (let i = 0; i < 20; i++) last = s.smooth(pose, i * 33);
  assert.equal(last.length, 33);
  assert.ok(comparePoses(pose, last, { mirror: false }).score > 0.999);
});

test("low visibility is held briefly, then passed through as unreliable", () => {
  const pose = makeStickPose(POSES.tPose);
  const s = new PoseSmoother();
  for (let i = 0; i < 10; i++) s.smooth(pose, i * 33);
  const hidden = pose.map((p, i) => (i === 15 ? { ...p, x: 0, y: 0, visibility: 0.1 } : p));
  const held = s.smooth(hidden, 10 * 33);
  assert.ok(held[15].x > 0.1, "held position, not zero");
  const later = s.smooth(hidden, 10 * 33 + HOLD_MS + 100);
  assert.ok(later[15].visibility < 0.5);
});

test("null landmarks pass through as null", () => {
  assert.equal(new PoseSmoother().smooth(null, 0), null);
});

function disc(w, h, cx, cy, r) {
  const v = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) v[y * w + x] = (x - cx) ** 2 + (y - cy) ** 2 <= r * r ? 0.9 : 0.1;
  return v;
}

test("identical masks have IoU 1, disjoint masks 0, shifted masks in between", () => {
  const a = binarizeMask(disc(40, 40, 20, 20, 10), 40, 40);
  const same = binarizeMask(disc(40, 40, 20, 20, 10), 40, 40);
  const far = binarizeMask(disc(40, 40, 33, 6, 3), 40, 40);
  const near = binarizeMask(disc(40, 40, 24, 20, 10), 40, 40);
  assert.equal(maskIoU(a, same), 1);
  assert.equal(maskIoU(a, far), 0);
  const mid = maskIoU(a, near);
  assert.ok(mid > 0.4 && mid < 0.95, "IoU " + mid);
});

test("outline of a disc is a closed ring near the disc edge", () => {
  const mask = binarizeMask(disc(60, 60, 30, 30, 15), 60, 60);
  const outline = extractOutline(mask, 80);
  assert.ok(outline.length >= 20);
  for (const [x, y] of outline) {
    const r = Math.hypot(x * 60 - 30, y * 60 - 30);
    assert.ok(r > 13 && r <= 16, "radius " + r);
  }
});

test("empty mask has no outline", () => {
  assert.equal(extractOutline(binarizeMask(new Float32Array(100), 10, 10)), null);
  assert.equal(extractOutline(null), null);
});

test("downsample keeps shape and buildFrame fills every field", () => {
  const values = disc(64, 64, 32, 32, 20);
  const small = downsampleMask(binarizeMask(values, 64, 64), 4);
  assert.equal(small.width, 16);
  const frame = buildFrame({ t: 5, landmarks: makeStickPose(POSES.rest), aspect: 4 / 3, maskValues: values, maskWidth: 64, maskHeight: 64 });
  assert.equal(frame.landmarks.length, 33);
  assert.equal(frame.mirrored, false);
  assert.ok(frame.mask && frame.outline.length > 8);
  assert.equal(buildFrame({ t: 1, landmarks: null, aspect: 1 }).outline, null);
});
