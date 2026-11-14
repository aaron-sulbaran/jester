# Clip Side Extraction (Version 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an uploaded video of people into a saved, repeatable guide for one confirmed person, and refuse clips that cannot be used, with an on-screen overlay to judge the extraction by eye.

**Architecture:** Pure logic lives in a new `clip/` package (TypeScript, no dependencies, tested by Node, same habits as `engine/`). Browser work (hashing, saving, decoding frames, running the tracker) lives in `app/src/clipside/`, where the app's packages resolve. `app/src/clip.ts` stays the app's single entry to the clip side and keeps the `Clip` shape the shell already uses.

**Tech Stack:** TypeScript 5.7 strict, Node 22.18+ test runner, Vite 6, Mediabunny (WebCodecs), MediaPipe Pose Landmarker 0.10.14 loaded from the CDN constants in `spikes/pose-match/webcam.mjs`, IndexedDB, Web Crypto.

**Spec:** `docs/design/clip-side.md`. This plan covers its stages 0 to 5 for people. Out of scope here: the object detector and box path for non-people, the AI check, the 30 per second second pass, a worker (Version 1 runs on the page and yields between frames), sharing guides.

## Global Constraints

- TypeScript strict, with the same compiler options as `engine/tsconfig.json`. Do not loosen them.
- `clip/` has no runtime dependencies and no DOM. `app/` may add exactly one package: `mediabunny`.
- Use npm, as the repo does. Tests run with `node --test`.
- No em dashes in code, comments, strings or docs. Plain words in anything a player reads.
- Do not change the MediaPipe version or the `MP_BUNDLE`, `MP_WASM`, `MODEL_URLS` constants; import them from `spikes/pose-match/webcam.mjs`.
- Before writing code against Mediabunny or MediaPipe, read their current docs (Context7, or the package's own docs). Do not guess an API.
- Public functions that can fail return `{ data, error }` (`error` is a sentence a player can read, or null). Do not throw across the `app/src/clip.ts` boundary.
- No video files in the repo. Copy no code from outside this repo.
- Coordinates are MediaPipe normalized image coordinates, unmirrored, as in `engine/src/types.ts`.
- Commit as the repo's configured identity on branch `aaron/clip-extract`. Before editing `app/src/main.ts`, `app/src/round.ts` or `app/index.html`, run `../hack-princeton-hub/hub pulse "<what and why>"` from the repo.
- Starting numbers from the spec, used verbatim: 15 samples per second; first 30 seconds only; up to 4 people; tracks under 1 second dropped; refuse under 3 seconds, more than one cut every 2 seconds, subject in under half the frames of its shot, subject under a quarter of the frame height.

## Review Focus

1. A phone clip stored sideways: frames must come out upright, so the skeleton sits on the person (Task 5, manual check).
2. A clip the browser cannot decode: a plain refusal sentence, never a hang or a blank screen (Task 5, manual check; Task 6 shows the sentence).
3. Two people crossing paths: the chosen track must not silently switch to the other person (Task 1 test).
4. A clip with no person: refusal "No person found in this clip." and the page stays usable (Task 3 test; Task 6 manual check).
5. The same file opened twice: the second open skips tracking and yields a deep-equal guide (Task 4 test for the builder; Task 6 manual check).

---

### Task 1: The `clip/` package, shared types, boxes, and linking detections into tracks

**Files:**
- Create: `clip/package.json`, `clip/tsconfig.json` (copies of the engine's, name `@jester/clip`), `clip/src/types.ts`, `clip/src/boxes.ts`, `clip/src/tracks.ts`, `clip/src/index.ts`, `clip/test/synth.ts`, `clip/test/boxes.test.ts`, `clip/test/tracks.test.ts`

**Interfaces:**
- Consumes: `Landmark`, `PoseTimeline`, `BoxTrack` from `../../engine/src/index.ts`.
- Produces (in `types.ts`):

```ts
export interface Box { cx: number; cy: number; w: number; h: number }
export interface Detection { box: Box; landmarks: readonly Landmark[] }
export interface FrameDetections { tMs: number; people: Detection[]; signature: number[] }
export interface TrackPoint { frame: number; tMs: number; box: Box; landmarks: readonly Landmark[] }
export interface Track { id: number; shot: number; points: TrackPoint[] }
export interface ClipSource { width: number; height: number; durationMs: number; sampleHz: number }
export type Pace = "slow" | "medium" | "fast";
export interface Candidate { trackId: number; number: number; label: string; score: number; boxAtConfirm: Box | null }
export interface Guide {
  schema: "guide/1";
  fingerprint: string;
  source: ClipSource;
  range: { startMs: number; endMs: number };   // media time of the shot used; timeline tMs starts at 0 at startMs
  subject: { kind: "person" | "thing"; label: string };
  channel: "pose" | "trajectory";
  timeline: PoseTimeline | null;
  boxTrack: BoxTrack;
  keyMoments: { tMs: number }[];
  pace: Pace;
  warnings: string[];
  check: null;                                 // the AI form arrives in Version 2
}
```

- Produces (functions): `boxFromLandmarks(landmarks: readonly Landmark[], minVisibility?: number): Box | null` (default 0.3; null when fewer than 4 points qualify); `iou(a: Box, b: Box): number`; `linkTracks(frames: readonly FrameDetections[], cuts: readonly number[], options?: { minIou?: number; maxGap?: number }): Track[]` (defaults 0.3 and 5 frames).

- [ ] **Step 1: Write failing tests.** `boxes.test.ts`: a box around known points has the expected centre and size; `iou` is 1 for identical boxes, 0 for disjoint, 1/3 for two unit squares offset by half a width. `tracks.test.ts` with helpers in `synth.ts` that make a person's 33 landmarks inside a given box: one person across 30 frames gives one track of 30 points; a person missing for 3 frames keeps one track, missing for 8 frames gives two; two people side by side give two tracks with stable ids; two people who walk through each other give exactly two tracks, and the track that starts on the left ends on the right while the track that starts on the right ends on the left; a cut index ends every track and increments `shot`.
- [ ] **Step 2: Run `npm test` in `clip/`.** Expected: fails, modules not found.
- [ ] **Step 3: Implement.** Linking is greedy per frame: score every live track against every detection by IoU with the track's last box, take pairs in descending IoU (ties by track id, then detection index), each used once, skipping pairs under `minIou`. For the crossing case, break IoU ties and near ties (within 0.1) by which pairing keeps each track's box centre moving in its previous direction. Unmatched detections start new tracks; a track unmatched for more than `maxGap` frames ends.
- [ ] **Step 4: Run `npm run check` in `clip/`.** Expected: typecheck clean, all tests pass.
- [ ] **Step 5: Commit** `clip: package, shared types, boxes, linking detections into tracks`.

### Task 2: Cut detection and shots

**Files:**
- Create: `clip/src/cuts.ts`, `clip/test/cuts.test.ts`. Modify: `clip/src/index.ts`.

**Interfaces:**
- Produces: `frameSignature(rgba: Uint8ClampedArray, width: number, height: number): number[]` (24 numbers: 8 bins each for red, green, blue, each channel summing to 1); `signatureDistance(a: readonly number[], b: readonly number[]): number` (0 to 1); `findCuts(signatures: readonly (readonly number[])[], options?: { threshold?: number; ratio?: number }): number[]` (index of the first frame of each new shot; defaults 0.35 and 3); `shotRanges(frameCount: number, cuts: readonly number[]): { start: number; end: number }[]` (end exclusive).

- [ ] **Step 1: Write failing tests.** Identical frames have distance 0; an all-black against an all-white frame has distance 1; 20 frames of one colour then 20 of another give `[20]`; a slow fade over 20 frames gives `[]`; a steady pan (every pair differs by the same moderate amount, above 0.35) gives `[]` because of the ratio rule; `shotRanges(40, [20])` is `[{start:0,end:20},{start:20,end:40}]`.
- [ ] **Step 2: Run tests, expect failure.**
- [ ] **Step 3: Implement.** A frame is a cut when its distance to the previous frame is at least `threshold` and at least `ratio` times the median distance of up to 8 preceding pairs (when that median is above 0).
- [ ] **Step 4: Run `npm run check`.** Expected: pass.
- [ ] **Step 5: Commit** `clip: cut detection and shot ranges`.

### Task 3: Ranking candidates and the refusal rules

**Files:**
- Create: `clip/src/rank.ts`, `clip/src/rules.ts`, `clip/test/rank.test.ts`, `clip/test/rules.test.ts`. Modify: `clip/src/index.ts`.

**Interfaces:**
- Consumes: `Track`, `Candidate`, `ClipSource` from Task 1; `shotRanges` from Task 2.
- Produces: `motionPerFrame(track: Track): number` (mean landmark movement between consecutive points, in box heights); `rankCandidates(tracks: readonly Track[], info: { sampleHz: number; frameCount: number }): Candidate[]`; `pickConfirmFrame(candidates: readonly Candidate[], tracks: readonly Track[]): number`; `withConfirmBoxes(candidates: readonly Candidate[], tracks: readonly Track[], frame: number): Candidate[]` (copies with `boxAtConfirm` filled; `rankCandidates` leaves it null); `checkClip(input: { durationMs: number; cuts: readonly number[]; candidates: readonly Candidate[] }): { refuse: string | null; warnings: string[] }`; `checkSubject(track: Track, shot: { start: number; end: number }): { refuse: string | null; warnings: string[] }`.
- Exact sentences: "This clip is under 3 seconds. Pick a longer one." / "This clip cuts too often to follow one person." / "No person found in this clip." / "The person you picked is out of view for most of the clip." / "The person is too small in the frame. Pick a clip where they fill more of it." / warning "Nothing much moves here. This will be a hold-this-pose round."

- [ ] **Step 1: Write failing tests.** Ranking: tracks shorter than `sampleHz` points are dropped; of two equal tracks the larger box ranks first; of two equal tracks the one that moves ranks first; numbers run 1 to n in rank order and labels are "Person 1" and so on; `pickConfirmFrame` returns the earliest frame where the most candidates are present, and `withConfirmBoxes` gives each candidate its box at that frame or null. Rules: each sentence above is returned for its condition (2.9 seconds; 16 cuts in 30 seconds; no candidates; subject present in 40 percent of its shot; median box height 0.2); a still subject yields the warning and no refusal; a normal clip yields no refusal and no warnings.
- [ ] **Step 2: Run tests, expect failure.**
- [ ] **Step 3: Implement.** Score = 0.35 size + 0.2 central + 0.25 motion + 0.2 time on screen, each 0 to 1: size is the median box height; central is 1 minus twice the distance of the median centre x from 0.5 (floored at 0); motion is `motionPerFrame` divided by 0.05, capped at 1; time on screen is points over `frameCount`. "Nothing moves" means `motionPerFrame` under 0.002.
- [ ] **Step 4: Run `npm run check`.** Expected: pass.
- [ ] **Step 5: Commit** `clip: rank candidates, refusal rules`.

### Task 4: Key moments, pace, and building the guide

**Files:**
- Create: `clip/src/moments.ts`, `clip/src/guide.ts`, `clip/test/moments.test.ts`, `clip/test/guide.test.ts`. Modify: `clip/src/index.ts`. Create `clip/README.md` (what the package does, how to run its checks, in under 150 words).

**Interfaces:**
- Consumes: `skeletonGate` and types from the engine; Tasks 1 to 3.
- Produces: `keyMoments(timeline: PoseTimeline): { tMs: number }[]`; `paceOf(track: Track, sampleHz: number): Pace`; `buildGuide(input: { fingerprint: string; source: ClipSource; frames: readonly FrameDetections[]; track: Track; shot: { start: number; end: number }; label: string; warnings: string[] }): Guide`.

- [ ] **Step 1: Write failing tests.** Moments: port the cases in `spikes/pose-match/level.test.mjs` to `PoseTimeline` input (held poses are found, moments are at least 1.2 seconds apart, a timeline with no holds falls back to evenly spaced moments, between 4 and 8 results). Pace: movement under 0.3 box heights per second is "slow", under 1.0 "medium", otherwise "fast". Guide: timeline `tMs` starts at 0 at the shot's first frame and `range` holds the media times; frames inside the shot where the track has no point carry `landmarks: null` and `box: null`; `boxTrack.frames` and `timeline.frames` have equal length; `channel` equals `skeletonGate(timeline).channel`; calling `buildGuide` twice with the same input gives deep-equal results; `check` is null.
- [ ] **Step 2: Run tests, expect failure.**
- [ ] **Step 3: Implement.** `keyMoments` is a TypeScript port of `buildLevel` in `spikes/pose-match/level.mjs` with its constants unchanged.
- [ ] **Step 4: Run `npm run check`.** Expected: pass.
- [ ] **Step 5: Commit** `clip: key moments, pace, guide builder`.

### Task 5: Browser side: fingerprint, saved analysis, frames, people detector, prepare and finish

**Files:**
- Create: `app/src/clipside/fingerprint.ts`, `store.ts`, `frames.ts`, `detect.ts`, `analyze.ts`. Modify: `app/package.json` (add `mediabunny`), `app/tsconfig.json` (include `../clip/src`).

**Interfaces:**
- Produces:

```ts
export function sha256Hex(blob: Blob): Promise<string>;
export interface Prepared {
  fingerprint: string; source: ClipSource; frames: FrameDetections[]; cuts: number[];
  tracks: Track[]; candidates: Candidate[]; confirmFrame: number; confirmTMs: number;
  warnings: string[]; decoder: "webcodecs" | "video-element"; fromSaved: boolean;
}
export function prepareClip(file: File, video: HTMLVideoElement, onProgress: (share: number) => void): Promise<{ data: Prepared; error: null } | { data: null; error: string }>;
export function finishClip(prepared: Prepared, trackId: number): { data: Guide; error: null } | { data: null; error: string };
export function loadPrepared(fingerprint: string): Promise<Prepared | null>;
export function savePrepared(prepared: Prepared): Promise<void>;
```

- [ ] **Step 1: Read the docs** for Mediabunny (opening a `File`, checking that the video track can be decoded, getting canvases at chosen timestamps with rotation applied and a size limit) and for MediaPipe `PoseLandmarker` (`numPoses`, `detectForVideo`, time stamp rules).
- [ ] **Step 2: Implement `frames.ts`:** `readFrames(file, video, { sampleHz: 15, maxMs: 30000, maxSide: 720 }, onFrame)` decodes through Mediabunny at fixed times `i * 1000 / sampleHz`, in order, calling `await onFrame({ tMs, canvas, index, count })` and yielding to the page between frames. If Mediabunny cannot decode the file, fall back to stepping `video.currentTime` and waiting for `seeked`, as today's `analyzeVideo` does. If both fail, return the error "This browser cannot read that video. Save it as an H.264 MP4 and try again."
- [ ] **Step 3: Implement `detect.ts`:** a pose tracker with `numPoses: 4`, model `full`, `runningMode: "VIDEO"`, GPU then CPU, a fresh instance per clip. `detect(canvas, tMs)` passes `tMs` as the time stamp (raised by 1 if it would not increase) and returns `Detection[]` using `boxFromLandmarks`.
- [ ] **Step 4: Implement `analyze.ts` and `store.ts`.** `prepareClip`: fingerprint; return the saved analysis if one exists (`fromSaved: true`); otherwise read frames, compute each frame's `signature` from a 32 pixel wide copy, detect people, then `findCuts`, `linkTracks`, `rankCandidates`, `pickConfirmFrame`, `checkClip`; save; return. A refusal from `checkClip` is returned as `error`. When the file is longer than 30 seconds, `warnings` includes "This clip is longer than 30 seconds, so only the first 30 are used." `finishClip` runs `checkSubject` and `buildGuide`. The store is IndexedDB database `jester`, object store `prepared`, keyed by fingerprint, holding records with `schema: "prepared/1"`.
- [ ] **Step 5: Run `npm run build` in `app/`.** Expected: typecheck and build pass.
- [ ] **Step 6: Commit** `app: clip side browser work (fingerprint, saved analysis, frames, people detector)`.

### Task 6: Wire it into the app: confirm step, shot range, preview

**Files:**
- Modify: `app/src/clip.ts`, `app/src/main.ts`, `app/src/round.ts`, `app/index.html`, `app/src/style.css`, `app/README.md`.

**Interfaces:**
- Consumes: Task 5.
- Produces in `app/src/clip.ts`: `Clip` gains `guide: Guide | null` and `offsetMs: number` (0 for the starter clip); `prepareVideo(file, video, onProgress)` and `confirmSubject(prepared, trackId, videoUrl): { data: Clip; error: null } | { data: null; error: string }`; `analyzeVideo` is removed; `starterClip()` is unchanged apart from the two new fields.

- [ ] **Step 1: Pulse** the files, then rewire `clip.ts`. `Clip.samples` is built from the guide's timeline so the existing overlay and live meter keep working.
- [ ] **Step 2: Confirm panel** in `index.html` and `main.ts`: after a file is prepared, show the frame at `confirmTMs` with each candidate's numbered box, the top candidate selected, one button per candidate, and "Use this person". It appears even with one candidate. Errors from `prepareVideo` and `confirmSubject` go to the status line as they are. Keep the styling plain; the look is being redesigned.
- [ ] **Step 3: Shot range.** In `round.ts` and `main.ts`, clip time is `video.currentTime * 1000 - clip.offsetMs`; a round starts the video at `offsetMs` and ends at `offsetMs + durationMs` or on `ended`.
- [ ] **Step 4: Preview button** "Preview the guide": plays the confirmed range once with the skeleton drawn over the video, no camera, no score.
- [ ] **Step 5: Run `npm run build` in `app/`, and `npm run check` in `clip/` and `engine/`.** Expected: all pass.
- [ ] **Step 6: Manual checks in a browser,** recorded in `app/README.md` under "Checked" and "Not checked" with what was actually seen: the starter clip still plays a simulated round to a score; a real clip of one person shows the confirm panel and the preview skeleton sits on the person; a sideways phone clip comes out upright; a clip with no person shows "No person found in this clip." and another file can be picked; an undecodable file shows the H.264 sentence; the same file opened twice skips tracking the second time.
- [ ] **Step 7: Commit** `app: confirm the subject, play only its shot, preview the guide`, push, and open a pull request.
