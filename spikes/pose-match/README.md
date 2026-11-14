# pose-match spike

Proves Jester's core loop in one static page: reference clip, pose timeline, level of key moments, a scored round against the player, results.

## Run it

The camera needs a secure context, so serve the folder from localhost instead of opening the file:

```
cd spikes/pose-match
python3 -m http.server 4323
```

Then open one of:

- `http://localhost:4323/` : pick a video file, play against your webcam.
- `http://localhost:4323/?demo=1&nocam=1` : no video, no camera, no network. A synthetic stick figure is the clip and a simulated performer is the player. The slider sets the performer's angle noise (0 is perfect).
- `?demo=1` alone uses the synthetic clip with your real camera; `?nocam=1` alone uses your video with the simulated performer.

MediaPipe is only imported when a real video or the real camera is used, so demo mode works offline.

Tests (Node built-in runner, no install):

```
node --test spikes/pose-match/
```

Node 24 does not scan a folder passed to `--test`; it resolves it like a module instead, so `package.json` points `main` at `run-tests.mjs`, which imports both test files. `node --test 'spikes/pose-match/*.test.mjs'` works too.

## Files

- `score.mjs` : pose comparison, mirroring, ratings, feedback. Pure functions.
- `level.mjs` : picks key moments from a timeline. Pure functions.
- `synthetic.mjs` : stick figure poses, demo timeline, simulated performer. Shared by tests and demo mode.
- `index.html` : the page. Loads `@mediapipe/tasks-vision@1.2.3` from jsDelivr, Pose Landmarker lite, VIDEO mode, GPU delegate with CPU fallback, `NUM_POSES = 1`.

## How the scoring works (the judge version)

1. **Bodies become arrows.** For each of 11 body parts (both upper arms, forearms, thighs, shins, the shoulder line, the hip line, and the torso from hip middle to shoulder middle) we draw an arrow from one joint to the next and shrink it to length 1. Only the direction is left. A tall person far from the camera and a short person close to it make the same arrows, so size and position do not matter.
2. **Fix the stretch first.** MediaPipe gives x as a fraction of the image width and y as a fraction of the height. On a 16:9 video those are different rulers, so we multiply x by width / height before drawing arrows. Each source (clip, webcam) passes its own aspect ratio.
3. **Compare arrows.** For each part, the cosine of the angle between the clip's arrow and the player's arrow is 1 when they point the same way, 0 at a right angle, -1 when opposite. We map that to 0..1 with (cos + 1) / 2. So 15 degrees off is about 0.98, 40 degrees is about 0.88, 90 degrees is 0.5.
4. **Trust what the camera can see.** Each part is weighted by its least visible joint (MediaPipe's visibility, in both poses). Parts under 0.5 visibility are skipped. If fewer than 4 parts remain, the score is null ("no body seen"), never a made up number.
5. **Mirror.** The player watches a mirrored self view, so to copy the dancer's left arm they raise their right one. Before comparing we flip the player horizontally (x becomes 1 - x) and swap left and right joints. The "Mirror player" checkbox turns this off.
6. **Grade a moment.** Around each key moment we watch a window of 400 ms before and after and keep the player's best score. Ratings: Perfect at 0.98 or above, Great at 0.95, OK at 0.88, else Miss (constants at the top of `score.mjs`). Points: 100, 80, 50, 0. The total out of 100 is the average.
7. **Feedback.** Across all moments we find the part with the lowest average similarity. If the player's arrow pointed more downward than the clip's we say it was low, more upward it was high, otherwise at the wrong angle. Limb names are the clip performer's left and right.

## How a level is built

A good key moment is a pose the performer briefly holds and that differs from the previous one.

1. Motion energy per sample: 1 minus the similarity between consecutive frames (same arrows as above, no mirroring), smoothed over a few samples.
2. Candidates are local minima below a "held" threshold.
3. Stillest first, keep candidates at least 1.2 s apart.
4. In time order, drop a candidate that looks like the last kept pose.
5. Keep the 8 stillest. If fewer than 4 survive (for example a clip with no pauses), fall back to 8 evenly spaced samples.

All thresholds are named constants at the top of `level.mjs`.

## What was verified

- All 12 unit tests pass (identical, mirrored, rotated arm, scale and translation, aspect ratio, low visibility, null score, 4 held poses, static fallback, spacing).
- `?demo=1&nocam=1` was run in a Chromium browser pane: level of 8 moments, countdown, ghost and shrinking ring, ratings, results. Noise 0 gave 100 / 100 (8 Perfect); noise 75 gave 38 / 100. Network log showed only the four local files, so demo mode makes no CDN or model requests.
- In the same browser, `vision_bundle.mjs` 1.2.3 imported, `PoseLandmarker.createFromOptions` built the lite model with the GPU delegate, and `detectForVideo` ran on a canvas.

## What was not verified

- A real webcam. Not tested at all.
- Analysis of a real video file (seek, detect, timeline). The code path exists; no clip was run through it.
- Whether the thresholds feel fair for real humans. They were tuned only against the simulated performer.
- Performance on a laptop: analysis cost per frame, and live detection frame rate with GPU delegate.

## Docs check

Context7 (Google AI Edge MediaPipe docs) was queried before writing the MediaPipe code. It matches what is used here: `FilesetResolver.forVisionTasks`, `PoseLandmarker.createFromOptions`, `detectForVideo(frame, timestampMs)`, web running modes `IMAGE` and `VIDEO` only (no `LIVE_STREAM` on web; the live camera loop is VIDEO mode plus requestAnimationFrame), `numPoses` any integer above 0, `outputSegmentationMasks` available on web (default false), 33 landmarks with `visibility` and `presence`, model files `pose_landmarker_lite.task`, `_full`, `_heavy`. The docs show `@latest` and a `/latest/` model path; this spike pins `1.2.3` and the `/float16/1/` model path instead, matching the earlier firefly-hands rig.

## Known design choices worth knowing

- One landmarker serves both clip analysis and the camera. VIDEO mode needs strictly increasing timestamps across all calls, so `detectPose` uses `max(last + 1, performance.now())`.
- The ghost (next key pose) is moved and scaled onto the player's own torso, so it overlays their body rather than the clip's framing.
