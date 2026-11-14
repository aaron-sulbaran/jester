# Jester app shell (Version 1)

One clip, one player, one score. Joins the three parts:

- Clip: `src/clip.ts`. The starter clip (synthetic stick figure from `spikes/pose-match/synthetic.mjs`) or a video file tracked with MediaPipe. A stand-in until the clip side lands.
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

`?nocam=1` ticks "Simulated player": a stand-in copies the clip with 150 ms lag and an adjustable wobble, no camera needed.

## How the engine is wired

Each player frame is tagged with `clipTimeMs`, the clip's playback time when the frame arrived (video `currentTime`, or wall time since start for the starter clip). The engine's adapter uses that in place of `trackerTimeAtClipStartMs`, and it stays right if the video stalls. Frames before the clip starts are tagged -1 and dropped.

## Checked

- Typecheck and build pass.
- Starter clip with the simulated player: wobble 0 scores 100 (Perfect), lag found 133 ms against 150 simulated; wobble 35 scores 76 (Great), names the weakest limb.

## Not checked

A real camera and a real video file (both need MediaPipe from the CDN and a camera). First person at a laptop: run a round and post the score and how it felt.
