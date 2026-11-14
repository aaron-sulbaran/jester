# Jester app shell (Version 1)

One clip, one player, one score. Joins the three parts:

- Clip: `src/clip.ts`. The starter clip (synthetic stick figure from `spikes/pose-match/synthetic.mjs`) or a video file run through the clip side: `src/clipside/` reads frames (Mediabunny, or the `<video>` element when Mediabunny cannot decode), finds up to 4 people per frame with MediaPipe, and hands them to `../clip` to follow, rank and turn into a guide. `analyzeVideo` follows the top ranked person; `prepareVideo`, `confirmSubject` and `subjectGuides` are there for the screens to come.
- Player: Lisa's tracker, `createWebcamTracker` from `spikes/pose-match/webcam.mjs`, in `src/round.ts`.
- Score: `engine/` (`fromWebcamFrames`, `scorePoseRound`, `comparePoses` for the live meter).
- Look: `src/draw.ts` and `src/style.css`, plain on purpose so the real look can replace them.

## Run

```
cd app
npm install
npm run dev      # http://localhost:5173
npm run build    # typecheck + static build in dist/
```

The clip lab, http://localhost:5173/clip-lab.html (dev server only, not in the build), runs the clip side on one video so the result can be checked by eye. `?clip=<name>` runs `public/_clips/<name>` (git ignored, put test clips there), `?pick=<number>` chooses that person, `?fresh=1` ignores the saved analysis. After each run `window.__clipLab` holds a summary.

`?nocam=1` ticks "Simulated player": a stand-in copies the clip with 150 ms lag and an adjustable wobble, no camera needed.

## How the engine is wired

Each player frame is tagged with `clipTimeMs`, the clip's playback time when the frame arrived (video `currentTime`, or wall time since start for the starter clip). The engine's adapter uses that in place of `trackerTimeAtClipStartMs`, and it stays right if the video stalls. Frames before the clip starts are tagged -1 and dropped.

## Checked

- Typecheck and build pass.
- Starter clip with the simulated player: wobble 0 scores 100 (Perfect), lag found 133 ms against 150 simulated; wobble 35 scores 76 (Great), names the weakest limb.

- Clip side: `npm run build` passes; `clip` check 47 of 47, `engine` check 44 of 44.
- Clip lab, in Chrome (the desktop app's browser pane), clips in `public/_clips/`. Every run used the WebCodecs decoder (Mediabunny); the `<video>` fallback never ran. Seconds are for a fresh analysis.
  - The test clips do not all hold what their names say. In `one-person.mp4`, `one-person.webm` and `hevc.mp4`, every frame we looked at (Mediabunny, the `<video>` element and ffmpeg agree) is a concrete floor with nobody in it, not a jumping jack. So `two-people.mp4` has one person (the squat on the right half) and `with-cut.mp4` has nobody before its cut.
  - `one-person.mp4`: "No person found in this clip.", 174 frames, 3.7 s. Right for what the file holds. The tracker returned 0 people on every frame, on GPU and CPU, from a canvas and from an ImageBitmap.
  - `squat.webm` (in place of a one-person clip): 1 candidate (score 0.782), 107 frames, 0 cuts, 4.3 s; guide 0 to 7067 ms, pose channel, medium pace, 5 key moments, 107 timeline frames. Screenshot mid-playback: skeleton and box sit on the lifter.
  - `two-people.mp4`: 1 candidate (score 0.749), 174 frames, 0 cuts, 6.6 s; guide 0 to 11533 ms, slow pace, 5 key moments. Skeleton sits on the squatter on the right; nothing on the empty floor half. A two-person check still needs a clip with two people.
  - `with-cut.mp4`: 1 cut at frame 60 (4.0 s), 120 frames, 3.9 s; 1 candidate (score 0.693); guide 4000 to 7933 ms, 60 timeline frames, 8 key moments. Playback looped 4.5 s to 8.0 s and back to 4.5 s, only the squat shot; skeleton sits on the person.
  - `sideways-phone.mp4`: 1 candidate (score 0.655), 210 frames, 7.4 s, shown 720 x 1280 but upside down. The file is wrong, not the reading: ffmpeg and Chrome's `<video>` also show it upside down (stored pixels turned the opposite way to its 90 degree flag). A correctly made one (`vertical.webm` turned clockwise, flagged `-display_rotation 90`, saved as `_clips/sideways-phone-upright-check.mp4`) comes out upright with the skeleton on the person: 1 candidate (score 0.655), 210 frames, 6.6 s.
  - `no-person.mp4`: "No person found in this clip.", 75 frames, decoder webcodecs, 2.2 s; the file picker stayed usable and picking `squat.webm` next ran normally.
  - `hevc.mp4`: decoded with WebCodecs (174 frames, 4.0 s), then "No person found in this clip." because it is the floor footage.
  - Saved analysis: `squat.webm` and `with-cut.mp4` opened again without `fresh=1` report "saved" in 0 s. `one-person.mp4` opened again reports the same refusal, because refusals are not saved.
- Main page `/?nocam=1`: the starter clip with the simulated player (wobble 10) scored 100 (Perfect), 133 ms behind. Picking `squat.webm` there gave "squat.webm: 7.1 s, person found in 107 of 107 samples."; picking `no-person.mp4` gave "Could not read the clip: No person found in this clip."

## Not checked

A real camera. First person at a laptop: run a round and post the score and how it felt.

- A clip with two people and a real one-person jumping jack clip: the files with those names do not contain them.
- The `<video>` element fallback decoder: every test clip decoded with WebCodecs in this Chrome.
- A tracker failure partway through ("The pose tracker stopped working. Reload the page and try again."): only shown to pass through `readFrames`, not triggered in the lab.
- Clips over 30 seconds: none in the set.
