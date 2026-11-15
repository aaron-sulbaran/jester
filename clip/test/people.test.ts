import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { boxFromLandmarks, checkSubject, linkTracks, rankCandidates, rejoinTracks, shotRanges, trackPeople } from "../src/index.ts";
import type { Landmark } from "../../engine/src/index.ts";
import type { Detection, FrameDetections } from "../src/index.ts";
import { AVERAGE_BUILD, bodyLandmarks, type Build } from "./synth.ts";

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

test("trackPeople: two dancers of different builds who meet in the middle and part keep their own tracks", () => {
  // As in identity repair's own check: landmark noise, they meet in the middle and part back, and the
  // one in front hides the other for 10 frames. Every point must end on its own dancer's track.
  const LONG_LEGS: Build = { ...AVERAGE_BUILD, upperArm: 0.38, forearm: 0.33, thigh: 0.75, shin: 0.7 };
  const LONG_ARMS: Build = { ...AVERAGE_BUILD, upperArm: 0.55, forearm: 0.5, thigh: 0.5, shin: 0.45, shoulders: 0.6 };
  const count = 150;
  const meet = (f: number) => Math.sin((Math.PI * f) / (count - 1));
  let seed = 7;
  const noise = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 - 0.5) * 0.008; };
  const who = new Map<Detection, "A" | "B">();
  const dancer = (cx: number, build: Build, f: number, name: "A" | "B"): Detection => {
    const landmarks = bodyLandmarks(cx, 0.6, 0.15, build, 10 * Math.sin(f / 3)).map(([x, y, v]) => [x + noise(), y + noise(), v] as const);
    const detection: Detection = { box: boxFromLandmarks(landmarks)!, landmarks, outline: null };
    who.set(detection, name);
    return detection;
  };
  const frames: FrameDetections[] = Array.from({ length: count }, (_, f) => {
    const a = dancer(0.3 + 0.17 * meet(f), LONG_LEGS, f, "A");
    const hidden = f >= 70 && f < 80;
    const people = hidden ? [a] : [a, dancer(0.7 - 0.17 * meet(f), LONG_ARMS, f, "B")];
    return { tMs: (f * 1000) / 15, people: f % 2 === 0 ? people : people.reverse(), signature: [] };
  });
  const { tracks } = trackPeople(frames, [], { sampleHz: 15, aspect: 1 });
  const main = [...tracks].sort((x, y) => y.points.length - x.points.length).slice(0, 2);
  let wrong = 0;
  for (const track of main) {
    const names = track.points.map((p) => frames[p.frame]!.people.find((d) => d.box === p.box)).map((d) => who.get(d!));
    const mostly = names.filter((n) => n === "A").length >= names.length / 2 ? "A" : "B";
    wrong += names.filter((n) => n !== mostly).length;
  }
  assert.equal(wrong, 0);
  assert.deepEqual(main.map((t) => t.points.length).sort((x, y) => x - y), [140, 150]);
});
