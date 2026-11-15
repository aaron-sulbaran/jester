# Jester

**Any video is now a game.** Everyone gets a secret part from a clip, copies it on their webcam without seeing the video, and then the real clip plays with all of you on top of it.

Built at HackPrinceton Fall 2026 (November 13 to 15). Main track: **Entertainment**. Special track: **LangChain, Best use of deepagents**, with [the Chamberlain](#the-chamberlain-our-clip-reviewer), the deep agent that reviews the clips players submit.

**Play it:** https://jester-pi.vercel.app (a laptop with a webcam, in desktop Chrome or Edge)

![Jester: act out any clip, get judged. 2 to 4 players and a laptop with a webcam.](https://aaronsulbaran.com/hack-princeton/brand/devpost/hero.png)

## Any video is now a game

- **Any clip becomes a level.** Jester finds the people (up to 4) and the things that move in a short video (a dancer, a dog, a ball) and turns each one into a part someone can play. No level design, no markers, no training.
- **Play it blind, or dance along.** In Blind, each player sees only their own part's outline or stick figure, never the clip and never who they are, and finds out what they actually did at the reveal. In Normal, the clip plays during your turn and your part is marked on it with a thin outline in your colour and your name above.
- **The reveal is the payoff.** The real video plays with every player's cutout on their part, the jester crowns the winner, and the reveal saves as a video you can keep.

**A fairer judge without retraining a model.** The scorer is computer vision and fixed code: MediaPipe's body points turned into limb directions, the same recording always getting the same score, and no model to retrain. We make it fairer by testing it instead: every round is recorded as pose data and replayed through the real scorer, and each good round becomes six altered copies whose right answer is known. That is how we found that standing completely still scored 66 on a real round; the engine fix shipped the same night ([jester#82](https://github.com/aaron-sulbaran/jester/pull/82)), and guard cases keep it fixed. LangChain deep agents work on top of this: [the Chamberlain](#the-chamberlain-our-clip-reviewer) reviews the clips players submit, and a referee coach that investigates scoring with the real scorer is in review ([jester#106](https://github.com/aaron-sulbaran/jester/pull/106)).

## How it works

![How a round runs: pick a clip, deal the secret parts, pass the laptop, see your part, play, score, the reveal, the crown.](https://aaronsulbaran.com/hack-princeton/brand/devpost/diagram-round.png)

1. **Pick a clip and a mode.** The video bank holds eight clips, or play a file from your computer; with an empty bank the game falls back to two built-in starter clips that also work offline. Then pick Blind or Normal.
2. **Jester reads the moves.** The clip side finds up to 4 people per frame and the things that move, notices cuts, follows each subject through the clip, and writes a guide for each: the pose over time (33 body points), the box over time and an outline. A clip it cannot use is refused with a sentence a player can read.
3. **Copy your secret part.** Pass the laptop, or play online with a room code, each on your own device. In Blind you see only your part's shape; in Normal the clip plays too. Pick how to copy it: with your whole body, or with one hand, your head or one foot following it. Slower speeds (0.75 and 0.5) are scored in the clip's own time.
4. **Score and reveal.** The engine scores each copy from 0 to 100 limb by limb, then the reveal plays: a title card, the cast over the clip, the busiest few seconds beside the original, and a cast card with every score.

<!-- PICTURE SLOT: a blind turn (the outline a player copies) and the reveal (players over the real clip). Real screenshots only. -->

## What each part does

![How a clip becomes a guide: fingerprint, frames, find, follow, rank or refuse, the guide.](https://aaronsulbaran.com/hack-princeton/brand/devpost/diagram-clip-to-guide.png)

| Part | Where | What it does | Tests |
|---|---|---|---|
| Clip side | `clip/`, `app/src/clipside/` | Reads the video's frames, finds people (MediaPipe Pose Landmarker) and moving things (EfficientDet-Lite0), detects cuts, follows and rejoins each subject, ranks them, refuses clips it cannot use, and turns each subject into a guide. Saved under a fingerprint of the file, so the same video gives the same result. | 141 |
| Webcam side | `spikes/pose-match/webcam.mjs` and its helpers | Tracks the player's 33 body points live, smooths them (One Euro filter), and keeps a person mask and outline for the reveal cutout. | 53 |
| Engine | `engine/` | Scores a copy: 12 limb directions (so height, size and distance do not matter), the round read both as a mirror image and the same way round with the better kept, one lag for the round, and credit only for accuracy that beats standing still or for moving the way the clip moves, so standing still scores near 0. Things are scored by how the player's body follows the thing's box. Same inputs, same score, bit for bit. Engine 0.12.0. | 88 |
| Rooms | `spikes/pose-match/rooms.mjs`, `app/src/ui/room.ts`, `app/src/supabaseTransport.ts` | Four letter room codes over Supabase Realtime: presence, host handoff, a start synced to the host's clock, late joiners sit out one round, shared results. | 21 |
| Eval | `eval/`, `app/round-log-plugin.ts` | Records every scored round (pose points only, no video) and replays them all against the engine on disk, so a scoring change shows what got better or worse. Each good round also becomes six altered copies with known answers (late, frozen, seated, walked out, jittered, mirrored), with no AI and no extra play, and frozen guard cases with a saved baseline make `npm run eval` fail if a fix comes undone. | 12 |
| Chamberlain | `app/review-agent.ts`, `app/review-dev-server.ts`, `app/src/review.ts` | Reviews the clips players submit and decides which join the bank ([below](#the-chamberlain-our-clip-reviewer)). Bank ids and title cleaning are tested with the clip side, and the "your clip is in" matcher with the game. | none yet for its own judgments; the replay eval is in PR 124 |
| Game | `app/` | The screens, the look, blind mode, online play and the recorded reveal. Vite and TypeScript. | 39, plus typecheck and build |

354 tests in all, every one passing on main (`make test`, run Nov 15). Lab pages that try one part at a time on the dev server are listed in [`docs/labs.md`](docs/labs.md).

## The Chamberlain: our clip reviewer

A LangChain deep agent that reviews every clip players send with Send in a clip and decides, on its own, which ones join the video bank. It hands a clip to a person only when it is unsure. It runs on Aaron's laptop while its desk page is open; it is not part of the public site.

**The loop**

1. A player submits a clip with a name for it ("Gains" for a gym squat). It is stored privately in Supabase.
2. The desk checks for new clips every minute, downloads each one and runs the game's own analysis: who moves, and for how long. An exact copy of a clip already in the bank is turned away by its file fingerprint, with no model call.
3. The Chamberlain (`createDeepAgent` from `deepagents`, running Claude Sonnet 5.5) writes a plan with `write_todos`, asks its `playability-checker` subagent whether the clip plays, and looks at four frames: is it safe for work, and does the name fit? It records one decision: let in, turn away, or ask a person.
4. Let in: the clip is written into the bank and published in about 30 seconds, and the submitter's open tab says "your clip is in". Ask a person: the clip waits on the desk with the agent's plan and reasons, and Aaron decides.

**What it decides alone, and what a person decides**

- Alone: clips that are safe and have a fitting name (let in), clips that break the content rules or cannot be played (turned away), and exact copies (turned away).
- A person: missing or unfitting names, borderline content, and any submitted text that tries to steer it. Code, not the prompt, makes sure it never lets a clip in without a fitting name.

**Learning.** It is built to learn: each decision a person makes on a hand-off becomes a precedent it reads on its next review, so similar cases stop coming back, and precedents never come from content or steering cases. That change is [jester PR 128](https://github.com/aaron-sulbaran/jester/pull/128), still in review and not on main. An eval that replays real and synthetic submissions and reports agreement with people, false approvals and the hand-off rate is [jester PR 124](https://github.com/aaron-sulbaran/jester/pull/124), also in review.

**So far.** Its first real run took 4 clips: it let 1 in on its own, caught a title that tried to steer it and handed that one over, and handed 2 over needlessly (fixed in [PR 111](https://github.com/aaron-sulbaran/jester/pull/111)). Later a clip named "not even a lil bit" went from submission to the public bank with no person involved.

**Limits.** It runs only while the desk is open on Aaron's laptop, where the keys stay; a hosted, login protected Chamberlain is the next step. Prompt injection is reduced, not closed, and the desk's "Ask me before adding a clip" switch holds every approval for a person. Only exact copies are caught, not near duplicates. For each review, four frames, the game's measurements, the title and the credit go to Anthropic, and the submit form says so.

**Code**

- [`app/review-agent.ts`](app/review-agent.ts): the agent (`createDeepAgent`).
- [`app/review-dev-server.ts`](app/review-dev-server.ts): the review queue. Dev server only; it reads `ANTHROPIC_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` from the file `JESTER_REVIEW_ENV` points at, outside the repo, so the keys never reach a browser or a build.
- [`app/review.html`](app/review.html) and [`app/src/review.ts`](app/src/review.ts): the desk.
- [`app/src/submissionWatch.ts`](app/src/submissionWatch.ts): "your clip is in".
- [`supabase/migrations/20261115_submissions_queue.sql`](supabase/migrations/20261115_submissions_queue.sql): the table and bucket rules.

## Challenges

- **Fair scores on gentle clips.** The first blind mode games scored everyone 0. The engine paid only for accuracy above what standing still earns, and on a slow dance standing still already earns 0.80 to 0.85. Engine 0.9.0 also gives plain accuracy credit, but only as far as the player's limbs turn the way the clip's do, so a still body still scores near 0 (`engine/test/fairness.test.ts`). Then a live round showed a player who never moved scoring up to 66 on a clip whose subject mostly stands, so in 0.10.0 the credit for beating standing still counts only as far as the player moved at all (`engine/test/still.test.ts`).
- **Following everyone in a group dance.** In video mode the pose tracker only looks for new people when it loses one, so in a tight four person dance it followed two. Jester now looks on every frame and rejoins a subject's pieces up to 3 seconds apart, near where the last piece was heading and at a similar size.
- **Starting together on different laptops.** Each device measures how far its clock is from the host's (ping and reply, lowest delay wins), so "start at T" is the same moment everywhere. A player silent for 10 seconds is dropped and the next one becomes host.
- **A link instead of a file, without taking the video.** YouTube does not let a page copy its frames. The link lab shares the tab, cropped to the player, reads each frame once for people and drops it. Only the moves are kept.

## Run it

Needs Node 22.18 or newer (the tests run TypeScript directly) and npm.

```bash
git clone https://github.com/aaron-sulbaran/jester.git
cd jester
make setup
make dev
```

Then open http://localhost:5173. No settings file is needed: the dev server takes the two public Supabase settings from the live site by itself, and without a network the game still runs in one browser. Every setting is named in [`app/.env.example`](app/.env.example). Add `?nocam=1` to play with simulated players and no camera.

`make test` runs the type checks and all 354 tests, `make build` builds the game into `app/dist`, and `make help` lists the targets. Each folder's README goes deeper: [`app/`](app/README.md), [`engine/`](engine/README.md), [`clip/`](clip/README.md), [`eval/`](eval/README.md).

## Team and how we built it

- **Aaron Sulbaran** ([aaron-sulbaran](https://github.com/aaron-sulbaran)): the clip side and the look.
- **Lisa Hadi** ([lisahadi](https://github.com/lisahadi)): the webcam side and rooms.
- **Alex Huang** ([alexx0711](https://github.com/alexx0711)): the scoring engine and the game's rules.

**AI tools.** Each of us worked with Claude Code (Claude Opus 5.5, Sonnet 5.5 and Fable 5.2); commits written with it carry a `Co-Authored-By` line naming the model. The game itself calls no language model: every score comes from the pose and object models running in the browser and from fixed code. The one model call is the Chamberlain's, on clips players submit.

**How we built this.** Three people each ran several coding agents at once, so the repo carries its own rules for them. [`AGENTS.md`](AGENTS.md) at the root is what every agent reads first, whatever tool it runs in: how to tell the team which files it is about to touch and what it changed, to commit only as its own person, and that anything a player or a judge sees (screens, wording, colours, the Devpost pictures) keeps one look, so feature work reuses the parts listed in [`docs/design/look-parts.md`](docs/design/look-parts.md). [`CLAUDE.md`](CLAUDE.md) is one line that points Claude Code at the same file, so there is a single copy of the rules. Agents worked on their own branches, and each part has a pure, tested core (`clip/`, `engine/`, the webcam and room modules) that the app imports, which kept parallel work from breaking each other.

## Credits

- Pose tracking and object detection: [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/guide) from Google (Pose Landmarker, and the Object Detector with EfficientDet-Lite0), loaded in the browser.
- Video frames: [Mediabunny](https://mediabunny.dev). Rooms, clip submissions and the shared round log: [Supabase](https://supabase.com). Build: [Vite](https://vite.dev) and TypeScript.
- Clip review: [LangChain Deep Agents](https://github.com/langchain-ai/deepagents) (`deepagents`) and `@langchain/anthropic`, running Claude Sonnet 5.5 from Anthropic.
- Links: the [YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference) and the browser's own tab capture.
- Smoothing: the One Euro Filter (Casiez, Roussel and Vogel, CHI 2012).
- Fonts: Gaegu, Special Elite and Titan One, from Google Fonts under open licenses.
- The jester: drawn procedurally in Blender by [`art/jester/jester.py`](art/jester/jester.py).

## Clips

- No video files live in this repo. It holds motion data and code only.
- For the hackathon demo the bank holds short clips the team picked. The bank's files are copied in at deploy time and never committed.
- The link lab never downloads a video: it reads each captured frame once for people and drops it.
- Send in a clip: whoever sends a clip gives it a name, and it goes to a private bucket. The Chamberlain reviews it first and lets it into the bank on its own only when it is safe and the name fits; anything unsure waits for a person. The form says what goes to Anthropic for the review.
- The round log keeps pose points, the score, and the camera and engine details. No video, no images, no masks.
