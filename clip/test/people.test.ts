import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkSubject, linkTracks, rankCandidates, rejoinTracks, shotRanges, trackPeople } from "../src/index.ts";
import type { Landmark } from "../../engine/src/index.ts";
import type { Detection, FrameDetections } from "../src/index.ts";

/**
 * Recorded from a real 30 second clip of two people working out side by side (the gym duo test
 * clip), as the game's pose model saw it: numbers only, no pictures. Each frame lists its people as
 * [cx, cy, w, h, then x, y, visibility for each joint in `joints`], positions in thousandths of the
 * frame and visibility in hundredths. Joints not listed (face, hands, feet) are left unseen.
 * On the code before the fixes this clip gave one role: the right-hand dancer was split into pieces.
 */
const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s[s.length >> 1]!; };

interface Recorded { source: { width: number; height: number; durationMs: number; sampleHz: number }; cuts: number[]; joints: number[]; frames: number[][][] }

function load(name: string): { frames: FrameDetections[]; cuts: number[]; sampleHz: number; aspect: number } {
  const recorded = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Recorded;
  const detection = (row: number[]): Detection => {
    const landmarks: Landmark[] = Array.from({ length: 33 }, () => [row[4]! / 1000, row[5]! / 1000, 0]);
    recorded.joints.forEach((joint, k) => { landmarks[joint] = [row[4 + 3 * k]! / 1000, row[5 + 3 * k]! / 1000, row[6 + 3 * k]! / 100]; });
    return { box: { cx: row[0]! / 1000, cy: row[1]! / 1000, w: row[2]! / 1000, h: row[3]! / 1000 }, landmarks, outline: null };
  };
  const { sampleHz } = recorded.source;
  return {
    frames: recorded.frames.map((people, i) => ({ tMs: (i * 1000) / sampleHz, people: people.map(detection), signature: [] })),
    cuts: recorded.cuts,
    sampleHz,
    aspect: recorded.source.width / recorded.source.height,
  };
}

test("trackPeople: the recorded gym duo gives two roles, one per dancer, each seen most of the clip", () => {
  const { frames, cuts, sampleHz, aspect } = load("gym-duo.json");
  const { tracks } = trackPeople(frames, cuts, { sampleHz, aspect });
  const shot = shotRanges(frames.length, cuts)[0]!;
  const roles = rankCandidates(tracks, { sampleHz, frameCount: frames.length })
    .map((c) => tracks.find((t) => t.id === c.trackId)!)
    .filter((track) => checkSubject(track, shot).refuse === null);
  assert.equal(roles.length, 2);
  const seen = roles.map((t) => t.points.length / frames.length);
  assert.ok(seen.every((s) => s > 0.5), `each role seen in more than half the frames: ${seen.map((s) => s.toFixed(2))}`);
  // One role per dancer: one on the left of the frame, one on the right.
  const sides = roles.map((t) => median(t.points.map((p) => p.box.cx)) < 0.5 ? "left" : "right").sort();
  assert.deepEqual(sides, ["left", "right"]);
  // The right-hand dancer is found on about 92% of frames; one track holds nearly all of them.
  assert.ok(Math.max(...seen) > 0.9, `the right-hand dancer is one track: ${seen.map((s) => s.toFixed(2))}`);
});

test("trackPeople: identity repair leaves no more people-sized tracks than it was given on the recorded gym duo", () => {
  const { frames, cuts, sampleHz, aspect } = load("gym-duo.json");
  const joined = rejoinTracks(linkTracks(frames, cuts, { maxGap: sampleHz }), { maxGap: 3 * sampleHz, aspect });
  const { tracks } = trackPeople(frames, cuts, { sampleHz, aspect });
  const peopleSized = (list: readonly { points: readonly unknown[] }[]) => list.filter((t) => t.points.length >= sampleHz).length;
  assert.ok(peopleSized(tracks) <= peopleSized(joined), `${peopleSized(joined)} before repair, ${peopleSized(tracks)} after`);
});
