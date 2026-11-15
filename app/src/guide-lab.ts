// Guide lab (guide-lab.html): the three jester puppets on trial, side by side on one drawn dancer who turns
// all the way round, so the team can pick one. Uses the game's own drawing (clipside/blind.ts) on a guide
// built here, with the tracker's depth or without it. Dev only.

import { boxFromLandmarks, type Guide } from "../../clip/src/index.ts";
import { blindView, drawBlindBackground, drawBlindSubject, guidePoseAt, type BlindStyle } from "./clipside/blind.ts";
import { CONSTRUCTIONS, type Construction, type StageLook } from "./clipside/puppet.ts";

const W = 1280, H = 720, HZ = 15, DURATION_S = 12, ASPECT = W / H, SCALE = 0.45;
type V = [number, number, number];

const smooth = (t: number) => { const u = Math.min(1, Math.max(0, t)); return u * u * (3 - 2 * u); };

/** The dancer's turn in degrees at `t` seconds: still, round to the back, on round to the front, then a sway. */
function yawAt(t: number): number {
  if (t < 1.5) return 0;
  if (t < 4) return 180 * smooth((t - 1.5) / 2.5);
  if (t < 5.5) return 180;
  if (t < 8) return 180 + 180 * smooth((t - 5.5) / 2.5);
  return 40 * Math.sin((2 * Math.PI * (t - 8)) / 4);
}

/** The dancer's joints at `t` in body space: x toward their left, y up, z away from the camera, in metres. */
function joints(t: number): Record<number, V> {
  const arm = (side: 1 | -1, phase: number): V[] => {
    const raise = (25 + 75 * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 3 + phase))) * (Math.PI / 180);
    const bend = raise + 0.4;
    const s: V = [0.18 * side, 1.42, 0];
    const e: V = [s[0] + side * Math.sin(raise) * 0.27, s[1] - Math.cos(raise) * 0.27, -0.03];
    const w: V = [e[0] + side * Math.sin(bend) * 0.25, e[1] - Math.cos(bend) * 0.25, -0.06];
    const h: V = [w[0] + side * Math.sin(bend) * 0.08, w[1] - Math.cos(bend) * 0.08, -0.07];
    return [s, e, w, h];
  };
  const bob = 0.03 * Math.sin(2 * Math.PI * t);
  const [ls, le, lw, lhand] = arm(1, 0);
  const [rs, re, rw, rhand] = arm(-1, Math.PI);
  const j: Record<number, V> = {
    0: [0, 1.62, -0.1], 1: [0.02, 1.65, -0.09], 2: [0.035, 1.65, -0.08], 3: [0.05, 1.65, -0.07],
    4: [-0.02, 1.65, -0.09], 5: [-0.035, 1.65, -0.08], 6: [-0.05, 1.65, -0.07],
    7: [0.075, 1.6, 0], 8: [-0.075, 1.6, 0], 9: [0.025, 1.56, -0.08], 10: [-0.025, 1.56, -0.08],
    11: ls!, 12: rs!, 13: le!, 14: re!, 15: lw!, 16: rw!,
    17: lhand!, 18: rhand!, 19: lhand!, 20: rhand!, 21: lw!, 22: rw!,
    23: [0.1, 0.92, 0], 24: [-0.1, 0.92, 0],
    25: [0.11, 0.5, -0.04 - Math.max(0, bob) * 2], 26: [-0.11, 0.5, -0.04 - Math.max(0, -bob) * 2],
    27: [0.11, 0.08, 0.02], 28: [-0.11, 0.08, 0.02],
    29: [0.11, 0.03, 0.06], 30: [-0.11, 0.03, 0.06], 31: [0.12, 0.0, -0.12], 32: [-0.12, 0.0, -0.12],
  };
  // The body bobs; the feet stay on the floor.
  for (let i = 0; i <= 26; i++) j[i] = [j[i]![0], j[i]![1] - Math.abs(bob), j[i]![2]];
  return j;
}

/** The dancer as a guide, sampled like a real clip, with or without the tracker's depth. */
function dancerGuide(withDepth: boolean): Guide {
  const timeline: { tMs: number; landmarks: [number, number, number][] }[] = [];
  const depths: number[][] = [];
  for (let f = 0; f <= DURATION_S * HZ; f++) {
    const t = f / HZ;
    const yaw = (yawAt(t) * Math.PI) / 180;
    const step = 0.12 * Math.sin((2 * Math.PI * t) / 6);
    // The face fades from the tracker's view as the back comes round.
    const face = 0.1 + 0.9 * smooth((Math.cos(yaw) + 0.25) / 0.4);
    const j = joints(t);
    const lm: [number, number, number][] = [], depth: number[] = [];
    for (let i = 0; i < 33; i++) {
      const [x, y, z] = j[i]!;
      const xr = x * Math.cos(yaw) - z * Math.sin(yaw), zr = x * Math.sin(yaw) + z * Math.cos(yaw);
      lm.push([0.5 + (xr * SCALE + step) / ASPECT, 0.93 - y * SCALE, i <= 10 ? face : 1]);
      depth.push(Math.round(((zr * SCALE) / ASPECT) * 1e4) / 1e4);
    }
    timeline.push({ tMs: (f * 1000) / HZ, landmarks: lm });
    depths.push(depth);
  }
  const frames = timeline.map((f) => ({ tMs: f.tMs, box: boxFromLandmarks(f.landmarks) }));
  return {
    schema: "guide/1", fingerprint: `lab:turn:${withDepth}`, source: { width: W, height: H, durationMs: DURATION_S * 1000, sampleHz: HZ },
    range: { startMs: 0, endMs: DURATION_S * 1000 }, subject: { kind: "person", label: "the dancer" }, channel: "pose",
    timeline: { schema: "pose-timeline/1", source: { width: W, height: H, mirrored: false }, frames: timeline },
    boxTrack: { schema: "box-track/1", source: { width: W, height: H }, frames },
    outlines: frames.map(() => null),
    ...(withDepth ? { depths } : {}),
    keyMoments: [], pace: "medium", warnings: [], check: null,
  };
}

/** A one-frame guide blended between the samples around frame position `pos`, as the game does. */
function sliceAt(g: Guide, pos: number): Guide {
  const last = g.boxTrack.frames.length - 1;
  const p = Math.min(last, Math.max(0, pos));
  const i = Math.floor(p), j = Math.min(last, i + 1), u = p - i;
  const lerp = (a: number, b: number) => a + (b - a) * u;
  const l0 = g.timeline!.frames[i]!.landmarks!, l1 = g.timeline!.frames[j]!.landmarks!;
  const landmarks = l0.map(([x, y, v], k) => [lerp(x, l1[k]![0]), lerp(y, l1[k]![1]), Math.min(v, l1[k]![2])] as const);
  const d0 = g.depths?.[i], d1 = g.depths?.[j];
  return {
    ...g,
    boxTrack: { ...g.boxTrack, frames: [{ tMs: 0, box: boxFromLandmarks(landmarks) }] },
    outlines: [null],
    timeline: { ...g.timeline!, frames: [{ tMs: 0, landmarks }] },
    depths: d0 && d1 ? [d0.map((z, k) => lerp(z, d1[k]!))] : undefined,
  };
}

const guides = { depth: dancerGuide(true), flat: dancerGuide(false) };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const colorPick = $<HTMLSelectElement>("color"), depthBox = $<HTMLInputElement>("depth"), pauseBox = $<HTMLInputElement>("pause");
const timeSlider = $<HTMLInputElement>("time");
const params = new URLSearchParams(location.search);

interface Panel { canvas: HTMLCanvasElement; puppet: () => Construction; stage: () => StageLook }

function select<T extends string>(label: string, values: [T, string][], value: T): [HTMLLabelElement, () => T] {
  const wrap = document.createElement("label");
  wrap.textContent = `${label} `;
  const s = document.createElement("select");
  for (const [v, text] of values) {
    const o = document.createElement("option");
    o.value = v; o.textContent = text; o.selected = v === value;
    s.append(o);
  }
  wrap.append(s);
  return [wrap, () => s.value as T];
}

const panels: Panel[] = (["a", "b", "c"] as const).map((id) => {
  const box = document.createElement("section");
  box.className = "option";
  const h = document.createElement("h2");
  h.textContent = id.toUpperCase();
  const p = document.createElement("p");
  p.textContent = CONSTRUCTIONS[id];
  const [puppetLabel, puppet] = select<Construction>("Puppet", [["a", "A sticker"], ["b", "B cut paper"], ["c", "C paper doll"]], id);
  const [stageLabel, stage] = select<StageLook>("Stage", [["plain", "Plain"], ["spot", "Spotlight"]], params.get("stage") === "spot" ? "spot" : "plain");
  const picks = document.createElement("div");
  picks.className = "pick";
  picks.append(puppetLabel, stageLabel);
  puppetLabel.querySelector("select")!.addEventListener("change", () => { p.textContent = CONSTRUCTIONS[puppet()]; });
  const canvas = document.createElement("canvas");
  // The shape the guide has while playing: half of a 16:9 stage.
  canvas.width = 480; canvas.height = 540;
  box.append(h, p, picks, canvas);
  $("options").append(box);
  return { canvas, puppet, stage };
});

const views = new Map<string, ReturnType<typeof blindView>>();
let clock = 0, last = performance.now();

function tick(now: number) {
  requestAnimationFrame(tick);
  const dt = (now - last) / 1000;
  last = now;
  if (!pauseBox.checked) {
    clock = (clock + dt) % DURATION_S;
    timeSlider.value = String(clock / DURATION_S);
  } else {
    clock = Number(timeSlider.value) * DURATION_S;
  }
  const guide = depthBox.checked ? guides.depth : guides.flat;
  const pos = clock * HZ;
  const slice = sliceAt(guide, pos);
  const pose = guidePoseAt(guide, pos);
  for (const [i, panel] of panels.entries()) {
    const key = `${guide.fingerprint}:${i}`;
    let view = views.get(key);
    if (!view) { view = blindView(guide, panel.canvas, "fit"); views.set(key, view); }
    const style: BlindStyle = { background: "#16161d", color: colorPick.value, stage: panel.stage(), puppet: panel.puppet() };
    drawBlindBackground(panel.canvas, guide, view, style, pose);
    drawBlindSubject(panel.canvas, slice, 0, "puppet", view, style, pose);
  }
}
timeSlider.addEventListener("input", () => { pauseBox.checked = true; });
// ?at=<seconds> holds the dancer at that moment, for stills.
const at = Number(params.get("at"));
if (params.has("at") && Number.isFinite(at)) { pauseBox.checked = true; timeSlider.value = String(Math.min(1, Math.max(0, at / DURATION_S))); }
requestAnimationFrame(tick);
