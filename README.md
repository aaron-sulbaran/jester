# Jester

![Jester: act out any clip, get judged](https://aaronsulbaran.com/hack-princeton/brand/devpost/hero.png)

**Jester turns a short clip into a party game.** Each player secretly gets one part of the clip, one of the people in it, and copies it on the webcam. In Blind mode, all you see is a figure moving the way they move, never the clip itself. Then the real clip plays back with everyone's cutouts on top, and a jester crowns the winner.

Under the party game is a computer vision judge, and we use LangChain deep agents to keep it fair without retraining a model.

**Play it:** https://jester-pi.vercel.app (a laptop with a webcam, in desktop Chrome or Edge)

Built at HackPrinceton Fall 2026 (November 13 to 15). Main track: **Entertainment**. Special track: **LangChain, Best use of deepagents**.

## Inspiration

![Inspiration](https://aaronsulbaran.com/hack-princeton/brand/devpost/heading-inspiration.png)

Webcam games where you copy a dancer are a known genre. When we looked, we found more than ten from past hackathons, three of which placed.

They all share one limit: someone has to make every level by hand. We wanted the opposite. Drop in a short clip of anyone moving, and it becomes a level, with no one drawing it. Our one line for it: **any video is now a game.**

The second idea came from party games. What if nobody knows what they are copying until the end?

And one honest line about who it is for: it gets a group of friends moving around one laptop, with no equipment beyond a webcam.

## What it does

![What it does](https://aaronsulbaran.com/hack-princeton/brand/devpost/heading-what.png)

- **Pick a clip** from the clip library: find one by name, filter by how many players it fits, or press Surprise me.
- **Set up the game.** Say how many are playing. Two or more can take turns on one laptop, play a **Duel** where everyone copies the same person and the best copy wins, or each play on their own device.
- **Pick a mode.** In **Blind**, you see only your part, and nobody sees the real clip until the end. In **Normal**, you dance along with the clip, which plays beside you with your part outlined in your colour.
- **Up to 4 players** type their names and pick their jester's colour, and Jester deals each one a **secret part** of the clip: one of the people in it.
- **Pass the laptop.** "Everyone else, look away." Each player copies their part with their whole body, a hand, their head or a foot, and can watch it before it counts. In Blind mode the part is a 3D jester moving the way that person moves, never the clip itself, with the plain stick figure on a corner card that a tap swaps in. When you copy a person with your whole body, a taped frame on your camera view shows where to stand, at that person's place and size in the clip.
- **3, 2, 1, copy.** Your part plays on the left, your camera on the right, and clips made from a video play their sound. On one laptop you can play at full speed, a bit slower, or at half speed.
- **The reveal.** After a drum roll, the original clip and your cast play side by side, with every player's cutout drawn on their part and their names and scores, and then the curtains close. It is recorded in the browser as a video you can save or send.
- **The crown.** Each player's face goes on a jester, the spotlight settles on the winner, and everyone leaves with an award.
- **Play online.** Make a room or join one with its 4-letter code or a QR code; the lobby shows everyone's jester, who is ready, and a chat. Each player plays their own part on their own device, and everyone sees the reveal and results together, with real faces and cutouts. The host picks a clip from the bank, Surprise me, or a video from their own laptop, which stays on that laptop while the others get only its shapes.
- **Settings say what Jester saves:** each round's moves as points on a body, with the score and timing, never video or a picture of you, plus a random id for the browser, the browser and graphics chip, the camera's size and frame rate, and which clip was played.
- **Send in a clip** and name it with a hint. The Chamberlain, our deep agent ([below](#deep-agents-for-a-fairer-judge-without-retraining-a-model)), reviews it and lets it into the bank, turns it away, or asks a person when it is unsure; four short steps on the screen show the whole path.

![How a round runs, from picking a clip to the crown](https://aaronsulbaran.com/hack-princeton/brand/devpost/diagram-round.png)

Online, each player is on their own device, so step 3 is skipped.

![Main track: Entertainment](https://aaronsulbaran.com/hack-princeton/brand/devpost/track-entertainment.png)

### Why Jester is entertainment

- It is a party game first, built for a few friends around one laptop or online, with a jester as the host.
- The laugh is built in: secret parts mean you find out at the reveal what you were really copying.
- The retry loop: play the same clip again to beat a friend's score.
- New clips become levels without anyone drawing them, so the game does not run out of things to copy.

## How we built it

![How we built it](https://aaronsulbaran.com/hack-princeton/brand/devpost/heading-how.png)

Three parts, three owners, and one shared format agreed in the first hours: `pose-timeline/1`, 33 body points per frame with real time stamps. The game runs in the browser.

**The clip side (Aaron)** turns a video into one guide per subject.

![How a clip becomes a guide](https://aaronsulbaran.com/hack-princeton/brand/devpost/diagram-clip-to-guide.png)

- The file's SHA-256 is its name. A clip seen before loads its saved analysis from the browser, so the same clip always gives the same guide.
- Frames are decoded at fixed times, 15 a second, with Mediabunny on WebCodecs. If the browser cannot decode the file, it falls back to stepping a video element.
- MediaPipe Pose Landmarker finds up to 4 people in every frame, and each person's mask becomes an outline. Every clip read from a video file also gets a hand pass, so the guides show finger movement, and clips prepared for the bank run an object detector (EfficientDet-Lite0) to find animals and balls.
- Boxes are linked into tracks by overlap. A camera cut ends every track, and a person hidden for up to 3 seconds is joined back up.
- Tracks are ranked by size, how central they are, how much they move and their time on screen. A clip that cannot work is refused with a plain reason, such as "No person found in this clip."
- Clips in the bank are analysed once ahead of time, so a round starts as soon as the video loads.

**The player side (Lisa)** reads the player from the webcam and runs the rooms.

- MediaPipe Pose Landmarker in video mode. It tries the GPU first, then the CPU, retries on the CPU if the GPU fails mid-game, and drops to the lite model below 18 frames a second.
- Hand Landmarker adds fingers to the mirror view. A One Euro filter smooths both.
- The models are cached in the browser and start loading on the start screen.
- Online rooms run over Supabase Realtime: presence with host hand-off, a start synced to the host's clock, late joiners sitting out one round, and each player's face still and cutouts sent to the room for the shared reveal.

**The scoring engine and the game (Alex)** compare the two motions and run the round.

- The blind game deals the secret parts and runs each turn. The figure you copy moves on the clip's own clock, so it stays in time with the clip's sound, and each player's cutout is taken from the tracker's mask about 15 times a second for the reveal.
- Same recording, same score, every time: the engine is a pure function of the two motions, with fixed time steps and rounding, so replaying a saved turn gives the identical result.
- It compares the directions of 16 limbs (arms, legs, torso, head, hands and feet), not positions, so height, body size and distance from the camera do not matter.
- Mirror or not, it counts: each turn is scored both as a mirror copy and as a same-side copy, and the better reading wins.
- A limb gets full credit within 15 degrees and none past 60. Limbs the dancer is moving weigh more than limbs they hold still.
- Both motions are resampled to 30 frames a second, and one reaction delay is found for the whole turn. Up to 0.65 seconds late costs nothing, since you are reacting to moves you cannot see coming.
- Standing still scores close to zero: the score pays for accuracy above what standing still would earn on that clip, and for how much of the clip's movement you actually make. When the clip travels across the frame, part of the score comes from where you are.
- An arm or leg the clip uses but your camera mostly cannot see caps the score at 50.
- Things, and single body parts, are scored on their path instead: how well your movement follows theirs, plus jumps, crouches and moves left or right.
- Every round played in testing is saved with its exact motions, and one command re-scores them all, so each change to the scoring is checked against real rounds before it ships.

**The look (Aaron)** is a scrapbook theatre. It has kraft paper, headings on masking tape, the jester's notes in blue ballpoint, ticket stubs for buttons stamped with the jester's hat, hand-drawn icons on most controls, and a shoebox stood on its side as the stage. The jester himself is a 3D character built by a Python script in Blender and rendered to sprite strips: seven colourways for players to pick from, and the classic one for the host. At the crown, each player's face, cropped from their own turn, goes on their jester.

### Where each part lives, and its tests

| Part | Where | Tests |
|---|---|---|
| Clip side | `clip/`, `app/src/clipside/` | 172 |
| Webcam side | `spikes/pose-match/webcam.mjs` and its helpers | 53 |
| Rooms | `spikes/pose-match/rooms.mjs`, `app/src/ui/room.ts`, `app/src/supabaseTransport.ts` | 27 |
| Scoring engine | `engine/` | 88 |
| Round log and eval | `eval/`, `app/round-log-plugin.ts` | 29 |
| The Chamberlain | `app/review-agent.ts`, `app/review-dev-server.ts`, `app/review.html`, `app/src/review.ts`, `app/src/submissionWatch.ts` | in the game's count; its judgments are replayed by `npm run chamberlain` in `eval/` |
| The referee coach | [`agent/`](agent/README.md) | typecheck |
| The cast checker | `app/cast-checker.ts`, `app/scripts/check-cast.ts` | in the game's count |
| The game and the look | `app/` | 161, plus typecheck and build |

530 tests in all, every one passing on main (`make test`, run Nov 15). Lab pages that try one part at a time on the dev server are listed in [`docs/labs.md`](docs/labs.md).

![Best use of deepagents, by LangChain](https://aaronsulbaran.com/hack-princeton/brand/devpost/track-deepagents.png)

### Deep agents for a fairer judge, without retraining a model

Jester's judge is computer vision plus a scoring engine that gives the same score for the same recording, every time. There is no model to retrain, so we make it fairer with evidence, and put deep agents (`createDeepAgent`) to work on it.

- **The Chamberlain reviews every clip players send in** and decides, on its own while its desk runs on our laptop, which ones join the video bank. A `playability-checker` subagent reads the game's own analysis of the clip; the agent then looks at four frames for safety and checks that the clip's name fits, and lets it in, turns it away, or hands it to a person. It also checks the cast the computer vision found against the frames, and on the clips it lets in, leaves out things that are really a piece of another subject or not there at all (it never drops a person). Code, not the prompt, makes sure nothing gets in without a fitting name, and the desk lists the steps the agent took on each review. It runs on Claude Sonnet 5.5.
- **It learns from our decisions.** When a person decides a hand-off that was clean and simply named, that call becomes a precedent the Chamberlain reads on its next review, so similar cases stop coming back. Content and steering cases never become precedents.
- **It works.** At 1:43 AM, "not even a lil bit" went from submission to the public bank with no person involved, and at 2:25 AM "hoppity" was the second. In its first run it caught a clip title that tried to steer it and handed it to a person.
- **It is measured, not just claimed.** Our replay eval runs it on known cases: on 21 of them (17 synthetic, 3 cast checks and 1 route check; no real submissions yet) it gave the expected answer every time, with no false approvals or rejections, in about 10 seconds and 1.3 cents a review. It hands about half of them to a person, by design.
- **Every round is evidence.** Every scored round on the live site is saved by itself as pose points (no video) and replays through the real scorer exactly: 95 rounds from 15 browsers by 3 AM. Each good round also becomes six altered copies whose right answer is known (late, frozen, seated, walked out, jittered and mirrored), 438 cases by 3 AM. The eval and the coach run when someone starts them.
- **The evidence found real bugs tonight.** A frozen copy showed that standing still scored 66 on a real round; Alex's engine fix shipped 28 minutes after the finding was posted. Next, copying with the other side scored 0; that was fixed 12 minutes after it was posted. Each was found on a few rounds and checked on 18 and 26, and guard cases keep both fixed.
- **The referee coach** is a second deep agent that investigates scoring from recorded rounds. A person runs it, and it works on simulated rounds unless a switch is turned on; its earlier findings were made on real rounds, before that rule, and its LangSmith traces now keep only the shape of each run. Claude Opus 5.5 plans; Muse Spark 1.3 subagents investigate odd cases and re-run the real scorer with changed settings; every number it writes must come from a tool, and a person approves any change. It never edits the engine.
- **The cast checker** is a third deep agent, run by hand on the clips in the bank. It is set up to plan with a to-do list, sends a person checker, a thing checker and a recounter to compare each clip's cast with 12 of its frames, and ends with "clear for play" or "ask Aaron". It never changes the bank and never reads a clip's title or credit. On the 10 bank clips it cleared 7 and flagged 3: an unboxed second dancer in two of them and a box that switches dancers in another, for $0.44.
- **What it cost.** The agent runs we traced in LangSmith up to 3 AM cost about $2.43 in model calls, plus up to $0.76 of Muse credit. Real submissions are never traced.
- **Honest limits.** The Chamberlain runs on our laptop while its desk page is open; it is not hosted yet. Prompt injection is reduced, not closed, and a switch can hold every approval for a person. Only exact copies of a clip are caught. Each review sends four frames, the game's measurements, the clip's title and credit, and recent precedents' titles and reasons to Anthropic.

**In the code:**

- The Chamberlain: [`app/review-agent.ts`](app/review-agent.ts) (the agent), [`app/review-dev-server.ts`](app/review-dev-server.ts) (the review queue, dev server only; it reads `ANTHROPIC_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` from the file `JESTER_REVIEW_ENV` points at, outside the repo), [`app/review.html`](app/review.html) and [`app/src/review.ts`](app/src/review.ts) (the desk), [`app/src/submissionWatch.ts`](app/src/submissionWatch.ts) ("your clip is in"), [`supabase/migrations/20261115_submissions_queue.sql`](supabase/migrations/20261115_submissions_queue.sql) (the table and bucket rules). Its eval: `npm run chamberlain` in `eval/`.
- The referee coach: [`agent/`](agent/README.md). `npm run coach` runs it once; `npm run watch` checks new live rounds every 3 minutes on a laptop and starts a coach run only on cases that newly fail. Its real-rounds switch lives in the git-ignored `agent/.env.local`.
- The cast checker: [`app/cast-checker.ts`](app/cast-checker.ts), run with `npm run check-cast` in `app/`.
- The round log and its eval: `eval/`, with `npm run eval`.

![Tech stack](https://aaronsulbaran.com/hack-princeton/brand/devpost/heading-stack.png)

| Part | What we used |
| --- | --- |
| Language and build | TypeScript 5.9, Vite 6 |
| Body tracking | MediaPipe Tasks Vision 0.10.14: Pose Landmarker (lite, full), Hand Landmarker |
| Things in clips | MediaPipe Object Detector with EfficientDet-Lite0 |
| Video decoding | Mediabunny on WebCodecs, with a video element fallback |
| Saved analyses | IndexedDB, keyed by the file's SHA-256 |
| Reveal video | Canvas capture and MediaRecorder (WebM, or MP4 where WebM is not supported) |
| The 3D jester guide | three.js |
| Deep agents | LangChain deepagents (`createDeepAgent`); Claude Sonnet 5.5 for the Chamberlain; Claude Opus 5.5 with Muse Spark 1.3 subagents for the referee coach; LangSmith tracing |
| Submissions, the round log and rooms | Supabase (Storage, tables, Realtime) |
| Hosting | Vercel, with the clip bank as static files |
| The jester | Blender 5.2, scripted in Python, rendered with EEVEE |
| Fonts | Gaegu and Titan One (SIL Open Font License), Special Elite (Apache License 2.0) |
| Tests | Node's built-in test runner, and GitHub Actions on every pull request |

### Credits

- **Aaron Sulbaran** ([aaron-sulbaran](https://github.com/aaron-sulbaran)): the clip side, the video bank, the Chamberlain, the round log and eval, and the look. **Lisa Hadi** ([lisahadi](https://github.com/lisahadi)): the webcam side and online rooms. **Alex Huang** ([alexx0711](https://github.com/alexx0711)): the scoring engine, the blind game and the reveal.
- [MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/guide) from Google for pose, hand and object tracking; [LangChain deepagents](https://github.com/langchain-ai/deepagents); [Anthropic](https://www.anthropic.com) Claude and Meta's Muse Spark for the agents; [LangSmith](https://smith.langchain.com) for tracing; [Mediabunny](https://mediabunny.dev) for decoding; [Supabase](https://supabase.com); [Vercel](https://vercel.com); [Blender](https://www.blender.org); [three.js](https://threejs.org) for the 3D jester guide.
- Fonts: Gaegu and Titan One under the SIL Open Font License, and Special Elite under the Apache License 2.0.
- Built with AI coding assistants. Every change was reviewed by the team.
- Also: the One Euro Filter (Casiez, Roussel and Vogel, CHI 2012) for smoothing, and on the link lab page the [YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference) and the browser's own tab capture.

## Challenges we ran into

![Challenges we ran into](https://aaronsulbaran.com/hack-princeton/brand/devpost/heading-challenges.png)

- **The same clip must give the same guide.** Our first stand-in read the clip from a playing video, timed by the wall clock, so the same file gave different guides. Now frames are decoded at fixed times and the analysis is saved under the file's fingerprint.
- **One dancer, many tracks.** People cross, turn and hide behind each other, and a tracker loses them. Early runs split one dancer into a pile of short tracks. Rejoining after gaps of up to 3 seconds, plus cut detection, fixed most of it.
- **Standing still must not score, but moving must.** A naive pose score gives points for doing nothing. Our first fix scored every player 0 on gentle dance clips; the next let a statue score 66 on a mostly standing clip; and copying with the other side scored 0. The last two were caught by replaying real rounds, and guard cases keep both fixed.
- **Laptop cameras rarely see legs.** Whole-body parts wait until you fit in frame. A hidden limb caps the score instead of being skipped, and you can choose to play a part with a hand, your head or a foot.
- **A reviewer people can talk to is a reviewer people can steer.** In its first run, a clip's title tried to tell the Chamberlain what to decide. It handed that clip to a person, and code, not the prompt, now decides what can get in without a fitting name.
- **Fast motion.** At 15 frames a second, a sudden move can fall between frames.

## Accomplishments that we're proud of

![Accomplishments that we're proud of](https://aaronsulbaran.com/hack-princeton/brand/devpost/heading-wins.png)

- A clip nobody drew by hand becomes a playable level, analysed in the browser.
- Your guide in Blind mode is a 3D jester that moves the way your part moves. It became the default after two of us played real-camera rounds on it.
- The clip reader tracks moving things as well as people, so a ball can become a part as soon as the bank has a clip with one.
- The reveal puts everyone's cutout on the clip they copied, online too, and records it to a video you can send.
- A deep agent runs our clip bank's front door, and clips have gone from a player's upload to the public bank with no person involved.
- 530 automated tests pass on main, and every pull request runs them.
- A jester host of our own, from a Blender script, who wears each player's face at the crown.

## What we learned

![What we learned](https://aaronsulbaran.com/hack-princeton/brand/devpost/heading-learned.png)

- **Measure with code, decide with rules.** Every number in a guide comes from the tracker, so a score can be explained.
- **Repeatable takes design.** It took decoding at fixed times and saving the analysis under the file's fingerprint.
- **Compare directions, not positions.** It makes size and distance from the camera disappear.
- **Turn every round into evidence.** Once rounds replay exactly, a fairness bug becomes a test case, and an agent can look for the next one.
- **Agree on the data first.** One shared pose format, settled early, let three people build three parts at the same time.

## What's next for Jester

![What's next for Jester](https://aaronsulbaran.com/hack-princeton/brand/devpost/heading-next.png)

- **A hosted Chamberlain** behind a login, so the bank grows while our laptops are closed, and near-duplicate detection on top of exact copies.
- **Paste a link instead of a file.** Grabbing a YouTube or Instagram clip from a browser tab already works on our lab page, but not yet in the game.
- **Agents on every round.** Run the free eval on each new round as it lands, and call the coach only when the eval sees something new.
- **A bigger bank,** filled by players through Send in a clip.
- **Where the data could go: physical AI.** Every round already pairs a demonstration (the clip's body pose over time) with a graded imitation (a player's copy, scored limb by limb and second by second), and the derived copies arrive with their right answers attached. That pairing is the raw material imitation learning and motion retargeting work with, and the referee coach, which looks for where the grader rewards the wrong thing, checks the same failure that lets a learned policy cheat its reward. It is a direction, not something Jester does: the poses are 2D from one webcam with no depth or forces, and about a hundred rounds is a demo, not a dataset. Movement data from real people needs their consent before any model reads or trains on it, and that consent is missing today, which is why the referee coach now reads only simulated rounds unless we turn real ones on.

## Run it

Needs Node 22.18 or newer (the tests run TypeScript directly) and npm.

```bash
git clone https://github.com/aaron-sulbaran/jester.git
cd jester
make setup
make dev
```

Then open http://localhost:5173. No settings file is needed: the dev server takes the two public Supabase settings from the live site by itself, and without a network the game still runs in one browser. Every setting is named in [`app/.env.example`](app/.env.example). Add `?nocam=1` to play with simulated players and no camera.

`make test` runs the type checks and all 530 tests, `make build` builds the game into `app/dist`, and `make help` lists the targets. Each folder's README goes deeper: [`app/`](app/README.md), [`engine/`](engine/README.md), [`clip/`](clip/README.md), [`eval/`](eval/README.md), [`agent/`](agent/README.md).

## Built with coding agents

**AI tools.** Each of us worked with Claude Code (Claude Opus 5.5, Sonnet 5.5 and Fable 5.2); commits written with it carry a `Co-Authored-By` line naming the model. The game itself calls no language model: every score comes from the pose and object models running in the browser and from fixed code. The model calls are the deep agents' (above), which run on our laptops.

**How we built this.** Three people each ran several coding agents at once, so the repo carries its own rules for them. [`AGENTS.md`](AGENTS.md) at the root is what every agent reads first, whatever tool it runs in: how to tell the team which files it is about to touch and what it changed, to commit only as its own person, and that anything a player or a judge sees (screens, wording, colours, the Devpost pictures) keeps one look, so feature work reuses the parts listed in [`docs/design/look-parts.md`](docs/design/look-parts.md). [`CLAUDE.md`](CLAUDE.md) is one line that points Claude Code at the same file, so there is a single copy of the rules. Agents worked on their own branches, and each part has a pure, tested core (`clip/`, `engine/`, the webcam and room modules) that the app imports, which kept parallel work from breaking each other.

## Clips

- No video files live in this repo. It holds motion data and code only.
- For the hackathon demo the bank holds short clips the team picked. The bank's files are copied in at deploy time and never committed.
- The link lab never downloads a video: it reads each captured frame once for people and drops it.
- Send in a clip: whoever sends a clip gives it a name, and it goes to a private bucket. The Chamberlain reviews it first and lets it into the bank on its own only when it is safe and the name fits; anything unsure waits for a person. The form says what goes to Anthropic for the review.
- The round log keeps pose points, the score, and the camera and engine details. No video, no images, no masks.
