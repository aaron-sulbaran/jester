import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleTimeline, fitToCharacter, composeFrame, drawComposite, winnerIndex, PLAYER_COLORS } from "./reveal.mjs";
import { mirrorPose } from "./score.mjs";
import { makeStickPose, POSES } from "./synthetic.mjs";

const mid = (pose, a, b, aspect = 1) => ({ x: (pose[a].x + pose[b].x) / 2 * aspect, y: (pose[a].y + pose[b].y) / 2 });
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
const frames = [0, 100, 200, 300, 1000].map((t) => ({ t, landmarks: makeStickPose(POSES.rest) }));

test("sampling picks the nearest frame and refuses big gaps", () => {
  assert.equal(sampleTimeline(frames, 110).t, 100);
  assert.equal(sampleTimeline(frames, 190).t, 200);
  assert.equal(sampleTimeline(frames, 650), null);
  assert.equal(sampleTimeline([], 0), null);
});

test("a fitted player has the character's hips and torso length", () => {
  const player = makeStickPose(POSES.tPose);
  const character = makeStickPose(POSES.squat).map((p) => ({ ...p, x: p.x * 0.5 + 0.1, y: p.y * 0.8 + 0.1 })); // smaller, elsewhere
  const fit = fitToCharacter(player, 4 / 3, character, 16 / 9);
  const toHip = mid(character, 23, 24, 16 / 9), fitHip = mid(fit, 23, 24, 16 / 9);
  assert.ok(dist(toHip, fitHip) < 1e-9);
  assert.ok(Math.abs(dist(mid(fit, 11, 12, 16 / 9), fitHip) - dist(mid(character, 11, 12, 16 / 9), toHip)) < 1e-9);
});

test("fitting keeps the pose shape: limb directions match the mirrored player", () => {
  const player = makeStickPose(POSES.leftArmUp);
  const character = makeStickPose(POSES.rest);
  const fit = fitToCharacter(player, 1, character, 1);
  const mirrored = mirrorPose(player);
  const dirA = (pose) => { const dx = pose[15].x - pose[13].x, dy = pose[15].y - pose[13].y, n = Math.hypot(dx, dy); return [dx / n, dy / n]; };
  const [a, b] = [dirA(fit), dirA(mirrored)];
  assert.ok(Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9);
});

test("missing pose gives null; mirror can be switched off", () => {
  assert.equal(fitToCharacter(null, 1, makeStickPose(POSES.rest), 1), null);
  const p = makeStickPose(POSES.leftArmUp), c = makeStickPose(POSES.rest);
  assert.notDeepEqual(fitToCharacter(p, 1, c, 1, { mirror: true }), fitToCharacter(p, 1, c, 1, { mirror: false }));
});

test("composeFrame gives each role its own colour and null where the recording has a hole", () => {
  const character = makeStickPose(POSES.rest);
  const roles = [
    { timeline: { aspect: 4 / 3, frames }, characterPose: character },
    { timeline: { aspect: 4 / 3, frames: [{ t: 0, landmarks: makeStickPose(POSES.rest) }] }, characterPose: character },
  ];
  const at650 = composeFrame(roles, 650, { playerAspect: 4 / 3, clipAspect: 16 / 9 });
  assert.equal(at650[0].pose, null);
  assert.equal(at650[0].color, PLAYER_COLORS[0]);
  const at100 = composeFrame(roles, 100, { playerAspect: 4 / 3, clipAspect: 16 / 9 });
  assert.ok(at100[0].pose && at100[0].pose.length === 33);
  assert.equal(at100[1].pose, null);
  assert.equal(at100[1].color, PLAYER_COLORS[1]);
});

test("drawComposite draws every visible bone and skips missing figures", () => {
  const calls = { moveTo: 0, lineTo: 0, arc: 0 };
  const ctx = new Proxy({}, { get: (_, k) => (k in calls ? () => { calls[k]++; } : () => {}), set: () => true });
  const pose = makeStickPose(POSES.rest);
  drawComposite(ctx, 100, 100, [{ pose, color: "#fff" }, { pose: null, color: "#000" }]);
  assert.equal(calls.moveTo, 12);
  assert.equal(calls.lineTo, 12);
  assert.equal(calls.arc, 1);
});

test("winner is the best score, ties keep the first, nulls are skipped", () => {
  assert.equal(winnerIndex([70, 91, 91]), 1);
  assert.equal(winnerIndex([null, 40]), 1);
  assert.equal(winnerIndex([null, null]), -1);
});
