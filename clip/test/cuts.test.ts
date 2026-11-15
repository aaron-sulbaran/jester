import assert from "node:assert/strict";
import { test } from "node:test";
import { findCuts, frameSignature, shotRanges, signatureDistance } from "../src/index.ts";

function solid(r: number, g: number, b: number, width = 4, height = 4): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set([r, g, b, 255], i * 4);
  return rgba;
}

const sig = (r: number, g: number, b: number) => frameSignature(solid(r, g, b), 4, 4);

test("frameSignature: 24 numbers, each channel sums to 1", () => {
  const s = sig(10, 100, 250);
  assert.equal(s.length, 24);
  for (let c = 0; c < 3; c++) {
    const sum = s.slice(c * 8, c * 8 + 8).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  }
});

test("signatureDistance: identical is 0, black against white is 1", () => {
  assert.equal(signatureDistance(sig(30, 60, 90), sig(30, 60, 90)), 0);
  assert.equal(signatureDistance(sig(0, 0, 0), sig(255, 255, 255)), 1);
});

test("findCuts: a hard change between two colours is one cut", () => {
  const signatures = [...Array(20).fill(sig(20, 20, 20)), ...Array(20).fill(sig(220, 40, 40))];
  assert.deepEqual(findCuts(signatures), [20]);
});

test("findCuts: a slow fade is not a cut", () => {
  // A 256 pixel grey ramp that fades toward white over 20 frames, so the histogram drifts bin by bin.
  const signatures = Array.from({ length: 20 }, (_, i) => {
    const t = i / 19;
    const rgba = new Uint8ClampedArray(256 * 4);
    for (let k = 0; k < 256; k++) {
      const v = Math.round(k * (1 - t) + 255 * t);
      rgba.set([v, v, v, 255], k * 4);
    }
    return frameSignature(rgba, 16, 16);
  });
  assert.deepEqual(findCuts(signatures), []);
});

test("findCuts: a steady pan with constant moderate change is not a cut", () => {
  // Half the mass of every channel slides one bin per frame, so every pair differs by 0.5.
  const signatures = Array.from({ length: 7 }, (_, i) => {
    const channel = Array<number>(8).fill(0);
    channel[i] = 0.5;
    channel[i + 1] = 0.5;
    return [...channel, ...channel, ...channel];
  });
  assert.ok(signatureDistance(signatures[0]!, signatures[1]!) > 0.35);
  assert.deepEqual(findCuts(signatures), []);
});

test("shotRanges: one cut makes two ranges, end exclusive", () => {
  assert.deepEqual(shotRanges(40, [20]), [{ start: 0, end: 20 }, { start: 20, end: 40 }]);
  assert.deepEqual(shotRanges(10, []), [{ start: 0, end: 10 }]);
});
