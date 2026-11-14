# Jester accuracy engine

Scores how well a player copied a clip subject. Pure TypeScript, no DOM, no dependencies at runtime. Same inputs always give the same result, bit for bit. Owner: Alex. Design and sources: hub `sources/2026-11-14-alex-accuracy-engine-research.md`.

## Use

```ts
import { fromClipSamples, fromWebcamFrames, scorePoseRound, comparePoses, skeletonGate, scoreTrajectoryRound } from "./engine/src/index.ts";

const clip = fromClipSamples(samples, { width, height, timeUnit: "s" });        // clip subject
const player = fromWebcamFrames(webcamFrames, { trackerTimeAtClipStartMs });   // Lisa's webcam.mjs frames

const gate = skeletonGate(clip);              // "pose" or "trajectory" for this clip
const result = scorePoseRound(clip, player);  // score 0..100, tier, lag, worst limb, per-frame credits

// Live feedback during play (not the final score):
const live = comparePoses(clipFrameLandmarks, playerFrameLandmarks, { referenceAspect, playerAspect });
```

For subjects with no usable skeleton (cartoons, sprites, objects), pass a `box-track/1` (the subject's box per frame) to `scoreTrajectoryRound(boxTrack, player)`.

## Inputs

- `PoseTimeline` (`src/types.ts`): frames of `{ tMs, landmarks }`, landmarks as 33 `[x, y, visibility]` in MediaPipe normalized image coordinates, unmirrored, or `null` when nobody is found. `tMs` is on the clip's clock; timestamps may be uneven (the engine resamples to a 30 Hz grid).
- `source.mirrored`: true only if the camera pixels were flipped before tracking.
- Adapters accept the landmark objects `{x, y, z, visibility}` the CV modules emit.

## How the pose score works

1. Each body becomes 12 limb directions (arms weigh 1.5, legs 1, torso lines 0.75, head 0.5). Size, distance and framing do not matter. The player is compared as a mirror image.
2. Per limb: full credit within 15 degrees, zero past 60, `1 - x^2` between. Limbs under 0.5 visibility drop out.
3. Limbs the performer is moving weigh more than limbs they hold still.
4. One global lag (-200 to +800 ms) is found for the round, with 100 ms slack per frame. Lag up to 300 ms is free.
5. The score counts only accuracy above what standing still would earn on the same clip, so doing nothing scores near 0.
6. More than 30 percent unscorable frames: no score, "low tracking".

All constants are in `src/constants.ts` with `SCORER_VERSION`. They are starting values; calibrate on real recordings.

## Trajectory channel

Player hip (or shoulder) motion in torso lengths against the box's motion in box heights: velocity correlation at one global lag, above a chance baseline from fixed circular shifts, plus matched events (jump, crouch, move left or right) scored by F1 within 250 ms.

## Develop

```
cd engine
npm install
npm run check   # typecheck + tests (Node 22.18+ runs the .ts files directly)
```
