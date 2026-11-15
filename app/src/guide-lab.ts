// Guide lab (guide-lab.html): the jester puppets on trial (the 3D jester, then the flat sticker and the flat
// cut paper for comparison), side by side on one drawn dancer who turns all the way round, so the team can pick. Uses the game's own drawing (clipside/blind.ts) on a guide
// built here, with the tracker's depth or without it. Dev only.

import { boxFromLandmarks, type Guide } from "../../clip/src/index.ts";
import { blindView, drawBlind, drawBlindBackground, drawBlindSubject, guideGaveWay, guidePoseAt, guideSliceAt, startGuideTurn, steadyGuide, type BlindStyle } from "./clipside/blind.ts";
import { CONSTRUCTIONS, JESTER_COLOURS, type Construction, type StageLook } from "./clipside/puppet.ts";

const W = 1280, H = 720, HZ = 15, DURATION_S = 12, ASPECT = W / H, SCALE = 0.45;
type V = [number, number, number];


/** Eases in and out with no jolt at either end (smootherstep). */
const ease = (t: number) => { const u = Math.min(1, Math.max(0, t)); return u * u * u * (u * (u * 6 - 15) + 10); };

/** The dancer's turn in degrees at `t` seconds: a beat facing us, one full turn, then a sway side to side. */
function yawAt(t: number): number {
  if (t < 1) return 0;
  if (t < 7) return 360 * ease((t - 1) / 6);
  return 30 * Math.sin((2 * Math.PI * (t - 7)) / 2.5) * ease((t - 7) / 0.8) * ease((12 - t) / 0.8);
}

/**
 * The dancer's joints at `t` in body space: x toward their left, y up, z away from the camera, in metres.
 * A bounce on a 0.8 s beat bends the knees (they come forward, the bones keep their length), the hips sway,
 * the arms swing up and down out of step with each other with the elbows bending, and the head nods.
 */
function joints(t: number): Record<number, V> {
  const beat = (2 * Math.PI * t) / 0.8, bar = (2 * Math.PI * t) / 1.6;
  const bounce = 0.05 * (0.5 - 0.5 * Math.cos(beat));
  const sway = 0.035 * Math.sin(bar);
  const arm = (side: 1 | -1, phase: number): V[] => {
    const raise = ((30 + 75 * (0.5 + 0.5 * Math.sin(bar + phase))) * Math.PI) / 180;
    const bend = raise + 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(bar + phase + 1.2));
    const reach = -0.08 * (0.5 + 0.5 * Math.sin(bar + phase + 0.6));
    const s: V = [0.18 * side - sway * 0.4, 1.42 - bounce, 0];
    const e: V = [s[0] + side * Math.sin(raise) * 0.27, s[1] - Math.cos(raise) * 0.27, reach];
    const w: V = [e[0] + side * Math.sin(bend) * 0.25, e[1] - Math.cos(bend) * 0.25, reach * 2];
    const h: V = [w[0] + side * Math.sin(bend) * 0.08, w[1] - Math.cos(bend) * 0.08, reach * 2.2];
    return [s, e, w, h];
  };
  const leg = (side: 1 | -1): V[] => {
    const hip: V = [0.1 * side + sway, 0.92 - bounce, 0];
    const ankle: V = [0.11 * side, 0.08, 0.02];
    const half = (hip[1] - ankle[1]) / 2;
    const forward = Math.sqrt(Math.max(0, 0.42 * 0.42 - half * half));
    const knee: V = [(hip[0] + ankle[0]) / 2, (hip[1] + ankle[1]) / 2, -forward];
    return [hip, knee, ankle];
  };
  const [ls, le, lw, lhand] = arm(1, 0);
  const [rs, re, rw, rhand] = arm(-1, Math.PI * 0.9);
  const [lh, lk, la] = leg(1);
  const [rh, rk, ra] = leg(-1);
  const nod = 0.012 * Math.sin(beat + 0.5);
  const headY = 1.62 - bounce + nod, hx = -sway * 0.3;
  const j: Record<number, V> = {
    0: [hx, headY, -0.1], 1: [hx + 0.02, headY + 0.03, -0.09], 2: [hx + 0.035, headY + 0.03, -0.08], 3: [hx + 0.05, headY + 0.03, -0.07],
    4: [hx - 0.02, headY + 0.03, -0.09], 5: [hx - 0.035, headY + 0.03, -0.08], 6: [hx - 0.05, headY + 0.03, -0.07],
    7: [hx + 0.075, headY - 0.02, 0], 8: [hx - 0.075, headY - 0.02, 0], 9: [hx + 0.025, headY - 0.06, -0.08], 10: [hx - 0.025, headY - 0.06, -0.08],
    11: ls!, 12: rs!, 13: le!, 14: re!, 15: lw!, 16: rw!,
    17: lhand!, 18: rhand!, 19: lhand!, 20: rhand!, 21: lw!, 22: rw!,
    23: lh!, 24: rh!, 25: lk!, 26: rk!, 27: la!, 28: ra!,
    29: [0.11, 0.03, 0.06], 30: [-0.11, 0.03, 0.06], 31: [0.12, 0.0, -0.12], 32: [-0.12, 0.0, -0.12],
  };
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
    const face = 0.1 + 0.9 * ease((Math.cos(yaw) + 0.25) / 0.4);
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

// Made steady once, as blind mode does with its roles.
const guides = { depth: steadyGuide(dancerGuide(true)), flat: steadyGuide(dancerGuide(false)) };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const colorPick = $<HTMLSelectElement>("color");
// Every colourway a player can pick on the cast screen; ?color=Red starts on one.
for (const c of JESTER_COLOURS) {
  const o = document.createElement("option");
  o.value = c.main; o.textContent = c.name; o.selected = c.name.toLowerCase() === (new URLSearchParams(location.search).get("color") ?? "").toLowerCase();
  colorPick.append(o);
}
const depthBox = $<HTMLInputElement>("depth"), pauseBox = $<HTMLInputElement>("pause");
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

const panels: Panel[] = (["d", "a", "b"] as const).map((id) => {
  const box = document.createElement("section");
  box.className = "option";
  const h = document.createElement("h2");
  h.textContent = id === "d" ? "3D" : id.toUpperCase();
  const p = document.createElement("p");
  p.textContent = CONSTRUCTIONS[id];
  const [puppetLabel, puppet] = select<Construction>("Puppet", [["d", "3D jester"], ["a", "A flat sticker"], ["b", "B flat cut paper"]], id);
  const [stageLabel, stage] = select<StageLook>("Stage", [["plain", "Plain"], ["spot", "Spotlight"]], params.get("stage") === "spot" ? "spot" : "plain");
  const picks = document.createElement("div");
  picks.className = "pick";
  picks.append(puppetLabel, stageLabel);
  puppetLabel.querySelector("select")!.addEventListener("change", () => { p.textContent = CONSTRUCTIONS[puppet()]; });
  const canvas = document.createElement("canvas");
  // The shape the guide has while playing: half of a 16:9 stage. ?phone=1 shows it the way a 390 px wide
  // phone does: drawn on the game's 640 px wide canvas and shown about 118 by 133 px.
  if (params.get("phone") === "1") {
    canvas.width = 640; canvas.height = 721;
    canvas.style.width = "118px"; canvas.style.height = "133px";
  } else {
    canvas.width = 480; canvas.height = 540;
  }
  box.append(h, p, picks, canvas);
  $("options").append(box);
  return { canvas, puppet, stage };
});

const views = new Map<string, ReturnType<typeof blindView>>();
let clock = 0, last = performance.now();

function tick(now: number) {
  if (!benchGuide) requestAnimationFrame(tick);
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
  const slice = guideSliceAt(guide, pos);
  const pose = guidePoseAt(guide, pos);
  for (const [i, panel] of panels.entries()) {
    const key = `${guide.fingerprint}:${i}`;
    let view = views.get(key);
    if (!view) { view = blindView(guide, panel.canvas, "fit", "puppet"); views.set(key, view); }
    const style: BlindStyle = { background: "#16161d", color: colorPick.value, stage: panel.stage(), puppet: panel.puppet() };
    drawBlindBackground(panel.canvas, guide, view, style, pose);
    drawBlindSubject(panel.canvas, slice, 0, "puppet", view, style, pose);
  }
}
timeSlider.addEventListener("input", () => { pauseBox.checked = true; });

// ?bench=stick|a|d: draws one 640 x 720 guide as a turn does (the stage, the faint look-ahead copy, the figure)
// for 5 s after a 1.5 s warm-up, timing each frame's drawing; results in window.__bench.
const benchGuide = params.get("bench");
if (benchGuide) {
  const canvas = panels[0]!.canvas, scratch = document.createElement("canvas");
  canvas.width = 640; canvas.height = 720;
  const guide = guides.depth;
  const view = blindView(guide, canvas, "fit", benchGuide === "stick" ? "stick" : "puppet");
  const style: BlindStyle = benchGuide === "stick" ? { background: "#16161d", color: "#F47FA6" } : { background: "#16161d", color: "#F47FA6", stage: "plain", puppet: benchGuide === "a" ? "a" : "d" };
  const leadS = 0.5;
  const times: number[] = [], stamps: number[] = [];
  // As a turn does: the guard measures the first second and may hand the rest to the stick figure.
  startGuideTurn(benchGuide === "stick" ? null : benchGuide === "a" ? "a" : "d");
  const t0 = performance.now();
  const step = (now: number) => {
    const t = ((now - t0) / 1000) % DURATION_S;
    const pos = t * HZ, lead = (t + leadS) * HZ;
    const a = performance.now();
    if (benchGuide === "stick") {
      scratch.width = canvas.width; scratch.height = canvas.height;
      drawBlind(scratch, guideSliceAt(guide, lead), 0, "stick", view, style);
      drawBlind(canvas, guideSliceAt(guide, pos), 0, "stick", view, style);
      const ctx = canvas.getContext("2d")!;
      ctx.save(); ctx.globalAlpha = 0.3; ctx.globalCompositeOperation = "lighter"; ctx.drawImage(scratch, 0, 0); ctx.restore();
    } else {
      drawBlindBackground(canvas, guide, view, style, guidePoseAt(guide, pos));
      scratch.width = canvas.width; scratch.height = canvas.height;
      drawBlindSubject(scratch, guideSliceAt(guide, lead), 0, "puppet", view, { ...style, faint: true }, guidePoseAt(guide, lead));
      const ctx = canvas.getContext("2d")!;
      ctx.save(); ctx.globalAlpha = 0.3; ctx.drawImage(scratch, 0, 0); ctx.restore();
      drawBlindSubject(canvas, guideSliceAt(guide, pos), 0, "puppet", view, style, guidePoseAt(guide, pos));
    }
    const ms = performance.now() - a;
    if (now - t0 > 1500) { times.push(ms); stamps.push(now); }
    if (now - t0 < 6500) { requestAnimationFrame(step); return; }
    const sorted = [...times].sort((x, y) => x - y);
    const span = (stamps[stamps.length - 1]! - stamps[0]!) / 1000;
    (window as unknown as { __bench: unknown }).__bench = {
      guide: benchGuide, frames: times.length,
      avgMs: +(times.reduce((x, y) => x + y, 0) / times.length).toFixed(2),
      p95Ms: +sorted[Math.floor(sorted.length * 0.95)]!.toFixed(2), worstMs: +sorted[sorted.length - 1]!.toFixed(2),
      fps: +((times.length - 1) / span).toFixed(1),
      gaveWay: guideGaveWay(),
    };
    document.title = "bench done";
  };
  requestAnimationFrame(step);
}
// ?at=<seconds> holds the dancer at that moment, for stills.
const at = Number(params.get("at"));
if (params.has("at") && Number.isFinite(at)) { pauseBox.checked = true; timeSlider.value = String(Math.min(1, Math.max(0, at / DURATION_S))); }
if (!benchGuide) requestAnimationFrame(tick);
