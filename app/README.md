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

The lab's switches can be set from the URL too: `?overlay=skeleton|outline|both`, `?look=outline|stick`, `?place=fit|exact`. Its table shows how many blind mode roles the clip gives, and how many track pieces were joined into how many tracks.

The lab's link box opens the link lab (`link-lab.html?link=<link>`) with that link, for clips that are not downloaded. The link lab arrives with pull request 32.

On the pick frame, a dashed box is a person who is not in that frame, drawn where they are nearest to it, so every person found can be chosen.

`?model=heavy` (or `lite`) runs a fresh analysis with that pose model and does not save it; the table's "Seconds taken" is the number to compare with the default `full`. The game always uses `full`.

The pose tracker looks for people on every frame (MediaPipe IMAGE mode). In VIDEO mode it only looks again when it loses someone, so in a tight group dance it could follow 2 of 4 dancers for the whole clip. `?search=tracking` runs the old way, not saved, to compare. Analyses saved before this change are not used.

People the pose model drops for a while (behind another dancer, at the back) come back as a new track. The people step is `trackPeople` in `clip/src/people.ts`, which `analyze.ts` and `grab.ts` both call. It links with a 1 second gap, and a detection that would start a new track first gets a second chance against tracks that found no one this frame, by their usual box (the median of their last 5), so one odd box does not lose a person. It then joins pieces with `rejoinTracks` (up to 3 seconds apart, near where the earlier piece ended or was heading, a similar size). It merges tracks that overlap in time but show the same person (`mergeOverlapping`: the pose model saw someone twice and the two tracks traded her frames), and finally runs identity repair. Saved analyses keep their frames and run this again when opened, so they pick up the joining without a fresh analysis. Bank `guides.json` files are built ahead of time and need a re-export to pick up a change here.

`?nocam=1` ticks "Simulated player": a stand-in copies the clip with 150 ms lag and an adjustable wobble, no camera needed.

## Blind mode: the three clip side calls

All three are in `src/clip.ts`. A refusal is a sentence a player can read, never a throw.

```ts
const prepared = await prepareVideo(file, videoElement, (share) => (bar.value = share));
if (prepared.error !== null) return show(prepared.error);          // e.g. "No person found in this clip."
const { guides, skipped } = subjectGuides(prepared.data);           // one guide per person, best first
const roles = guides.map((guide, i) => ({ player: players[i], guide }));
const mine = confirmSubject(prepared.data, prepared.data.candidates[0]!.trackId); // one picked person
```

- `prepareVideo(file, video, onProgress)` reads the first 30 seconds at 15 frames a second and finds up to 4 people. The same file again comes back from the saved analysis in about no time (`fromSaved: true`).
- `subjectGuides(prepared)` gives a guide for every person in the top person's shot, so all roles share one `range` and play over the same stretch of the clip. People in another shot, out of view most of the time, or too small go to `skipped` with the sentence why.
- `confirmSubject(prepared, trackId)` is the same guide for one person the player picked (single player rounds).

### Things as roles (animals, balls, cars)

Pass `{ things: true }` to `prepareVideo` and `subjectGuides` returns the people first, then every thing the object detector found that moves, all from the same shot. It is off by default, so solo play and people results are unchanged; it adds a second detector (EfficientDet-Lite0, every third frame). With it on, a clip with no people but a moving thing is not refused.

```ts
const prepared = await prepareVideo(file, videoElement, onProgress, { things: true });
const { guides } = subjectGuides(prepared.data);
for (const guide of guides) {
  if (guide.subject.kind === "thing") playObjectRound(thingObjectClip(guide), player, onLive, bodyPart);
}
```

A thing guide has `subject.label` like "Dog 1" or "Ball 2", `timeline` null, `channel` "trajectory", a `box-track/1` the engine scores as is, and `outlines` that are a 24 point ellipse in the box (the detector gives no mask), the same shape `blind.ts` draws for a thing. `thingObjectClip(guide)` in `src/clip.ts` returns the shape of `ObjectClip` in `src/objectClips.ts`: `track` is the guide's box track, `boxAt(ms)` for the reveal, `name` ("dog"), and a `hint` from the ways the box moves. Draw a thing's blind view with the "outline" look. A thing that never moves goes to `skipped` with "This one does not move, so there is nothing to copy." Check it in `things-lab.html` (`?clip=<name>`, `?fresh=1`).

Each guide carries, one entry per frame at the same times: `timeline` (pose, for the engine's pose channel), `boxTrack` (the box over time) and `outlines` (a closed polygon of up to 60 points in normalized image coordinates, null where the person is missing). `range` is the clip's media time for that stretch.

To draw what a player sees without the clip: `placeSubject(guide, canvas, "fit" | "exact")` from `../clip` gives the placement once per guide, and `drawBlind(canvas, guide, guideFrameAt(guide, mediaMs), "outline" | "stick", view)` from `src/clipside/blind.ts` draws one frame. "fit" centres the subject on its own average position at about 70 percent of the canvas height and shrinks it if its movement would leave the canvas; "exact" keeps it where it is in the clip frame. The clip lab shows both.

## Blind mode: the game (src/blind.ts)

`blind.ts` is the whole game and makes no DOM. Screens plug in as a `BlindUi` (typed at the top of the file); `src/blindScreens.ts` is the plain stand-in on the ids in `index.html` until the look's screens replace it. `?blind=1` opens it, `?nocam=1` plays it with simulated players.

```ts
const scene = demoScene() /* or */ dribbleScene() /* or */ await videoScene(file, video, onProgress); // a string means "why not"
const rows = await runBlindGame(scene, names, ui, { simMode, noise, getCamera }, { speed: 0.75 });
```

- Roles: one per subject in the scene (people from `subjectGuides`; things once jester#15 merges and `videoScene` passes `{ things: true }`). They repeat only when there are more players than subjects.
- What a player sees: never the role's name. `ui.showPart` is called while the stage shows the role's first frame; the player picks a body part (offered for every role) and can watch it once (`role.preview()`, unscored). A person copied with the whole body is scored limb by limb (pose channel); anything copied with a hand or the head is scored as that part following the role's box (trajectory channel).
- During a turn the role is drawn smoothly (blended between samples) with a faint copy `leadMs` (400) ahead, so the next move shows coming.
- Speed: `speed` 1, 0.75 or 0.5 slows every turn. Turns are scored in the clip's own time (the player's frames are sped back up), so slow motion does not change scores, and lag is forgiven in proportion. The reveal plays at the clip's own speed with each cutout sped up to match.
- End: `ui.results(rows)` (name, role, look, score, winner or tied, plus `guide` and `timeline` in clip media ms for Lisa's `drawReveal`), then the reveal records on `ui.revealCanvas()` and `ui.revealReady(url)` hands over a webm to play and download. The reveal is four segments in one file (`recordSegments` in `src/cutout.ts`): a title card, the cast over the clip at the clip's own speed, the busiest 6 seconds side by side with the original, and a cast card (each player's cutout, role, score, winner).

## How the engine is wired

Each player frame is tagged with `clipTimeMs`, the clip's playback time when the frame arrived (video `currentTime`, or wall time since start for the starter clip). The engine's adapter uses that in place of `trackerTimeAtClipStartMs`, and it stays right if the video stalls. Frames before the clip starts are tagged -1 and dropped.

## Paste a link (tab capture)

The link lab, http://localhost:5173/link-lab.html (dev server only), takes a YouTube, Shorts, TikTok or Reels link. A YouTube clip plays in the official embedded player on the page; Grab the moves shares this tab (cropped to the player with Region Capture), plays the chosen stretch (15 seconds by default, 30 at most) and stamps each frame with the player's own time. TikTok links with an embed play on the page (Instagram's embed refused the posts tried, so Instagram uses another tab) and Grab from this page shares this tab cropped to the embed, with Start and Stop timed from Start. Grab from another tab works for any site the same way through the browser's tab picker; keep Jester visible (the clip's tab in its own window beside it). People are followed with the same people step as the file path (`trackPeople`), and saved grabs run it again when loaded. Either way the result is the same `Prepared` analysis the file path builds, saved under a key made from the link and the range (`yt:<id>:<startMs>-<endMs>`), so the same link and range come back at once. Desktop Chrome and Edge only; phones are told to upload a file. Code: `src/clipside/capture.ts`, `link.ts` (parsing, tested in `clip/test/link.test.ts`), `grab.ts`, `youtube.ts`.

What is kept: only the people analysis (boxes, joints, outlines, times). Jester never downloads, saves or uploads the video or any frame of it. Each captured frame is read once for people and dropped, and no tool or service that fetches video files from YouTube, TikTok or Instagram is used.

## Video bank (clips with their moves found ahead of time)

The game's clips come from a bank of static files: `index.json` (schema `bank/1`) and, per clip, `<id>/clip.mp4` (or `.webm`), `<id>/poster.jpg` and `<id>/guides.json` (the array `subjectGuides` returns, people then things). The files are not in git (no videos in the repo): they live in `jester-deploy/bank/` on Aaron's laptop, and the deploy copies them to `/bank` with an open cross-origin header.

```ts
const listed = await listBank();                       // src/bank.ts: /bank, or the public site's bank in a local run
const scene = await bankScene(listed.data[0], video);  // src/bankRound.ts: the same Scene videoScene builds, no analysis
const guides = await loadBankGuides(clip);             // the saved guides, for a solo round: bankSoloClip or thingObjectClip
```

Every call returns `{ data, error }` with a sentence a player can read. `index.json` reading is pure (`src/bankIndex.ts`, tested in `clip/test/bank.test.ts`).

- Adding clips: `bank-lab.html` (dev server only). Pick the bank folder once, pick a video, check the outlines sit on the cast, type a title and a credit, Add to the bank. "Add many at once" takes a batch (file names become titles, one credit for all). MOV files go in as `clip.mp4` (same container). "Add the starter clips" adds the credited Wikimedia Commons clips from `public/_clips/`. Remove deletes a clip's folder.
- Two banks: `jester-deploy/bank/` is copied into every deploy of the public site, so it holds only clips we may share. Clips saved from TikTok or Instagram for testing go in `hack-princeton/jester-private-bank/`, which never leaves the laptop: run the dev server with `JESTER_BANK_DIR` pointing at it.
- Local runs: start the dev server with `JESTER_BANK_DIR=<bank folder>` and it serves that folder at `/bank` (`bank-dev-server.ts`); without it the game reads the public site's bank.
- Submit your own: `submitClip(file, { title, credit }, onProgress)` in `src/submit.ts` uploads to the private bucket `submissions` as `<uuid>.<mp4|webm|mov>` (25 MB at most) and adds one row to table `submissions` (`video_path`, `title`, `credit`). The page's key can add but never read. The table and bucket rules are in `supabase/migrations/20261115_submissions_queue.sql`.
- Reviewing submissions: the Chamberlain's desk, `review.html` (dev server only, Aaron's laptop; the public site does not run it). The Chamberlain is a LangChain deep agent (`createDeepAgent` from `deepagents`, `review-agent.ts`). For each pending submission the desk downloads the video, runs the game's own analysis and grabs four frames. By default (`JESTER_REVIEW_MODE` unset or `deep`) the Chamberlain may write a plan with `write_todos` (offered, optional, unused in test runs; deepagents only adds the tool for some model families, so deep mode adds LangChain's todo middleware), asks its `playability-checker` subagent for the game's verdict, looks at the frames, reads its recent precedents, and records approve, reject or ask a person. The same verdict is also computed in code (`playabilityOf`); if the subagent disagrees, the code's verdict stands and a person decides. `JESTER_REVIEW_MODE=fast` hands the code's verdict to the Chamberlain and decides in one model call (about 3 to 4 s against 8 to 9 s). Code, not the model, holds the line: a clip is approved only with a fitting name, clean content, no steering and a "plays well" verdict (`finalize`). The desk shows the finding, what it saw and the decision. Approved clips are written into the bank folder (it must be the `JESTER_BANK_DIR` the dev server serves, whose `index.json` change the deploy watcher publishes), and only then is the row marked `approved`. A clip the analysis cannot use is turned away without asking the model. Unsure ones wait under "Needs you" for a yes in the paper dialog; "Ask me before adding a clip" holds every approval there. Deciding by hand needs only the Supabase key. Keys: `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and optionally `JESTER_REVIEW_MODEL` (default `claude-sonnet-5-5`), read on the dev server only from the file `JESTER_REVIEW_ENV` points at (Aaron's is `jester-deploy/.env.review`, outside the repo), never a `VITE_` setting. What leaves the laptop per review: the four frames, the analysis facts, and the title and credit, to Anthropic. The `/__review` routes answer only a localhost Host from the dev server's own pages. Decisions and reasons are logged in `jester-review-log.json` beside the env file, since the table has no column for them. Precedents: when Aaron decides a clip the Chamberlain asked about, `jester-precedents.json` beside it gets one line (`review-precedents.ts`): the submitted name, why it asked (from a fixed list written by code, never the model's words), and what he did. The Chamberlain reads the latest 12, so the same kind of name or playability question needs a person less often. Cases about content or steering never become precedents. The precedents' names go to Anthropic with each review. Tracing: real submissions are never traced to LangSmith while the Submit your own notice names only Anthropic. `reviewSubmission` refuses to run a case not marked synthetic when tracing is on (LangChain's `LANGSMITH_TRACING` switch in the environment, or a tracer passed in), unless the env file says `JESTER_REVIEW_TRACE_REAL=notice-names-langsmith`; the desk's own tracer (`LANGSMITH_API_KEY` and `JESTER_REVIEW_TRACE=1` in the env file) is under the same rule. Run benchmarks of real clips with tracing off. Names are hints, not descriptions: a name fits when it relates to the clip ("Gains" for a gym squat). `node scripts/chamberlain-bench.ts` times reviews of saved clips by stage (see its header).
- Known limits (submissions): anyone with the page can submit as many videos as they like, and an upload is not tied to its row (a video can arrive with no row, or a row with no video). A later version should hand out short-lived upload links from a rate-limited server step.

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

- Outlines and the blind mode preview (Saturday evening): Aaron ran the lab in his own browser and the outline sits on the person.

## Not checked

- Outline jitter and analysis speed with masks on, measured: Aaron looked by eye only.

A real camera. First person at a laptop: run a round and post the score and how it felt.

- A clip with two people and a real one-person jumping jack clip: the files with those names do not contain them.
- The `<video>` element fallback decoder: every test clip decoded with WebCodecs in this Chrome.
- A tracker failure partway through ("The pose tracker stopped working. Reload the page and try again."): only shown to pass through `readFrames`, not triggered in the lab.
- Clips over 30 seconds: none in the set.

## Round log, build stamp and eval lab

Every scored round is saved without any game file knowing: `round-log-plugin.ts` gives each app file that imports `engine/src/index.ts` a small generated module whose two scorers come from `src/dev/roundTap.ts`, bound to that file's name. The tap returns the scorer's result untouched and saves the round when the page is idle: on a dev server to `eval/data/rounds` (`JESTER_ROUND_LOG=0` turns it off), and on a production build made with `JESTER_RECORD_ROUNDS=1` to the Supabase table `rounds` with the page's public key, up to 20 s after the round so it stays out of play. Without that setting none of it ships. Add `?dev=1` to any page for a corner panel that tags the next round as a test case (nailed, stood-still, seated, and so on), or `?tag=nailed` to tag every round on that page load. The eval lab, `eval-lab.html` (dev server only), plays one tagged round at a time on a bank clip or the starter dance. Reading the results: `eval/README.md`.

`build-stamp.ts` adds a quiet stamp in the bottom right corner of every page: "local" on a dev server; on a build made with `JESTER_BUILD_STAMP=1`, the first 7 characters of the commit and the build time. That build also writes `version.json` (`{ commit, builtAt }`); each page checks it once a minute and, when a newer build is live, shows "A newer version is live. Refresh when you are between rounds." with a Refresh button. It never reloads on its own. The commit comes from `VERCEL_GIT_COMMIT_SHA`, else git. Class names for the look: `.jester-build-stamp`, `.jester-update-notice`, `.jester-update-notice__text`, `.jester-update-notice__refresh`.
