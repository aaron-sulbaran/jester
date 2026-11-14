# Jester

Act out any clip. Get judged.

Pick a short video of a person moving (a dance, a meme, a movie scene), act it out in front of your camera, and Jester grades how well your body matched. Everything runs in the browser.

Built at HackPrinceton Fall 2026 (November 13 to 15, 2026). Main track: Entertainment.

## Status

Early. The first thing in this repo is a test build of the core loop, in `spikes/pose-match/`: a clip becomes a level of key moments, the player is scored against each one, and a results screen names the weakest limb.

## Try the test build

```bash
cd spikes/pose-match && python3 -m http.server 4323
```

Then open one of:

- `http://localhost:4323/` to load your own video file and play with your camera.
- `http://localhost:4323/?demo=1&nocam=1` to watch the whole loop run with a stick figure and a simulated player, no camera or video needed.

The camera only works when the page is served from localhost or https, not opened as a file.

## Tests

```bash
node --test spikes/pose-match/
```

## How the scoring works, in one paragraph

A pose tracker gives 33 body points per frame for the clip and for the player. Jester compares the direction each limb points, not where it sits on screen, so height, body size, and distance from the camera do not matter. The player is compared as a mirror image. Each key moment takes the player's best match within a short window around it, which forgives camera lag and human reaction time. The longer explanation is in `spikes/pose-match/README.md`.

## Credits

- Pose tracking: [MediaPipe Pose Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker) from Google, loaded in the browser.
- Built with AI coding assistants; every commit is reviewed and explained by the team.

## Clips

No video files live in this repo. Demo clips are filmed by the team or come from public domain film.
