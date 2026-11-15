// Object clips: subjects with no skeleton (a ball, a car, a pendulum), given as a box over time
// (`box-track/1`). The engine scores them with its trajectory channel: the player copies the object
// with their whole body. These starter objects stand in until the clip side extracts real ones.

import type { BodyPart, BoxTrack, LandmarkObject } from "../../engine/src/index.ts";
import { makeStickPose, POSES } from "../../spikes/pose-match/synthetic.mjs";
import type { CaptureFn, Player } from "./round.ts";

type Box = { cx: number; cy: number; w: number; h: number };

export interface ObjectClip {
  kind: "object";
  name: string;
  /** What to tell the player, e.g. "Bounce with the ball". */
  hint: string;
  track: BoxTrack;
  durationMs: number;
  width: number;
  height: number;
  /** The object's box at clip time `ms`, or null when it is not visible. */
  boxAt(ms: number): Box | null;
}

const WIDTH = 1280, HEIGHT = 720, FPS = 30, DURATION_S = 20;

const PATHS: Record<string, { hint: string; path: (t: number) => Box }> = {
  ball: {
    hint: "Bounce with the ball: jump, or bob with your knees.",
    path: (t) => ({ cx: 0.5, cy: 0.75 - 0.4 * Math.abs(Math.sin((Math.PI * t) / 1.2)), w: 0.08, h: 0.08 * (16 / 9) }),
  },
  car: {
    hint: "Drive with the car: step sideways when it moves, stop when it stops.",
    path: (t) => {
      const c = t % 10;
      const x = c < 4 ? 0.1 + 0.8 * (c / 4) : c < 5 ? 0.9 : c < 9 ? 0.9 - 0.8 * ((c - 5) / 4) : 0.1;
      return { cx: x, cy: 0.72, w: 0.18, h: 0.14 };
    },
  },
  pendulum: {
    hint: "Swing with the pendulum: sway side to side.",
    path: (t) => ({ cx: 0.5 + 0.2 * Math.sin((2 * Math.PI * t) / 3), cy: 0.5 + 0.05 * Math.cos((4 * Math.PI * t) / 3), w: 0.06, h: 0.06 * (16 / 9) }),
  },
};

export const OBJECT_NAMES = Object.keys(PATHS);

export function objectClip(name: string): ObjectClip {
  const { path, hint } = PATHS[name]!;
  const frames = [];
  for (let i = 0; i <= DURATION_S * FPS; i++) {
    const tMs = (i * 1000) / FPS;
    frames.push({ tMs, box: path(tMs / 1000) });
  }
  return {
    kind: "object", name, hint,
    track: { schema: "box-track/1", source: { width: WIDTH, height: HEIGHT }, frames },
    durationMs: DURATION_S * 1000, width: WIDTH, height: HEIGHT,
    boxAt: (ms) => (ms < 0 || ms > DURATION_S * 1000 ? null : path(ms / 1000)),
  };
}

/**
 * A stand-in player for object clips (no camera): a standing stick figure that steps with the object
 * (smaller steps, as a person in front of a laptop would) and rises when it rises. Emits raw camera
 * coordinates, so it moves the opposite way on x, like a real person seen by an unmirrored camera.
 */
/** Landmarks that move with each body part in the simulated player. */
const PART_POINTS: Record<Exclude<BodyPart, "body">, number[]> = {
  rightHand: [16, 18, 20, 22], leftHand: [15, 17, 19, 21], head: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  rightFoot: [28, 30, 32], leftFoot: [27, 29, 31],
};

export function simulatedObjectPlayer(clip: ObjectClip, effort: () => number, part: BodyPart = "body", lagMs = 150): Player {
  let timer = 0;
  let capture: CaptureFn | null = null;
  const aspect = 4 / 3;
  let mx = 0, my = 0, count = 0;
  for (let ms = 0; ms <= clip.durationMs; ms += 100) { const b = clip.boxAt(ms); if (b) { mx += b.cx; my += b.cy; count++; } }
  mx /= count || 1; my /= count || 1;
  return {
    start(onFrame, clipClockMs) {
      const loop = () => {
        const ms = clipClockMs();
        const b = ms >= 0 ? clip.boxAt(Math.max(0, ms - lagMs)) : null;
        const k = effort();
        let landmarks: LandmarkObject[] | null = null;
        if (b && part === "body") {
          landmarks = makeStickPose(POSES.rest, { centerX: 0.5 - (b.cx - mx) * 0.5 * k, groundY: 0.92 + 0.6 * (b.cy - my) * k, aspect }) as LandmarkObject[];
        } else if (b) {
          // Arms up so the hands are free; only the chosen part moves (a hand travels further than a body).
          const pose = makeStickPose(POSES.armsUp, { aspect }) as LandmarkObject[];
          const ids = new Set(PART_POINTS[part as Exclude<BodyPart, "body">]);
          const dx = -(b.cx - mx) * 0.6 * k, dy = (b.cy - my) * 0.6 * k;
          landmarks = pose.map((l, i) => (ids.has(i) ? { ...l, x: l.x + dx, y: l.y + dy } : l));
        } else if (ms >= 0) landmarks = makeStickPose(POSES.rest, { aspect }) as LandmarkObject[];
        onFrame({ t: performance.now(), landmarks, aspect, mirrored: false, clipTimeMs: ms });
        if (capture && landmarks && ms >= 0) capture({ landmarks, mask: null, source: null, width: 640, height: 480, clipMs: ms });
      };
      timer = window.setInterval(loop, 1000 / 30);
    },
    stop() { clearInterval(timer); capture = null; },
    setCapture(fn) { capture = fn; },
  };
}
