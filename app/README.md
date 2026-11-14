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

- Clip side (Task 5 and 6): `npm run build` passes; `clip` check 47 of 47, `engine` check 44 of 44.
- Test clip metadata read with Mediabunny in Node: `sideways-phone.mp4` has rotation 270 and display size 720 x 1280, so the frames come out at 405 x 720 (upright, long side 720). `hevc.mp4` is `hvc1`. Every clip starts at time 0.

## Not checked

A real camera. First person at a laptop: run a round and post the score and how it felt.

None of the clip lab checks were run: the dev server at localhost:5173 was not running during the build session, and starting one was not allowed there. Still to run, each in the lab:
- `one-person.mp4`: one candidate, skeleton sits on the person.
- `two-people.mp4`: two candidates, each skeleton stays on its own person.
- `with-cut.mp4`: one cut, plays only the chosen person's shot.
- `sideways-phone.mp4`: comes out upright.
- `no-person.mp4`: shows "No person found in this clip." and another file can be picked.
- `hevc.mp4`: works, or shows the H.264 sentence.
- `one-person.mp4` twice: the second run reports "saved".
- Main page `/?nocam=1`: the starter clip still plays with the simulated player, and a picked video still analyses.
