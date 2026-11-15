# @jester/clip

The clip side of Jester. It takes detections from a video clip (people with 33 pose landmarks per sampled frame) and turns them into a guide the engine can score against: cut detection, tracks per person, ranked candidates, refusal rules, key moments, pace, and the guide itself.

Pure TypeScript with no runtime dependencies and no DOM. Coordinates are MediaPipe normalized image coordinates, unmirrored. Everything is deterministic: the same input gives the same guide.

Import from `src/index.ts`. Run the checks (typecheck, then tests) from this folder:

```
npm install
npm run check
```
