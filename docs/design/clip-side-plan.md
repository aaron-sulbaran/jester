# Clip Side Extraction (Version 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an uploaded video of people into a saved, repeatable guide for one confirmed person, and refuse clips that cannot be used, with an on-screen overlay to judge the extraction by eye.

**Architecture:** Pure logic lives in a new `clip/` package (TypeScript, no dependencies, tested by Node, same habits as `engine/`). Browser work (hashing, saving, decoding frames, running the tracker) lives in `app/src/clipside/`, where the app's packages resolve. `app/src/clip.ts` stays the app's single entry to the clip side and keeps the `Clip` shape the shell already uses.

**Tech Stack:** TypeScript 5.7 strict, Node 22.18+ test runner, Vite 6, Mediabunny (WebCodecs), MediaPipe Pose Landmarker 0.10.14 loaded from the CDN constants in `spikes/pose-match/webcam.mjs`, IndexedDB, Web Crypto.

**Spec:** `docs/design/clip-side.md`. This plan covers its stages 0 to 5 for people. Tasks 7 and 8 were added at 6:40 PM for the team's blind mode: an outline per subject, and things as subjects. Out of scope here: the AI check, the 30 per second second pass, a worker (the build runs on the page and yields between frames), sharing guides.

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
- Commit as the repo's configured identity on branch `aaron/clip-extract`. Do not edit `app/src/main.ts`, `app/src/round.ts`, `app/index.html` or `app/src/style.css`: a teammate is building blind mode there.
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
export function subjectGuides(prepared: Prepared): { guides: Guide[]; skipped: { number: number; reason: string }[] };
export function loadPrepared(fingerprint: string): Promise<Prepared | null>;
export function savePrepared(prepared: Prepared): Promise<void>;
```

- [ ] **Step 1: Read the docs** for Mediabunny (opening a `File`, checking that the video track can be decoded, getting canvases at chosen timestamps with rotation applied and a size limit) and for MediaPipe `PoseLandmarker` (`numPoses`, `detectForVideo`, time stamp rules).
- [ ] **Step 2: Implement `frames.ts`:** `readFrames(file, video, { sampleHz: 15, maxMs: 30000, maxSide: 720 }, onFrame)` decodes through Mediabunny at fixed times `i * 1000 / sampleHz`, in order, calling `await onFrame({ tMs, canvas, index, count })` and yielding to the page between frames. If Mediabunny cannot decode the file, fall back to stepping `video.currentTime` and waiting for `seeked`, as today's `analyzeVideo` does. If both fail, return the error "This browser cannot read that video. Save it as an H.264 MP4 and try again."
- [ ] **Step 3: Implement `detect.ts`:** a pose tracker with `numPoses: 4`, model `full`, `runningMode: "VIDEO"`, GPU then CPU, a fresh instance per clip. `detect(canvas, tMs)` passes `tMs` as the time stamp (raised by 1 if it would not increase) and returns `Detection[]` using `boxFromLandmarks`.
- [ ] **Step 4: Implement `analyze.ts` and `store.ts`.** `prepareClip`: fingerprint; return the saved analysis if one exists (`fromSaved: true`); otherwise read frames, compute each frame's `signature` from a 32 pixel wide copy, detect people, then `findCuts`, `linkTracks`, `rankCandidates`, `pickConfirmFrame`, `checkClip`; save; return. A refusal from `checkClip` is returned as `error`. When the file is longer than 30 seconds, `warnings` includes "This clip is longer than 30 seconds, so only the first 30 are used." `finishClip` runs `checkSubject` and `buildGuide`. `subjectGuides` does the same for every candidate, in rank order: blind mode gives each player one subject, so it needs them all; a candidate that `checkSubject` refuses goes to `skipped` with its sentence. The store is IndexedDB database `jester`, object store `prepared`, keyed by fingerprint, holding records with `schema: "prepared/1"`.
- [ ] **Step 5: Run `npm run build` in `app/`.** Expected: typecheck and build pass.
- [ ] **Step 6: Commit** `app: clip side browser work (fingerprint, saved analysis, frames, people detector)`.

### Task 6: The app's entry points and a clip lab page

Blind mode is being built in the main screens by a teammate, and the look is being redesigned, so this task does not edit `app/src/main.ts`, `app/src/round.ts`, `app/index.html` or `app/src/style.css`.

**Files:**
- Modify: `app/src/clip.ts`, `app/README.md`.
- Create: `app/clip-lab.html`, `app/src/clip-lab.ts`.

**Interfaces:**
- Consumes: Task 5.
- Produces in `app/src/clip.ts`: `Clip` gains `guide: Guide | null` (null for the starter clip). `analyzeVideo(file, video, onProgress): Promise<Clip>` keeps its signature for the existing shell: it runs `prepareClip`, takes the top candidate, and returns a whole-clip `Clip` on media time from 0, with `samples` at every analysed frame (landmarks null where that person is absent); on a refusal it throws an `Error` carrying the sentence, as the shell already expects. New exports for the screens to come: `prepareVideo(file, video, onProgress)` (returns what `prepareClip` returns), `confirmSubject(prepared, trackId)` (returns what `finishClip` returns), and `subjectGuides` re-exported.

- [ ] **Step 1: Rewire `clip.ts`** as above. `starterClip()` is unchanged apart from `guide: null`.
- [ ] **Step 2: Build the clip lab** (`/clip-lab.html` on the dev server): pick a file; a progress bar; one status line that shows refusals and warnings as they are; the frame at `confirmTMs` with each candidate's numbered box and one button per candidate, the top one selected, shown even with a single candidate; after choosing, the video plays the guide's range in a loop with that subject's skeleton and box drawn over it; a small table with the decoder used, frames analysed, people found, cuts, seconds taken, and whether the result was saved or fresh. Plain styling.
- [ ] **Step 3: Run `npm run build` in `app/`, and `npm run check` in `clip/` and `engine/`.** Expected: all pass.
- [ ] **Step 4: Manual checks in the lab** with the files in `../test-clips` (outside the repo, never committed), recorded in `app/README.md` under "Checked" and "Not checked" with what was actually seen: `one-person.mp4` shows one candidate and the skeleton sits on the person; `two-people.mp4` shows two candidates and each skeleton stays on its own person; `with-cut.mp4` reports one cut and plays only the chosen person's shot; `sideways-phone.mp4` comes out upright; `no-person.mp4` shows "No person found in this clip." and another file can be picked; `hevc.mp4` either works or shows the H.264 sentence; opening `one-person.mp4` twice reports "saved" the second time. Also confirm the main page still plays the starter clip with the simulated player (`/?nocam=1`).
- [ ] **Step 5: Commit** `app: clip side entry points and a clip lab page`.

### Task 7: An outline per frame for people

Blind mode shows a player only the outline of their subject, so each guide carries one.

**Files:**
- Modify: `clip/src/types.ts`, `clip/src/guide.ts`, `clip/test/guide.test.ts`, `app/src/clipside/detect.ts`, `app/src/clipside/analyze.ts`, `app/src/clip-lab.ts`.

**Interfaces:**
- `Detection` and `TrackPoint` gain `outline: [number, number][] | null` (a closed polygon in normalized image coordinates, at most 60 points). `Guide` gains `outlines: ([number, number][] | null)[]`, one entry per timeline frame. Saved records move to `schema: "prepared/2"`; older records are ignored and analysed again.

- [ ] **Step 1: Read the MediaPipe docs** on `outputSegmentationMasks` for the pose tracker: whether each detected person gets a mask, and how to read and close a mask.
- [ ] **Step 2: Write failing tests** in `guide.test.ts`: `outlines` has the timeline's length; a frame where the track has no point is null; the polygon of a point is carried through unchanged.
- [ ] **Step 3: Implement.** Turn each person's mask into a polygon with `binarizeMask` and `extractOutline` from `spikes/pose-match/webcam.mjs` (60 points). If the tracker returns one combined mask, keep only the part inside that person's box. The lab draws the outline over the video.
- [ ] **Step 4: Run all checks and the build;** in the lab, confirm on `two-people.mp4` that each outline wraps its own person. Record what was seen in `app/README.md`.
- [ ] **Step 5: Commit** `clip: an outline per frame for people`.

### Task 8: Things as subjects

Blind mode roles include things (a dog, a ball). The engine scores them from a box over time.

**Files:**
- Modify: `clip/src/types.ts`, `clip/src/tracks.ts`, `clip/src/rank.ts`, `clip/src/rules.ts`, `clip/src/guide.ts` and their tests; `app/src/clipside/detect.ts`, `app/src/clipside/analyze.ts`, `app/src/clip-lab.ts`.

**Interfaces:**
- `Detection` and `TrackPoint`: `landmarks` becomes `readonly Landmark[] | null`, and both gain `kind: "person" | "thing"` and `label: string` ("Person", or the detector's category such as "dog"). Tracks never mix kinds. `Candidate.label` is "Person 1" and so on for people, and the category with a number for things ("Dog 1"). For a thing, motion is the movement of the box centre in box heights; the guide has `timeline: null`, `channel: "trajectory"`, `subject.kind: "thing"`, and its outline is the mask polygon when one exists, else the box as a four point polygon. Saved records move to `schema: "prepared/3"`.

- [ ] **Step 1: Read the MediaPipe docs** for the object detector (categories, score threshold, running mode).
- [ ] **Step 2: Write failing tests:** a person and a thing that overlap stay two tracks; a thing's candidate ranks by size, place, box movement and time on screen; `buildGuide` for a thing gives a null timeline, the trajectory channel and a box track; a thing that never moves is refused with "This one does not move, so there is nothing to copy."
- [ ] **Step 3: Implement.** Run the object detector on every third analysed frame with a score threshold of 0.5, drop the "person" category (the pose tracker covers people) and any thing box that overlaps a person's box by more than 0.6, and link things with a `maxGap` of 15 frames.
- [ ] **Step 4: Run all checks and the build;** in the lab, try a clip with an animal or a ball if one is on hand and record what was seen, including a miss.
- [ ] **Step 5: Commit** `clip: things as subjects`.
