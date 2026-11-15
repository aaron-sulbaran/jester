import assert from "node:assert/strict";
import { test } from "node:test";
import { linkTracks, mergeOverlapping, pointNearFrame, rankCandidates, rejoinTracks } from "../src/index.ts";
import type { Box, Detection, Track } from "../src/index.ts";
import { frame, person, trackOf, range } from "./synth.ts";

const box = (cx: number, cy = 0.5, w = 0.1, h = 0.4): Box => ({ cx, cy, w, h });

test("linkTracks: one person across 30 frames is one track of 30 points", () => {
  const frames = Array.from({ length: 30 }, (_, i) => frame(i, [person(box(0.3 + i * 0.005))]));
  const tracks = linkTracks(frames, []);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.points.length, 30);
  assert.equal(tracks[0]!.shot, 0);
  assert.equal(tracks[0]!.points[7]!.frame, 7);
  assert.equal(tracks[0]!.points[7]!.tMs, 700);
});

test("linkTracks: a gap of 8 frames keeps one track, a gap of 20 makes two", () => {
  const build = (missing: number) =>
    Array.from({ length: 40 }, (_, i) => frame(i, i >= 10 && i < 10 + missing ? [] : [person(box(0.5))]));
  assert.equal(linkTracks(build(8), []).length, 1);
  assert.equal(linkTracks(build(20), []).length, 2);
});

test("linkTracks: one odd box does not lose the person, even when the next box no longer overlaps it", () => {
  // Frame 20's box slides right (an arm thrown out), then the person steps left. The step does not
  // overlap the odd box, but it does overlap where the person usually was.
  const at = (i: number) => (i < 20 ? 0.3 : i === 20 ? 0.335 : 0.27);
  const frames = Array.from({ length: 40 }, (_, i) => frame(i, [person(box(at(i)))]));
  const tracks = linkTracks(frames, []);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.points.length, 40);
});

test("linkTracks: a second person beside someone already followed this frame gets their own track", () => {
  const frames = Array.from({ length: 20 }, (_, i) => frame(i, i < 10 ? [person(box(0.3))] : [person(box(0.3)), person(box(0.31))]));
  const tracks = linkTracks(frames, []);
  assert.equal(tracks.length, 2);
  assert.deepEqual(tracks.map((t) => t.points.length), [20, 10]);
});

test("linkTracks: two people side by side keep stable ids", () => {
  const frames = Array.from({ length: 20 }, (_, i) =>
    frame(i, [person(box(0.25 + i * 0.002)), person(box(0.75 - i * 0.002))]));
  const tracks = linkTracks(frames, []);
  assert.equal(tracks.length, 2);
  assert.deepEqual(tracks.map((t) => t.id), [0, 1]);
  for (const t of tracks) assert.equal(t.points.length, 20);
  assert.ok(tracks[0]!.points.every((p) => p.box.cx < 0.5));
  assert.ok(tracks[1]!.points.every((p) => p.box.cx > 0.5));
});

test("linkTracks: two people walking through each other stay two tracks", () => {
  const count = 31;
  const frames = Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1);
    // Same size and height, so overlap alone cannot tell them apart at the crossing.
    const leftToRight = person(box(0.2 + 0.6 * t));
    const rightToLeft = person(box(0.8 - 0.6 * t));
    return frame(i, [leftToRight, rightToLeft]);
  });
  const tracks = linkTracks(frames, []);
  assert.equal(tracks.length, 2);
  const starts = tracks.map((t) => t.points[0]!.box.cx);
  const ends = tracks.map((t) => t.points[t.points.length - 1]!.box.cx);
  const fromLeft = starts.findIndex((x) => x < 0.5);
  const fromRight = starts.findIndex((x) => x > 0.5);
  assert.ok(ends[fromLeft]! > 0.5, "the track that began on the left ends on the right");
  assert.ok(ends[fromRight]! < 0.5, "the track that began on the right ends on the left");
  for (const t of tracks) assert.equal(t.points.length, count);
});

test("linkTracks: a cut ends every track and moves on to the next shot", () => {
  const frames = Array.from({ length: 20 }, (_, i) => frame(i, [person(box(0.5))]));
  const tracks = linkTracks(frames, [10]);
  assert.equal(tracks.length, 2);
  assert.deepEqual(tracks.map((t) => t.shot), [0, 1]);
  assert.equal(tracks[0]!.points.length, 10);
  assert.equal(tracks[1]!.points[0]!.frame, 10);
});

/** Links and re-joins, as the clip side does. */
const follow = (frames: Parameters<typeof linkTracks>[0]) => rejoinTracks(linkTracks(frames, []));

test("rejoinTracks: one person who drops out for 20 frames comes back as the same track", () => {
  const frames = Array.from({ length: 80 }, (_, i) =>
    frame(i, i >= 30 && i < 50 ? [] : [person(box(i < 30 ? 0.5 : 0.53))]));
  assert.equal(linkTracks(frames, []).length, 2, "linking alone splits them");
  const tracks = follow(frames);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.id, 0);
  assert.equal(tracks[0]!.points.length, 60);
  assert.ok(tracks[0]!.points.every((p, i, all) => i === 0 || p.frame > all[i - 1]!.frame));
});

test("rejoinTracks: two different people one after the other stay two tracks", () => {
  const elsewhere = Array.from({ length: 80 }, (_, i) =>
    frame(i, i < 30 ? [person(box(0.2))] : i >= 40 ? [person(box(0.75))] : []));
  assert.equal(follow(elsewhere).length, 2, "a different place");
  const bigger = Array.from({ length: 80 }, (_, i) =>
    frame(i, i < 30 ? [person(box(0.5))] : i >= 40 ? [person(box(0.5, 0.5, 0.18, 0.75))] : []));
  assert.equal(follow(bigger).length, 2, "the same place but a much bigger person");
});

/** Two people swapping sides, 0.01 of the width a frame; each is missing on the frames given. */
function swap(missingLeft: (i: number) => boolean, missingRight: (i: number) => boolean) {
  return Array.from({ length: 61 }, (_, i) => {
    const people: Detection[] = [];
    if (!missingLeft(i)) people.push(person(box(0.2 + 0.01 * i)));
    if (!missingRight(i)) people.push(person(box(0.8 - 0.01 * i)));
    return frame(i, people);
  });
}

function assertSwapped(tracks: Track[]) {
  assert.equal(tracks.length, 2);
  for (const track of tracks) {
    const first = track.points[0]!.box.cx;
    const last = track.points[track.points.length - 1]!.box.cx;
    assert.ok(first < 0.5 ? last > 0.5 : last < 0.5, `track ${track.id} crossed over (${first} to ${last})`);
    assert.ok(track.points.every((p, i, all) => i === 0 || (first < 0.5 ? p.box.cx > all[i - 1]!.box.cx : p.box.cx < all[i - 1]!.box.cx)), `track ${track.id} kept one direction`);
  }
}

test("rejoinTracks: two people who swap sides while one is briefly lost are not merged into each other", () => {
  const tracks = follow(swap(() => false, (i) => i >= 25 && i <= 35));
  assertSwapped(tracks);
  assert.deepEqual(tracks.map((t) => t.points.length).sort((a, b) => a - b), [50, 61]);
});

test("rejoinTracks: two people lost together while crossing come back on the side each was heading", () => {
  const lost = (i: number) => i >= 26 && i <= 34;
  assertSwapped(follow(swap(lost, lost)));
  const longer = (i: number) => i >= 24 && i <= 44;
  assertSwapped(follow(swap(longer, longer)));
});

test("rejoinTracks: four dancers who drop on and off come out as four people", () => {
  const spots = [0.2, 0.4, 0.6, 0.8];
  const gone = (dancer: number, i: number) =>
    (dancer === 1 && i >= 20 && i < 45) || (dancer === 2 && i >= 30 && i < 50) || (dancer === 3 && i >= 70 && i < 82) || (dancer === 0 && i >= 100 && i < 130);
  const frames = Array.from({ length: 150 }, (_, i) => frame(i, spots.flatMap((cx, dancer) =>
    gone(dancer, i) ? [] : [person(box(cx + 0.02 * Math.sin(i / 6 + dancer), 0.5 + 0.01 * Math.cos(i / 5)))])));
  const linked = linkTracks(frames, []);
  assert.ok(linked.length > 4, "linking alone splits some dancers");
  const tracks = rejoinTracks(linked);
  assert.equal(tracks.length, 4);
  const people = rankCandidates(tracks, { sampleHz: 15, frameCount: frames.length });
  assert.equal(people.length, 4);
  for (const track of tracks) {
    const xs = track.points.map((p) => p.box.cx);
    assert.ok(Math.max(...xs) - Math.min(...xs) < 0.1, `track ${track.id} stayed with one dancer`);
  }
});

const piece = (id: number, from: number, to: number, cx: number, shot = 0): Track =>
  trackOf(id, range(from, to - from + 1), () => ({ cx, cy: 0.5, w: 0.2, h: 0.6 }), shot);

test("rejoinTracks: one person split three times becomes one track with the first id", () => {
  const joined = rejoinTracks([piece(1, 0, 39, 0.5), piece(2, 40, 79, 0.55), piece(3, 82, 120, 0.5)]);
  assert.equal(joined.length, 1);
  assert.equal(joined[0]!.id, 1);
  assert.equal(joined[0]!.points.length, 40 + 40 + 39);
});

test("rejoinTracks: two people side by side each keep their own pieces", () => {
  const joined = rejoinTracks([piece(1, 0, 30, 0.2), piece(2, 0, 30, 0.8), piece(3, 31, 60, 0.82), piece(4, 32, 60, 0.21)]);
  assert.deepEqual(joined.map((t) => [t.id, t.points.length, t.points.at(-1)!.box.cx]), [[1, 60, 0.21], [2, 61, 0.82]]);
});

test("rejoinTracks: overlapping in time, far apart, too long a gap and other shots stay apart", () => {
  assert.equal(rejoinTracks([piece(1, 0, 30, 0.5), piece(2, 20, 50, 0.5)]).length, 2);
  assert.equal(rejoinTracks([piece(1, 0, 30, 0.1), piece(2, 31, 50, 0.9)]).length, 2);
  assert.equal(rejoinTracks([piece(1, 0, 30, 0.5), piece(2, 90, 120, 0.5)]).length, 2);
  assert.equal(rejoinTracks([piece(1, 0, 30, 0.5), piece(2, 31, 60, 0.5, 1)]).length, 2);
  assert.equal(rejoinTracks([piece(1, 0, 30, 0.5), piece(2, 60, 90, 0.5)]).length, 1, "3 seconds or less joins");
});

test("rejoinTracks: a wide frame counts sideways steps in box heights", () => {
  // 0.3 of the width is half a box height in a square frame but 0.9 in a 16:9 one.
  const pieces = () => [piece(1, 0, 30, 0.4), piece(2, 31, 60, 0.7)];
  assert.equal(rejoinTracks(pieces(), { aspect: 1 }).length, 1);
  assert.equal(rejoinTracks(pieces(), { aspect: 16 / 9 }).length, 2);
});

test("pointNearFrame: the point at the frame, else the nearest, earlier on a tie", () => {
  const track = trackOf(0, [2, 3, 4, 10, 11], (f) => box(f / 20));
  assert.equal(pointNearFrame(track, 3)!.frame, 3);
  assert.equal(pointNearFrame(track, 7)!.frame, 4);
  assert.equal(pointNearFrame(track, 8)!.frame, 10);
  assert.equal(pointNearFrame(track, 0)!.frame, 2);
  assert.equal(pointNearFrame({ id: 1, shot: 0, points: [] }, 3), null);
});

test("mergeOverlapping: two pieces of one person that overlap with the same box become one track", () => {
  const a = trackOf(0, range(0, 31), () => box(0.3));
  const b = trackOf(1, range(25, 36), () => box(0.302));
  const merged = mergeOverlapping([a, b]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.id, 0);
  assert.deepEqual(merged[0]!.points.map((p) => p.frame), range(0, 61));
  assert.equal(merged[0]!.points[27]!.box.cx, 0.3, "a shared frame keeps the earlier track's point");
});

test("mergeOverlapping: two tracks that traded one person's frames become one track", () => {
  // The pose model saw her twice at frame 30; then her frames went to one track or the other until 40.
  const traded = range(31, 9);
  const a = trackOf(0, [...range(0, 31), ...traded.filter((f) => f % 2 === 1)], () => box(0.3));
  const b = trackOf(1, [30, ...traded.filter((f) => f % 2 === 0), ...range(40, 21)], () => box(0.3));
  const merged = mergeOverlapping([a, b]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]!.points.map((p) => p.frame), range(0, 61));
});

test("mergeOverlapping: two people side by side, two people crossing, and a newcomer in an old spot stay apart", () => {
  const sideBySide = [trackOf(0, range(0, 61), () => box(0.3)), trackOf(1, range(0, 61), () => box(0.42))];
  assert.equal(mergeOverlapping(sideBySide).length, 2);
  const crossing = [trackOf(0, range(0, 41), (f) => box(0.2 + 0.015 * f)), trackOf(1, range(0, 41), (f) => box(0.8 - 0.015 * f))];
  assert.equal(mergeOverlapping(crossing).length, 2);
  // The first person walks off to the right; someone else steps into the spot they left while they are still in view.
  const newcomer = [trackOf(0, range(0, 41), (f) => box(0.3 + 0.01 * f)), trackOf(1, range(30, 31), () => box(0.3))];
  assert.equal(mergeOverlapping(newcomer).length, 2);
  const otherShot = [trackOf(0, range(0, 31), () => box(0.3)), trackOf(1, range(25, 36), () => box(0.3), 1)];
  assert.equal(mergeOverlapping(otherShot).length, 2);
});
