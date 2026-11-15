// Where to stand: the frame on the mirror view and how the player fits it. Run from app/: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFit, clip, drawnImage, feetExpected, fitHint, frameRect, playerRect, type Point, type Rect } from "../src/fitFrame.ts";

// The turn screen while playing: a 16:9 stage 1600 x 900, the mirror view on the right half, a 4:3 camera drawn with cover.
const stageW = 1600;
const view: Rect = { x: 800, y: 0, w: 800, h: 900 };
const image = drawnImage(view, 640, 480, "cover");

/** A standing body: 33 points, centred at `cx` across the camera picture (not mirrored), from `top` to `bottom`. */
function body(cx: number, top: number, bottom: number, feet = true): Point[] {
  const h = bottom - top;
  return Array.from({ length: 33 }, (_, i) => {
    const y = i <= 10 ? top : i <= 16 ? top + h * 0.2 : i <= 24 ? top + h * 0.5 : i <= 26 ? top + h * 0.75 : bottom;
    const x = cx + (i % 2 ? -0.05 : 0.05);
    return { x, y, visibility: i >= 27 && !feet ? 0.1 : 0.99 };
  });
}

test("cover fills the view and crops the sides", () => {
  assert.equal(image.h, 900);
  assert.equal(image.w, 1200);
  assert.equal(image.x, 800 - 200);
  const contain = drawnImage(view, 640, 480, "contain");
  assert.equal(contain.w, 800);
  assert.equal(contain.y, (900 - 600) / 2);
});

test("the frame keeps the subject's height share and place across the view, inside the view", () => {
  // A 9:16 clip with the subject centred, 70% of the height.
  const f = frameRect({ cx: 0.5, cy: 0.5, w: 0.3, h: 0.7 }, 9 / 16, view, image)!;
  assert.ok(Math.abs(f.h - 630) < 1e-9);
  assert.ok(Math.abs(f.x + f.w / 2 - 1200) < 1e-9); // the middle of the right half
  // A subject at the clip's far left is kept inside the view, never over the role's half.
  const edge = frameRect({ cx: 0.02, cy: 0.5, w: 0.3, h: 0.7 }, 9 / 16, view, image)!;
  assert.ok(edge.x >= view.x);
});

test("the player's box is mirrored onto the view and padded up to the head", () => {
  // Standing on the camera picture's left (x 0.3) shows on the view's right, as in a mirror.
  const p = playerRect(body(0.3, 0.2, 0.9), image)!;
  assert.ok(p.rect.x + p.rect.w / 2 > view.x + view.w / 2);
  assert.ok(p.rect.y < image.y + 0.2 * image.h);
  assert.equal(p.feet, true);
  assert.equal(playerRect(null, image), null);
  assert.equal(playerRect(body(0.5, 0.2, 0.9).map((q) => ({ ...q, visibility: 0 })), image), null);
});

test("fit: good, too close, too far, off to a side, feet out of the picture, unseen", () => {
  const frame: Rect = { x: 1050, y: 135, w: 300, h: 630 };
  const at = (cx: number, top: number, bottom: number, feet = true) => playerRect(body(cx, top, bottom, feet), image);
  const centre = 0.5; // the camera picture's middle shows at the view's middle (x 1200)
  assert.equal(classifyFit(at(centre, 0.2, 0.83), frame, stageW, true), "good");
  assert.equal(classifyFit(at(centre, 0.02, 0.99), frame, stageW, true), "close");
  assert.equal(classifyFit(at(centre, 0.4, 0.75), frame, stageW, true), "far");
  // Shown right of the frame (camera x below the middle): move to your left, which is screen left.
  assert.equal(classifyFit(at(0.25, 0.2, 0.83), frame, stageW, true), "left");
  assert.equal(classifyFit(at(0.75, 0.2, 0.83), frame, stageW, true), "right");
  // Legs out of the picture while the subject's are in theirs: too close, even if the box looks the right size.
  assert.equal(classifyFit(at(centre, 0.2, 0.83, false), frame, stageW, true), "close");
  // A clip cut off at the waist expects no feet, so hidden feet alone never say "too close".
  assert.notEqual(classifyFit(at(centre, 0.2, 0.83, false), frame, stageW, false), "close");
  assert.equal(classifyFit(null, frame, stageW, true), "unseen");
});

test("feet are expected only when the subject's show on the view", () => {
  assert.equal(feetExpected({ cx: 0.5, cy: 0.5, w: 0.3, h: 0.7 }, view, image), true);
  assert.equal(feetExpected({ cx: 0.5, cy: 0.6, w: 0.3, h: 0.8 }, view, image), false); // cut off in the clip
  // A tall clip drawn with cover loses its bottom: feet at 90% of the clip fall below the view.
  const tall = drawnImage(view, 900, 1600, "cover");
  assert.equal(feetExpected({ cx: 0.2, cy: 0.65, w: 0.4, h: 0.5 }, view, tall), false);
});

test("one hint at a time, in plain words, with no em dashes", () => {
  assert.equal(fitHint("left"), "Move to your left, into the frame.");
  assert.equal(fitHint("good"), "That's it. Stay in the frame.");
  for (const f of ["unseen", "close", "far", "left", "right", "good"] as const) assert.doesNotMatch(fitHint(f), /—/);
});

test("the player's box is kept to the picture, and feet past its edge do not count", () => {
  // Points guessed below the picture (a tracker does this, and the simulated player always does).
  const p = playerRect(body(0.5, 0.2, 1.3), image)!;
  assert.ok(p.rect.y + p.rect.h <= image.y + image.h + 1e-9);
  assert.equal(p.feet, false);
});

test("a tall clip cropped top and bottom: frame and player are kept to the same visible area", () => {
  // A 9:16 picture drawn with cover in the half-width view overflows it above and below.
  const tall = drawnImage(view, 900, 1600, "cover");
  assert.ok(tall.h > view.h);
  const frame = frameRect({ cx: 0.5, cy: 0.6, w: 0.3, h: 0.8 }, 9 / 16, view, tall)!;
  const me = playerRect(body(0.5, 0.2, 1.0), tall, view)!;
  const shows = clip(view, tall)!;
  for (const r of [frame, me.rect]) assert.ok(r.y >= shows.y - 1e-9 && r.y + r.h <= shows.y + shows.h + 1e-9);
  // The same body as the subject, cut off by the same crop, fits.
  assert.equal(classifyFit(me, frame, stageW, false), "good");
});
