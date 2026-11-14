import assert from "node:assert/strict";
import { test } from "node:test";
import { detectEvents, scoreTrajectoryRound } from "../src/index.ts";
import { referenceSignals, REFERENCE_THRESHOLDS } from "../src/trajectory.ts";
import { boxTrack, playerCopyingSprite, spritePath, STAND, timeline } from "./synth.ts";

const track = boxTrack(spritePath, 24);

test("reference events: the sprite's jumps, ducks and lane changes are found", () => {
  const n = track.frames.length;
  const sig = referenceSignals(track, n);
  const ev = detectEvents(sig, REFERENCE_THRESHOLDS);
  const count = (t: string) => ev.filter((e) => e.type === t).length;
  assert.equal(count("jump"), 8);
  assert.equal(count("crouch"), 8);
  assert.ok(count("moveRight") + count("moveLeft") >= 8, JSON.stringify(ev));
});

test("trajectory round: a good copy scores high", () => {
  const player = timeline(playerCopyingSprite, { durationS: 24 });
  const r = scoreTrajectoryRound(track, player);
  assert.equal(r.failure, null);
  assert.ok(r.score !== null && r.score >= 80, `score ${r.score} ${JSON.stringify({ c: r.continuous, f1: r.eventF1, a: r.activity })}`);
  assert.ok(r.eventF1 !== null && r.eventF1 > 0.9, `f1 ${r.eventF1}`);
});

test("trajectory round: a late copy is found at the right lag", () => {
  const player = timeline(playerCopyingSprite, { durationS: 24, delayMs: 300 });
  const r = scoreTrajectoryRound(track, player);
  assert.ok(Math.abs(r.lagMs - 300) <= 34, `lag ${r.lagMs}`);
  assert.ok(r.score !== null && r.score >= 80, `score ${r.score}`);
});

test("trajectory round: standing still scores near zero", () => {
  const player = timeline(() => STAND, { durationS: 24 });
  const r = scoreTrajectoryRound(track, player);
  assert.ok(r.score !== null && r.score <= 5, `score ${r.score}`);
});

test("trajectory round: moving the wrong way scores low", () => {
  // Steps the opposite lane direction, never jumps or ducks.
  const player = timeline((t) => ({ ...playerCopyingSprite(t), cx: 1 - playerCopyingSprite(t).cx, cy: STAND.cy, lThigh: 3, lShin: 0, rThigh: -3, rShin: 0 }), { durationS: 24 });
  const r = scoreTrajectoryRound(track, player);
  assert.ok(r.score !== null && r.score < 30, `score ${r.score}`);
});

test("trajectory round: a box that never moves has nothing to mimic", () => {
  const still = boxTrack(() => ({ cx: 0.5, cy: 0.6, w: 0.08, h: 0.2 }), 10);
  const r = scoreTrajectoryRound(still, timeline(() => STAND, { durationS: 10 }));
  assert.equal(r.failure, "nothing-to-mimic");
  assert.equal(r.score, null);
});

// ---- People copying natural objects (0.6.0). Before 0.6.0 a clean copy of a ball scored 20 and a car 16. ----

type Box = { cx: number; cy: number; w: number; h: number };
const ball = (t: number): Box => ({ cx: 0.5, cy: 0.75 - 0.4 * Math.abs(Math.sin((Math.PI * t) / 1.2)), w: 0.08, h: 0.08 });
const car = (t: number): Box => {
  const c = t % 10;
  const x = c < 4 ? 0.1 + 0.8 * (c / 4) : c < 5 ? 0.9 : c < 9 ? 0.9 - 0.8 * ((c - 5) / 4) : 0.1;
  return { cx: x, cy: 0.7, w: 0.2, h: 0.1 };
};
const pendulum = (t: number): Box => ({ cx: 0.5 + 0.2 * Math.sin((2 * Math.PI * t) / 3), cy: 0.5 + 0.05 * Math.cos((4 * Math.PI * t) / 3), w: 0.06, h: 0.06 });

/** A player following an object with small steps on a raw (unmirrored) camera: body x opposite, rises when it rises. */
function follow(obj: (t: number) => Box, { amp = 1, invertX = false } = {}) {
  let mx = 0, my = 0;
  for (let t = 0; t < 20; t += 0.1) { mx += obj(t).cx; my += obj(t).cy; }
  mx /= 200; my /= 200;
  return (t: number) => {
    const b = obj(t);
    return { ...STAND, cx: 0.5 - (b.cx - mx) * 0.5 * amp * (invertX ? -1 : 1), cy: STAND.cy + 0.6 * (b.cy - my) * amp };
  };
}
const flail = (t: number) => ({ ...STAND, lUpper: 90 + 80 * Math.sin(5 * t), lFore: 90 + 80 * Math.sin(5 * t + 1), rUpper: -90 + 80 * Math.sin(4 * t), rFore: -90 + 80 * Math.sin(4 * t + 2) });
const score = (obj: (t: number) => Box, f: (t: number) => typeof STAND) => scoreTrajectoryRound(boxTrack(obj, 20), timeline(f, { durationS: 20 })).score ?? -1;

test("objects: a good copy of a bouncing ball, a pendulum and a car scores well", () => {
  assert.ok(score(ball, follow(ball)) >= 90, `ball ${score(ball, follow(ball))}`);
  assert.ok(score(pendulum, follow(pendulum)) >= 90, `pendulum ${score(pendulum, follow(pendulum))}`);
  assert.ok(score(car, follow(car)) >= 70, `car ${score(car, follow(car))}`);
});

test("objects: half the movement earns partial credit, not full", () => {
  for (const [name, obj] of [["pendulum", pendulum], ["car", car]] as const) {
    const half = score(obj, follow(obj, { amp: 0.5 })), full = score(obj, follow(obj));
    assert.ok(half < full && half >= 20, `${name}: half ${half}, full ${full}`);
  }
});

test("objects: standing still, waving only the arms, or going the wrong way scores low", () => {
  for (const [name, obj] of [["ball", ball], ["pendulum", pendulum], ["car", car]] as const) {
    assert.ok(score(obj, () => STAND) <= 5, `${name} still`);
    assert.ok(score(obj, flail) <= 5, `${name} arms only`);
  }
  assert.ok(score(car, follow(car, { invertX: true })) <= 10, "car wrong way");
});

test("objects: chance does not reward any rhythm on a rhythmic clip", () => {
  // Bobbing at the wrong tempo against a ball bouncing every 1.2 s.
  const wrongTempo = (t: number) => ({ ...STAND, cy: STAND.cy - 0.15 * Math.abs(Math.sin((Math.PI * t) / 0.7)) });
  assert.ok(score(ball, wrongTempo) <= 40, `wrong tempo ${score(ball, wrongTempo)}`);
});

// ---- A body part plays the object (0.7.0) ----

/** Move the given landmark indices by the object's motion (raw camera: x opposite), leave the rest still. */
function partFollows(obj: (t: number) => Box, ids: readonly number[], { hide = [] as readonly number[] } = {}) {
  let mx = 0, my = 0;
  for (let t = 0; t < 20; t += 0.1) { mx += obj(t).cx; my += obj(t).cy; }
  mx /= 200; my /= 200;
  const raised = { ...STAND, rUpper: -150, rFore: -170, lUpper: 150, lFore: 170 }; // arms up, hands free to move
  const tl = timeline(() => raised, { durationS: 20 });
  return {
    ...tl,
    frames: tl.frames.map((f) => {
      const b = obj(f.tMs / 1000);
      const dx = -(b.cx - mx) * 0.6, dy = (b.cy - my) * 0.6;
      return { ...f, landmarks: f.landmarks!.map((l, k) => (hide.includes(k) ? ([l[0], l[1], 0] as const) : ids.includes(k) ? ([l[0] + dx, l[1] + dy, l[2]] as const) : l)) };
    }),
  };
}
const RIGHT_HAND = [16, 18, 20, 22], LEFT_HAND = [15, 17, 19, 21];

test("body part: a right hand bouncing with the ball scores well as the right hand, not as the body", () => {
  const player = partFollows(ball, RIGHT_HAND);
  const asHand = scoreTrajectoryRound(boxTrack(ball, 20), player, { bodyPart: "rightHand" });
  const asBody = scoreTrajectoryRound(boxTrack(ball, 20), player, { bodyPart: "body" });
  assert.ok(asHand.score !== null && asHand.score >= 85, `hand ${asHand.score}`);
  assert.ok(asBody.score !== null && asBody.score <= 10, `body ${asBody.score}`);
});

test("body part: moving the other hand does not count", () => {
  const r = scoreTrajectoryRound(boxTrack(car, 20), partFollows(car, LEFT_HAND), { bodyPart: "rightHand" });
  assert.ok(r.score !== null && r.score <= 10, `wrong hand ${r.score}`);
});

test("body part: works seated, with hips and legs out of view", () => {
  const hidden = [23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
  const r = scoreTrajectoryRound(boxTrack(pendulum, 20), partFollows(pendulum, RIGHT_HAND, { hide: hidden }), { bodyPart: "rightHand" });
  assert.equal(r.failure, null);
  assert.ok(r.score !== null && r.score >= 85, `seated hand ${r.score}`);
});

test("body part: the head follows a car when the whole body steps", () => {
  const r = scoreTrajectoryRound(boxTrack(car, 20), timeline(follow(car), { durationS: 20 }), { bodyPart: "head" });
  assert.ok(r.score !== null && r.score >= 85, `head ${r.score}`);
});
