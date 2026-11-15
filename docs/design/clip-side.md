# Clip side design: the tracker measures, an AI model directs

Status: Aaron said to start the build of the extraction (stages 0 to 5 for people) on Saturday Nov 14 at 6:20 PM Eastern. The AI check and the path for non-people wait. Owner: Aaron.

## Why

"Any video is now a game." A player drops in a short clip and, seconds later, has a guide to copy and be scored against. Nobody makes levels by hand. This is the part no shipped webcam game has: upload, then imitate.

It has to cope with whatever people drop in: fast motion, slow motion, clips where nothing moves, and subjects that are not people (animals, cartoons, objects).

## What exists today

- `app/src/clip.ts` is a stand-in. It steps a hidden video element 15 times a second, tracks one person, and builds a `pose-timeline/1`. No choice of subject, no saved results, no refusals, and its tracker timing comes from the wall clock, so results do not repeat.
- The engine already takes two kinds of reference: a `pose-timeline/1` for a person, and a `box-track/1` (the subject's box over time) for anything without a usable skeleton. `skeletonGate` picks between them.

## Goals

1. A clip with people becomes an exact pose timeline for the one subject the player confirmed.
2. The player always confirms the subject, even when there is only one.
3. Same file in, same guide out.
4. A subject that is not a person becomes a box track, so the engine's trajectory channel can score it.
5. A clip that cannot be used is refused with a plain reason.
6. An AI model makes the judgment calls that rules are bad at: what is in the clip, which subject is the main one, and why a clip will not work.

## Not goals

- No 3D, no body outlines, no joining several shots into one guide.
- The video never leaves the device. The AI step sends about a dozen shrunken still frames, and the screen says so.
- No AI model running on the device, and no model training.
- Anti-goal: a guide that looks measured but is guessed. Anything the AI produced is labeled.

## Approaches considered

1. **Tracker only.** People only, rules refuse the rest. On device and simple, but fails goal 4 and gives poor reasons.
2. **AI only.** A model writes the whole guide from frames. Handles anything, but it guesses joints and timing, so scores would feel arbitrary.
3. **The tracker measures, the AI directs (chosen by Aaron).** Fixed code produces every number. One saved AI call per new clip labels the clip and steers which path runs.

## Targets and budget (my calls)

- Chrome or Edge on a laptop. Safari is best effort. Uploading a clip from a phone is not a target tonight.
- A 30 second clip is ready in under 60 seconds on the team's slowest laptop. If it is not, in this order: run the object detector on every fifth frame only, switch the pose tracker to the lite model, drop to 10 frames per second.

## Design

**Stage 0, open.** Fingerprint the file (SHA-256 of its bytes). If a guide is saved under that fingerprint, load it and stop. Clips over 30 seconds use the first 30 and say so (my call).

**Stage 1, frames.** Decode with WebCodecs through the Mediabunny library, at fixed times, 15 per second, in order, inside one worker. Check the codec first; if the browser cannot decode it, refuse with "save it as an H.264 MP4". If the subject turns out to move fast, run again at 30 per second (my call). Fallback if Mediabunny slips: keep today's video element stepping, with fixed tracker time stamps.

**Stage 2, find and follow.** Two detectors from the same MediaPipe package run on each frame: the pose tracker with up to 4 people, and the object detector (animals and common objects). Each gives boxes. Boxes are linked from frame to frame by overlap, with a short memory for misses, into tracks. A cut (a jump in colour between neighbouring frames) ends every track. If nothing is detected but something moves, the largest moving region becomes a track called "moving shape". The pose tracker uses the `full` model, as the stand-in does; the player side picks its own, and whether lite against full shifts a score is not tested.

**Stage 3, candidates and confirm.** Rank tracks by size, how central they are, how much they move, and time on screen. Drop tracks under 1 second. Show one still frame with numbered boxes; the player picks one, and that track's points are the ones the engine gets. The top-ranked candidate is preselected. After a cut, only the chosen subject's shot is used (my call).

**Stage 4, the guide.** For a person: the pose timeline, then the engine's `skeletonGate`. If the gate says the skeleton is not usable, fall back to the box track. For anything else: the box track. Also computed: key moments (poses that are held and differ from the last one, for the on-screen guide) and pace (slow, medium, fast) from how far the subject moves per second.

**Stage 5, refuse or warn.** Starting rules, to tune on about ten real clips: no subject in half the frames; subject under a quarter of the frame height; more than one cut every 2 seconds; under 3 seconds long; nothing moves. A still person is allowed as a "hold this pose" round, with a warning.

**Stage 6, the AI check.** Twelve evenly spaced frames, shrunk, with the candidate numbers drawn on, go to one server function. It asks a vision model to fill a fixed form: kind (person, animal, cartoon, object, nothing moving, unclear), which numbered candidate is the main subject, usable or not with a reason in plain words, pace, and a title of four words or fewer. The answer preselects the candidate, names the clip, words the refusal, and decides between the pose path and the box path when the tracker has drawn a skeleton on something that is not a person. The player can overrule it. The check is advisory and never blocks: the confirm screen appears as soon as tracking is done, an answer that arrives within 6 seconds changes the preselected candidate, and a late or failed answer is ignored. Without it, the title is the file name and refusals use fixed sentences.

**Saved results.** The guide and the AI answer are stored in the browser (IndexedDB) under the fingerprint. The model will not give the same answer twice, so saving is what makes goal 3 true. A guide is about 90 KB for 30 seconds, small enough to share without the video later; sharing and importing guides are not built in these versions.

## Output

```ts
interface Guide {
  schema: "guide/1";
  fingerprint: string;                       // SHA-256 of the file, hex
  source: { width: number; height: number; durationMs: number; sampleHz: number };
  subject: { kind: "person" | "thing"; label: string };
  channel: "pose" | "trajectory";
  timeline: PoseTimeline | null;             // engine type, people only
  boxTrack: BoxTrack;                        // engine type, always present
  keyMoments: { tMs: number }[];
  pace: "slow" | "medium" | "fast";
  warnings: string[];
  check: ClipCheck | null;                   // the AI form, when it ran
}

interface ClipCheck {
  kind: "person" | "animal" | "cartoon" | "object" | "nothing_moving" | "unclear";
  mainCandidate: number | null;              // the number drawn on the frames
  usable: boolean;
  reason: string;                            // one sentence, plain words
  pace: "slow" | "medium" | "fast";
  title: string;                             // four words or fewer
  model: string;                             // which model answered
}
```

`subject.label` is "Person 1" and so on, the object detector's category name ("cat"), or "moving shape". `warnings` are fixed sentences from the stage 5 rules.

## Where the code lives (my calls)

- `clip/` beside `engine/`, same habits: TypeScript, pure modules with tests run by Node (linking boxes into tracks, cut detection, ranking, refusal rules, key moments, pace). Browser work (hashing, saving, decoding, the detectors) lives in `app/src/clipside/`, where the app's packages resolve.
- Version 1 runs on the page and yields between frames. The worker and the 30 per second second pass come after it. The build plan is `docs/design/clip-side-plan.md`.
- `app/src/clip.ts` becomes a thin caller. `Clip` keeps `samples`, `videoUrl` and `timeline`, and gains `guide`, so Alex's shell keeps working. For a subject that is not a person, `timeline` is empty and the round picks the scorer from `guide.channel`; that is a small change in `app/src/round.ts` in version 2, pulsed to Alex first.
- `app/api/clip-check.ts`: the one server function, a Vercel function beside the static build (the app has no server today). It holds the API key, which Aaron sets in the host's settings with a spend limit and which never enters the repo. It accepts at most 16 images of 200 KB each, checks the page's origin, and limits calls per address and per day.
- AI provider: open, Aaron's call before version 2. Claude through the official SDK needs an API key with credits. Gemini has a free tier, takes the video itself, and counts for the MLH prize. Either way the answer is forced into the form's shape and the function hides the provider.

## What blind mode gets from the clip side

The team's blind mode (hub page `kb/game-modes`) gives each player one subject of the clip as a secret role, shows only its outline or stick figure, and then reveals everyone inside the original video. So the clip side hands over every subject, not one:

- `prepareVideo(file, video, onProgress)`: the analysis, with every candidate ranked and numbered.
- `subjectGuides(prepared)`: one guide per subject. For a person: the pose timeline, a box over time, and an outline per frame. For a thing: a box over time and an outline, scored by the engine's trajectory channel.
- `confirmSubject(prepared, trackId)`: one guide, for solo play.
- `analyzeVideo` keeps working for the first app shell.

Order of building: people, then outlines, then things.

## Versions

- **Version 1:** stages 0 to 5 for people. Several people, confirm, saved guide, refusals.
- **Version 2:** the object detector and box path for non-people, and the AI check.
- **Version 3, only if time:** the AI also suggests poses for a person imitating an animal, from a menu the team records.

## Left to the builder

Worker message shapes, file names, the confirm screen's look (waits on the look), and tuning the starting numbers.

## Not tested

- Tracker speed in a browser on our laptops and phones. Measure first.
- How often track identity swaps when people cross.
- Whether the object detector finds animals in real meme clips.
- How well the AI picks the main subject from numbered frames. Try five clips before building stage 6.
