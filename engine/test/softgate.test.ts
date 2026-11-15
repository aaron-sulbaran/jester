// 0.12.0 gain gate. Before, the plain accuracy credit opened only on motion share (in-step motion), linear from
// 0.15. Just under that the credit was thrown away: Alex's honest round (share 0.14, accuracy 0.86, still
// baseline 0.81) scored 28 while the turn before (share 0.66) scored 83. Now clearly beating standing still
// also opens it, on a smooth ramp, as far as the player moved at all.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MOTION } from "../src/constants.ts";
import { scorePoseRound } from "../src/index.ts";
import { motionGain } from "../src/pose.ts";
import { mirrorCopy, STAND, timeline, type Pose2D } from "./synth.ts";

test("soft gate: a real attempt just under the share line gains about the same as one just over", () => {
  // Alex's round r-mwheswpa-kh05t6: share 0.136, still gate 1, gain over still 0.276, credit 0.698.
  const under = motionGain(MOTION.gateLow - 0.01, 1, 0.276, 0.698);
  const over = motionGain(MOTION.gateLow + 0.01, 1, 0.276, 0.698);
  assert.ok(under.gain > 0.6, `under: ${under.gain}`);
  assert.ok(Math.abs(over.gain - under.gain) < 0.03, `${under.gain} vs ${over.gain}`);
  // 0.11.0 gave only the gain over still here.
  assert.ok(under.gain > 2 * 0.276);
});

test("soft gate: no cliff anywhere: small steps in share or gain over still move the gain a little", () => {
  const step = 0.005;
  // Steepest part of a smoothstep is 1.5 over its width; the gain gate is a product of two of them.
  const maxSlope = Math.max(1 / (MOTION.gateHigh - MOTION.gateLow),
    1.5 / (MOTION.gainGateHigh - MOTION.gainGateLow) + 1.5 / (MOTION.gainGateShareHigh - MOTION.gainGateShareLow)) + 1;
  for (const stillGate of [0, 0.5, 1]) {
    for (let s = 0; s <= 1; s += 0.05) {
      for (let g = 0; g < 1; g += step) {
        const credit = Math.min(1, 0.5 + g / 2);
        const a = motionGain(s, stillGate, g, credit).gain, b = motionGain(s, stillGate, g + step, credit).gain;
        const c = motionGain(s + step, stillGate, g, credit).gain;
        assert.ok(Math.abs(b - a) <= maxSlope * step + 1e-9, `gos step at s ${s} g ${g}: ${a} -> ${b}`);
        assert.ok(Math.abs(c - a) <= maxSlope * step + 1e-9, `share step at s ${s} g ${g}: ${a} -> ${c}`);
      }
    }
  }
});

test("soft gate: standing still opens nothing, whatever the gain over still", () => {
  // A statue's own standing pose can beat the fixed still pose (up to about 0.18 on saved rounds; 0.26 here).
  for (const gos of [0, 0.18, 0.26, 0.5]) {
    const m = motionGain(0, 0, gos, 0.75);
    assert.equal(m.gainGate, 0);
    assert.equal(m.gain, 0);
  }
});

test("soft gate: moves with nothing in step (waving while the clip rests) do not open the gain gate", () => {
  // On a clip that mostly stands, holding its resting posture beats the fixed still pose by about 0.3.
  for (const gos of [0.2, 0.3, 0.5]) {
    const m = motionGain(0, 1, gos, 0.8);
    assert.equal(m.gainGate, 0);
    assert.equal(m.gain, gos);
  }
});

test("soft gate: wrong moves (moving, not beating still) get only the 0.11.0 share gate", () => {
  for (const share of [0, 0.1, 0.2, 0.3]) {
    for (const gos of [0, 0.1, MOTION.gainGateLow]) {
      const m = motionGain(share, 1, gos, 0.5);
      assert.equal(m.gainGate, 0);
      assert.equal(m.gate, m.shareGate);
      assert.equal(m.shareGate, Math.max(0, Math.min(1, (share - MOTION.gateLow) / (MOTION.gateHigh - MOTION.gateLow))));
    }
  }
});

/** A clip that mostly stands, with a right-hand wave for 2 s out of every 4 s (as in still.test.ts). */
function wave(t: number): Pose2D {
  const on = t % 4 < 2 ? Math.sin(Math.PI * ((t % 4) / 2)) : 0;
  return { ...STAND, lUpper: 14, lFore: 18, rUpper: -14 - 50 * on, rFore: -18 - 120 * on + 35 * on * Math.sin(2 * Math.PI * 2 * t) };
}
const D = 16;
const ref = timeline(wave, { durationS: D });

test("soft gate: on a mostly standing clip, a statue stays at 0 and wrong moves stay low", () => {
  const statue = scorePoseRound(ref, timeline(() => wave(0), { durationS: D, transform: mirrorCopy }));
  assert.ok(statue.motion.gainOverStill > MOTION.gainGateLow, `statue gain over still ${statue.motion.gainOverStill}`);
  assert.equal(statue.motion.gainGate, 0);
  assert.ok(statue.score !== null && statue.score <= 10, `statue ${statue.score}`);
  // The same wave, but 2 s out of step (past the lag search): the moves are real, just not the clip's.
  const offbeat = scorePoseRound(ref, timeline((t) => wave(t + 2), { durationS: D, transform: mirrorCopy }));
  assert.ok(offbeat.motion.stillGate > 0.5, `offbeat moved ${offbeat.motion.moved}`);
  // Nothing in step, so the gain gate stays shut and only the gain over still (posture) counts, as in 0.11.0.
  assert.equal(offbeat.motion.gainGate, 0);
  assert.ok(offbeat.score !== null && offbeat.score < 30, `offbeat ${offbeat.score}`);
});

test("soft gate: the result reports the gates and the gain follows them; identical inputs give identical output", () => {
  const player = timeline((t) => wave(Math.floor(t / 1.2) * 1.2), { durationS: D, transform: mirrorCopy, delayMs: 300 });
  const a = scorePoseRound(ref, player);
  const m = a.motion;
  assert.equal(m.gate, Math.max(m.shareGate, m.gainGate));
  assert.equal(m.gain, Math.max(m.stillGate * m.gainOverStill, m.gate * m.credit));
  assert.ok(m.gainGate >= 0 && m.gainGate <= m.stillGate);
  const b = scorePoseRound(JSON.parse(JSON.stringify(ref)), JSON.parse(JSON.stringify(player)));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
