# Accuracy engine: research and recommended design

Author: Alex (accuracy engine lane), with research agents. Saturday Nov 14, 2026. Hub item t-2gbq. Summary page in the hub: `kb/accuracy-engine.md`.

This answers three questions before any engine code is written:

1. What the engine takes in: the output expected from the clip CV stage (the chosen subject) and from the player CV stage (the live or recorded webcam).
2. How it grades: a clear, objective, explainable score that is identical when the same recorded player video is processed twice.
3. What is feasible by Sunday 8:30 AM.

## TL;DR

- **Both CV stages hand over the same thing: a pose timeline.** 33 MediaPipe landmarks per frame (x, y normalized, visibility), sampled on a fixed 30 Hz grid, quantized, with the source aspect ratio and a mirrored flag. Schema below.
- **The authoritative score is computed after the round from stored timelines, never from the live pass.** The webcam is recorded (MediaRecorder), then re-tracked frame by frame in MediaPipe **IMAGE mode** at fixed timestamps. VIDEO mode smooths and tracks across frames with timestamp-dependent filters, so it cannot give repeatable output (confirmed in MediaPipe source, see Determinism).
- **Grade limb directions, not positions.** 12 unit limb vectors per pose. Per limb: angle error with a dead zone (full credit up to 15 degrees) and a smooth falloff to zero at 60 degrees. Weighted by visibility on both sides; unseen limbs drop out, they are not scored as wrong.
- **Handle reaction delay with one global lag per round, not DTW.** Search lags from -200 to +800 ms, pick the best, allow +-100 ms local slack. Report the lag ("you were 320 ms behind") as a separate timing number. DTW warps around exactly the mistakes we want to score.
- **Score = round(100 x calibrated accuracy)**, plus tiers, per-limb breakdown, and the worst limb. Every constant is published in one file with a scorer version string.
- **Non-human references (cartoons, sprites, game characters, objects) get a second channel.** A per-clip gate decides whether the subject has a usable skeleton. If not, the clip stage tracks the subject's box (hosted SAM 3.1 from one click, cached; template matching as the offline fallback) and the engine scores the player's body motion against the box trajectory: velocity correlation at the same global lag, plus matched events (jump, crouch, move left or right). Section 6.
- **The scorer is a pure function**: same timelines in, bit-identical score out. Re-extraction from the same video is identical on the same browser and machine with IMAGE mode + CPU delegate + fixed grid; quantization and integer scores absorb residual float noise. First thing to verify when code exists: hash two extractions of one video.

## 1. What others do (short)

| Source | What it compares | Timing | Lesson |
|---|---|---|---|
| 67speedgames.com (clone of 67speed.com) | Wrist minus shoulder y, per frame delta > 0.04 | Wall clock, rAF loop | Not motion matching at all: a rep counter. Frame-rate dependent, so the same video can score differently. A list of mistakes to avoid. |
| Dance Central (Harmonix patent US8702485) | Body-relative unit limb vectors, depth down-weighted | Hand-placed keyframes; inner window full credit, falloff to outer window; best frame in window | Dead zone plus smooth falloff, position x timing, per-limb feedback (red outline on the wrong limb). Tiers at 80/60/40/20 percent. |
| Sony Move (US10086283B2) | Velocity traces | Key-points at velocity or acceleration sign changes; tolerance scaled by jerk | Idea for auto keyframes. Claim 1 covers event key-points plus jerk tolerance; avoid copying. |
| Just Dance | One-hand inertial; 2025 camera mode is an ML model | Not published | A study found the same dance repeated varies about 10 percent (ICC 0.735). Opaque scoring gets criticized. |
| Beat Saber | Swing angles and cut offset | Per note | A published geometric formula makes every point explainable. |
| Move Mirror (Google) | Normalized keypoints, confidence-weighted L1 distance | None | Confidence weighting beats plain cosine when joints are occluded. |
| Mimeflow (open source, closest stack) | 3D world-landmark bone vectors, one cosine over all bones | Max over a 20 x 20 frame window, both directions | Window max in both directions inflates scores; sigmoid caps at about 95 percent; wall-clock timestamps make it machine-dependent. |
| SyncUp (IMWUT 2021, arXiv 2107.13847) | 13 unit limb vectors, 2D | One lag per segment from cross-correlating motion energy | A plain sum of limb distances matched 161 human raters as well as a learned model (r = 0.73; 0.87 on solo videos). Raters valued "treating everyone equally". |

Patterns: limb directions or joint angles beat raw positions; visibility weighting is the standard answer to occlusion; commercial games use keyframes with time windows, not DTW; nobody publishes their 0-100 mapping and nobody tested reproducibility. Human raters agree with each other only around r = 0.7, so the goal is a score that is consistent and explainable, not "correct".

## 2. Input contract

### 2.1 Pose timeline (both CV stages produce this)

```json
{
  "schema": "pose-timeline/1",
  "source": {
    "kind": "clip | webcam",
    "width": 1280, "height": 720,
    "mirrored": false,
    "durationMs": 12000,
    "mediaSha256": "..."
  },
  "extractor": {
    "model": "pose_landmarker_full", "tasksVision": "0.10.x",
    "mode": "IMAGE", "delegate": "CPU"
  },
  "sampleRateHz": 30,
  "subjectId": 2,
  "frames": [
    { "i": 0, "detected": true,
      "bbox": [0.31, 0.12, 0.22, 0.80],
      "lm": [[0.5123, 0.2210, 0.98], "... 33 entries of [x, y, visibility]"] }
  ]
}
```

Rules:

- **Fixed grid.** Frame `i` is at `t = i * 1000 / sampleRateHz` ms of media time. No wall clock anywhere. Both timelines share the grid, so alignment is index arithmetic.
- **Coordinates** are MediaPipe normalized image coordinates, top-left origin. The engine multiplies x by `width / height` before computing directions (x and y are normalized by different lengths).
- **Quantized**: x, y to 4 decimals, visibility to 2.
- **Missing frames stay in the array** with `detected: false`. Never drop or interpolate them in the CV stage; the engine decides.
- **Unmirrored data.** Store what the camera saw plus `mirrored`. The engine applies the mirror rule once (flip x, swap left and right labels on the player).
- **One subject per file.** The clip stage filters to the chosen person before handoff.
- World landmarks (3D, meters) are optional and unused in v1. Their z is noisy and hip-centered, and 2D works fine for a frontal webcam.

### 2.2 Clip stage (subject extraction), owned by the CV teammate

- Run once per clip, cache the result. The clip is never re-tracked during play.
- Multi-person: MediaPipe `numPoses > 1` returns poses in **no stable order and with no ID**, and turns off its smoothing. The clip stage must keep identity itself: greedy IoU matching of bounding boxes frame to frame (Hungarian is overkill for under 6 people). MoveNet MultiPose has a built-in tracker with IDs (`enableTracking`) but only 17 keypoints and a different confidence scale; if used, convert to the same timeline format.
- The user picks a subject by ID; output the single-subject timeline above.

### 2.3 Player stage

Two outputs:

1. **Live stream (feel only).** VIDEO mode, GPU allowed. Each frame tagged with the clip's media time at that moment (from `requestVideoFrameCallback` `mediaTime`, not `video.currentTime`, which is coarser). Used for live limb colors and popups. Never stored as the score.
2. **Recorded timeline (the score).** MediaRecorder records the webcam during the round. After the round, decode the recording at the fixed 30 Hz grid (seek and wait for `seeked`, or WebCodecs), run IMAGE mode on CPU, and produce a `pose-timeline/1`. Also record `clipOffsetMs`: the clip media time when the recording's first frame was captured, so player frame `i` lines up with clip frame `i + clipOffsetMs / 33.33`.

The replay case ("I play my recording back a second time") then goes through the exact same path and gives the same timeline.

## 3. Grading

All constants live in one exported object with `SCORER_VERSION`. Starting values below; calibrate on about 5 test recordings before the demo.

### 3.1 Features

12 limbs, each a unit 2D vector after aspect correction (MediaPipe indices):

- Upper arms 11-13, 12-14 and forearms 13-15, 14-16: weight 1.5 (arms drive perceived similarity, SyncUp section 2.3)
- Thighs 23-25, 24-26 and shins 25-27, 26-28: weight 1.0
- Shoulder line 11-12, hip line 23-24, torso mid-hip to mid-shoulder: weight 0.75
- Neck, mid-shoulder to nose: weight 0.5

Direction only, so body size, camera distance and framing do not matter.

Optional smoothing: a One Euro filter (mincutoff 1.0 Hz, beta 0.5, dcutoff 1.0) applied identically to both timelines using grid timestamps. It is deterministic (no clocks, no randomness). Skip it in v1 unless jitter shows up in testing; IMAGE mode output is unsmoothed.

### 3.2 Per-limb score

- Angle error `theta = acos(clamp(u . v, -1, 1))` in degrees.
- `s = 1` if theta <= 15; `s = 0` if theta >= 60; else `1 - x^2` with `x = (theta - 15) / 45`.
- Limb weight `w = W_limb * min(visibility of its 4 endpoints, both poses)`; `w = 0` if that minimum is under 0.5.

This is the one formula we show a judge: "within 15 degrees is perfect, past 60 degrees is zero, smooth in between."

### 3.3 Frame score

- `P(i, lag) = sum(w * s) / sum(w)` comparing player frame `i` to clip frame `i + lag`.
- A frame is **invalid** (excluded, not zero) if `sum(w) < 0.4 * sum(W_limb)`. The live UI shows "step into frame".
- No person detected is never a score. It is invalid.

### 3.4 Timing: one global lag

- For each lag from -200 to +800 ms in 1-frame steps, compute the mean `P` over valid frames. `L*` is the best lag; ties go to the smallest absolute lag.
- Per-frame score: `Pf(i) = max P(i, lag)` over `L* +- 3 frames` (+-100 ms slack). One direction only (player frame against a clip neighborhood).
- Timing score: `T = 1` if `L* <= 300 ms` (normal reaction time), falling as `1 - x^2` to 0 at 800 ms. Shown as "you were 320 ms behind".

Why not DTW: it lets a player hold one pose and match many reference frames, hides skipped moves (SyncUp's outlier case 1), and is harder to explain. A constant reaction delay is what a mimic actually has.

### 3.5 Round score

- `Accuracy = mean Pf over valid frames` (every frame counts, so standing still cannot farm a few lucky matches).
- `Raw = 0.85 * Accuracy + 0.15 * T`.
- `Score = round(100 * clamp((Raw - floor) / (ceiling - floor), 0, 1))`, starting `floor = 0.30` (standing still), `ceiling = 0.92` (the clip's own performer re-filmed). Calibrate both.
- Tiers: Perfect >= 90, Great >= 75, Good >= 55, OK >= 35, else Miss.
- Round fails as "low tracking" if more than 30 percent of frames are invalid.
- Output also: per-limb mean `s`, the worst limb named from the player's own side ("your left forearm was low"), `L*`, valid-frame share, `SCORER_VERSION`, and input hashes.

### 3.6 Live feedback (not authoritative)

- Assume lag 300 ms at start; after 3 s re-estimate every second over the last 8 s.
- Show an EMA of `Pf` (about 0.5 s) and color each limb by `s`.
- Keyframe popups (Perfect/Great/OK/Miss) at auto-picked moments: local minima of the clip's total joint speed (held poses), at least 0.5 s apart. This is a display feature; the final score uses every frame.
- The live number may differ a little from the final score. Say so on the results screen.

## 4. Determinism

What breaks it, from the sources:

- **MediaPipe VIDEO mode.** In `pose_landmarker_graph.cc` smoothing is switched on automatically in stream mode when `numPoses == 1`, with no public option to turn it off; it is a One Euro filter that depends on timestamp spacing, and the detector is skipped while the previous frame's box still tracks. Output depends on earlier frames and frame timing. IMAGE mode always runs the detector, no tracking, no smoothing. A MediaPipe issue (#5253) shows VIDEO-mode outputs differing on the same image and IMAGE mode returning identical values.
- **Video playback.** `video.currentTime` is not frame-accurate, rAF loops skip or repeat frames, variable-frame-rate files break `time * fps`, and WebKit has a bug returning the wrong frame after a seek. Never sample by playing the video; sample by seeking to grid times.
- **GPU delegate.** Float results may differ across GPUs and drivers (unverified). Use CPU for the scoring pass.
- **Wall clock.** Any `performance.now()` in the scoring path breaks replay.

What we do:

1. Scorer: pure function, single-threaded, fixed iteration order, no clocks, no randomness. Same timelines give a bit-identical result. Unit test: score twice, compare.
2. Extraction: IMAGE mode, CPU delegate, fixed 30 Hz grid, pinned model and tasks-vision versions, quantized output, run in the same browser. Test: extract one recording twice, hash both timelines.
3. Integer final score absorbs any remaining tiny float differences. Honest caveat: a value sitting exactly on a rounding boundary could still flip by 1 if extraction is not bit-identical; the hash test tells us whether that can happen.
4. Store the timelines and the score record with hashes, so any score can be re-derived and checked.

## 5. Feasibility and scope

Must have (about 4 hours, the engine is plain modules with tests):

- Timeline schema and a validator; shared type agreed with the CV and game lanes first.
- Per-limb score, frame score, global lag, accuracy, round score, worst limb.
- Unit tests: identical poses score 100, mirrored player, scale and position invariance, occlusion drops limbs, standing still scores low, two runs are bit-identical.
- Post-round extraction path (record, decode on grid, IMAGE mode, CPU). This touches the CV lane; agree who builds it.

Should have (2 to 3 hours): live limb colors and lag estimate, keyframe popups, calibration of floor and ceiling on 5 recordings, per-limb breakdown on the results screen.

Nice to have: One Euro smoothing, difficulty (multiply 15/60 degrees by 1.3 for Easy, 0.75 for Hard), two-player scoring (same engine, two timelines).

Cut: DTW, 3D world landmarks, jerk-scaled tolerance (Sony's claim), hip velocity, learned scoring models.

Risks:

- IMAGE mode on CPU over a 30 s recording at 30 Hz is 900 detections. At roughly 20 to 50 ms each that is 20 to 45 s of processing after the round. Mitigation: 15 Hz grid (halves it), lite model, show a "judging" animation (the Jester host can fill it). Measure early.
- Side-on clips: 2D limb directions foreshorten. Pick starter clips filmed facing the camera.
- Patents: the Harmonix (to 2030) and Sony (to 2034) patents are active. We take ideas only; limb-angle scoring is standard in the literature. Fine for a hackathon prototype.

## 6. Non-human references

The reference may be a 3D game character (Subway Surfers runner), a 2D cartoon, a pixel sprite (NES Mario), or an object. Sections 2 to 5 assume a human skeleton; this section covers the rest.

### 6.1 Will pose tracking work on them?

From the Human-Art benchmark (CVPR 2023, arXiv 2303.02760), pose AP (out of 100):

- Real people with COCO-trained models: about 75.
- 2D cartoons, COCO-trained, end to end: 9.7. With a correct person box: 37.6. With models also trained on Human-Art: 64.7.
- 3D figurines ("garage kits", closest to a 3D game character): 45.2 COCO end to end, 86.7 Human-Art trained.
- The main failure is detection, not joints: COCO person detection on cartoons is 8.8 AP. MediaPipe's person detector leans on faces, so on cartoons expect "no pose" rather than a bad pose.
- Pixel sprites and objects: no evidence found. A 16 x 32 pixel sprite has no readable joints; treat as no skeleton.

Option to widen pose coverage (optional, about 3 to 4 hours): on the clip side only, run YOLOX-tiny and RTMPose-s trained on Human-Art (official ONNX files from OpenMMLab, 256 x 192 input, 17 COCO keypoints) in onnxruntime-web, offline, cached. All 12 limbs map from COCO-17. COCO hips sit lower and narrower than MediaPipe hips, so down-weight the hip line, torso and thighs by half when mixing models. Without this, MediaPipe on both sides still works for real people and most cartoons fall to the trajectory channel.

### 6.2 Skeleton gate (picks the channel per clip)

Sample 48 evenly spaced frames of the chosen subject. Use the pose channel only if all pass:

- Pose found on at least 70 percent of frames (on the tracked subject, by box overlap, not any character).
- Confidence at least 0.5 (MediaPipe) or 0.3 (RTMPose) on at least 8 of the 12 limb joints, and on all 4 torso corners.
- Median frame-to-frame joint jump under 0.25 torso lengths per 1/15 s; 95th percentile under 0.6.
- Left and right limb length ratios between 0.7 and 1.4 (raw bone-length variation fails on turning, so do not use it).

Otherwise use the trajectory channel. Show the user which mode was chosen and let them override.

### 6.3 Box track (new clip-stage output)

```json
{
  "schema": "box-track/1",
  "source": { "width": 1280, "height": 720, "nativeFps": 29.97, "mediaSha256": "..." },
  "tracker": { "kind": "fal-ai/sam-3-1/video-rle", "version": "2026-11-14", "click": { "frame": 42, "x": 610, "y": 388 } },
  "sampleRateHz": 30,
  "scrollX": [0, 0, 1.5, "... per-frame background shift in px, optional"],
  "frames": [ { "i": 0, "visible": true, "cx": 0.48, "cy": 0.62, "w": 0.06, "h": 0.11 } ]
}
```

- Same 30 Hz grid as the pose timeline. Normalized center x, y, width, height.
- Gaps of 5 frames or fewer are linearly bridged; longer gaps stay `visible: false`.
- Cached by video hash, click and tracker version, so a replay reads the same file.

How to get it:

- **Primary: fal `fal-ai/sam-3-1/video-rle`** with one click (`point_prompts`, integer pixels) and `return_object_rles: true`. Output is, per frame, a list of `{object_id, rle, box}` with a normalized center-format box and a stable id, so no mask decoding is needed. About $0.01 per 16 frames (about $0.56 for 30 s). Also accepts a text prompt ("character"). Key stays in a Next.js API route; submit, then poll the queue so Vercel does not time out. About 4 to 5 hours. Unverified: real latency, length limits, and how it does on tiny sprites (upscale small clips, add a second click).
- **Fallback: template matching in OpenCV.js** (`matchTemplate` with normalized correlation in a local window, 2 to 4 templates including a mirrored one, 3 scales, initial box from `grabCut` or a flood fill around the click). No network, deterministic, arguably better than SAM on NES sprites. Fails on big scale or shape changes.
- Not worth it in a day: in-browser SAM 2 (190 MB, hand-written memory loop, WebGPU only), custom OpenCV builds for KCF or CSRT (not in the default build).
- **Camera scroll** (side-scrollers like Mario): estimate a per-frame horizontal background shift offline (median Lucas-Kanade flow on a downscaled background strip with the subject masked out, or a 1-D shift search on column sums for pixel art) and add it to the screen x. Without it, high-pass x (subtract a 2 s running median) so only direction changes are scored. Subway Surfers needs no correction: screen x is the lane.

### 6.4 Scoring the trajectory channel

Player signals (MediaPipe, 30 Hz grid):

- Torso length `L` from a 1 s still calibration. Position from the hip midpoint (shoulder midpoint if hips are hidden).
- `px = -(x - x0) / L` (minus sign is the mirror), `py = -(y - y0) / L` (up is positive), crouch ratio `ph` = current nose-to-ankle height over standing height.

Reference signals: with `H` the median box height, `rx = (cx - cx0) / H` (world x if scroll is known), `ry = -(cy - cy0) / H`, `rh = h / H`.

Two parts, both at the same single global lag as the pose channel (-200 to +800 ms):

1. **Continuous: velocity correlation.** Smooth (7-frame centered average), take velocity, robust z-score with a noise floor (0.3 L/s or 0.3 H/s, so a still body is not stretched into noise). Per axis, Pearson r in 4 s windows stepped by 1 s, averaged via Fisher z. Only axes where the reference actually moves count (range at least 0.25 H on x, 0.15 H on y), weighted by their share of reference motion. Pick the lag with the best weighted mean. Subtract a chance baseline `r0` computed the same way on 16 fixed circular shifts of the player signal (deterministic, and it absorbs the bias of picking the best lag). `C = clamp((r - r0) / (0.65 - r0), 0, 1)`, multiplied by an activity factor so standing still cannot score.
2. **Events.** Detect on both sides with hysteresis, then match:
   - Jump: start when upward speed > 1.5 L/s and height > 0.15 L above a running baseline; event time is the apex; valid if apex at least 0.25 L (reference: 0.3 H). 
   - Crouch: enter at `ph < 0.85`, exit at `ph > 0.92`, at least 200 ms (reference: box height under 0.75, exit over 0.85).
   - Move left or right: a velocity segment covering at least 0.35 L (reference: 0.5 H), at least 150 ms.
   - Match same-type pairs within +-250 ms after the lag, closest pairs first (ties by index, so deterministic). Each hit earns `1 - 0.5 (dt / 250)^2`. `F1 = 2 x (sum of hit credits) / (reference events + player events)`, so extra flailing costs points.
   - Feedback per event: "Jump at 4.2 s: hit, 120 ms late", "Move right at 7.0 s: missed", "Extra crouch at 9.1 s".

`Score = round(100 x (0.6 x C + 0.4 x F1))`; use 0.4 / 0.6 for clips under about 17 s (too short for stable correlation); if the reference has no events, C only; if it neither moves nor has events, say "nothing to mimic". Same tiers as the pose channel. Expected anchors to confirm on recordings: standing still 0 to 5, random flailing 5 to 20, a good copy 80 to 95. Calibrate `0.65` to the median r of good copies.

Existing webcam Subway Surfers clones use fixed pixel thresholds on the shoulder midpoint against a one-time baseline (for example jump if it rises 15 px, crouch if it drops 100 px) and fire only on state changes. We keep the edge-triggered idea but normalize by torso length so camera distance does not matter. All event thresholds above are estimates to tune on recordings.

### 6.5 Determinism and scope for this channel

- Determinism is the same story as section 4: the box track is computed once and cached; the scorer is pure; surrogate shifts are fixed, not random; ties are broken by index.
- Must have (about 3 hours on the engine side): signals, events, matching, correlation, score, tests (still player scores near 0, a perfect copy scores near 100, same input gives same output).
- The clip-stage pieces (box tracking 4 to 5 hours, scroll estimate 1 to 2 hours, RTMPose 3 to 4 hours) belong to the CV lane; agree who owns them.
- Demo safety: precompute and cache 2 to 3 non-human demo clips (for example our own filmed toy, a public domain cartoon) so the table demo never waits on the API. Copyright rules still apply: no Mario or Subway Surfers footage in the demo video, Devpost page or repo.

## Sources

- Human-Art benchmark: https://arxiv.org/html/2303.02760v2
- RTMPose (Human-Art models): https://github.com/open-mmlab/mmpose/tree/main/projects/rtmpose
- fal SAM 3.1 video: https://fal.ai/models/fal-ai/sam-3-1/video-rle and https://fal.ai/models/fal-ai/sam-3/video-rle/llms.txt
- Replicate SAM 2 video: https://replicate.com/meta/sam-2-video
- OpenCV.js default build whitelist: https://raw.githubusercontent.com/opencv/opencv/4.x/platforms/js/opencv_js.config.py
- Webcam Subway Surfers clones: https://github.com/iesaTX/OpenCV-Subway-Surfers and https://github.com/pengzhangzhi/AI-assisted-subway-surfers/blob/main/run.py
- Windowed cross-lagged correlation and surrogates (Moulder et al. 2018): https://pmc.ncbi.nlm.nih.gov/articles/PMC6163103/
- 67speedgames: https://67speedgames.com/game/app.js?v=gs2
- Harmonix US8702485: https://patents.google.com/patent/US8702485
- Sony US10086283B2: https://patents.google.com/patent/US10086283B2/en
- Just Dance camera controller: https://www.ubisoft.com/en-gb/game/just-dance/2026/news-updates/2UBGhF4xWMLAVVFMmTCWwn/revolutionising-motion-gaming-the-camera-controller-feature
- Just Dance repeatability study: https://arxiv.org/html/2511.17925v2
- Beat Saber scoring: https://bsmg.wiki/ranking-guide
- Move Mirror: https://blog.tensorflow.org/2018/07/move-mirror-ai-experiment-with-pose-estimation-tensorflow-js.html and https://gist.github.com/irealva/735b2fb2810140e9fd4e645912262815
- Mimeflow (commit a88a22d): https://github.com/lguibr/Mimeflow
- SyncUp: https://arxiv.org/abs/2107.13847
- One Euro filter: https://gery.casiez.net/1euro/
- MediaPipe pose landmarker graph: https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/tasks/cc/vision/pose_landmarker/pose_landmarker_graph.cc
- MediaPipe issue #5253: https://github.com/google-ai-edge/mediapipe/issues/5253
- MediaPipe web docs: https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js
- MoveNet tracker: https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/movenet/README.md
- requestVideoFrameCallback: https://web.dev/articles/requestvideoframecallback-rvfc
