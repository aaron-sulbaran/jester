# Jester eval suite

Every round anyone plays on a dev server is saved, and one command replays them all through the engine code on disk and says whether a change made scoring better or worse. Nobody has to do anything for rounds to be saved.

## How rounds get saved

`app/round-log-plugin.ts` gives every app file that imports `engine/src/index.ts` a generated module whose scorers come from `app/src/dev/roundTap.ts`, bound to that file's name. The tap calls the real scorer, returns its result untouched, and when the page is idle saves the round. On a dev server it goes to the dev server, which writes `eval/data/rounds/<id>.json` (git-ignored); `JESTER_ROUND_LOG=0 npm run dev` turns it off. On the live site, built with `JESTER_RECORD_ROUNDS=1`, it goes straight to the Supabase table `rounds`; `npm run pull` brings those rounds here. Solo, rooms, blind, duel and the labs are all covered, and no game file changed. A build without that setting includes none of it.

A round keeps the exact two timelines the engine compared (33 points per frame as x, y and visibility; no video, no images, no masks), the full result, the scorer version, the commit and a hash of the engine code, the mode (from the page and the call stack), the bank clip and subject when the page fetched its guides, the camera's size, frame rate and label, the GPU name, and a random id per browser. A 20 second round is about 0.5 MB on disk.

## Test cases on purpose

Add `?dev=1` to any page (it stays on for the tab), or `?tag=nailed` to tag every round on that page load. A small panel in the corner asks what you are about to do on purpose before the round: `nailed`, `stood-still`, `seated`, `late-half-second`, `wrong-moves`, `left-right-swapped`, `walked-out-of-frame`. The tag stays picked for every round (each blind mode turn is its own round) until you change it; the note counts for one round. `app/eval-lab.html` does the same with one clip at a time and no game screens.

What each tag promises is in `expectations.ts`, one file:

| tag | holds when |
|---|---|
| nailed | 75 or more |
| stood-still | 10 or less, or no score |
| seated | 50 or less, on a clip whose thighs or shins swing 25 degrees or more |
| late-half-second | lag within 150 ms of 500, and within 15 of the same tester's nailed round on the same clip |
| wrong-moves | under 40, or no score |
| walked-out-of-frame | no score, or 50 or less |
| left-right-swapped | report only: whether swapping should cost points is Alex's call |

## Derived cases

Every nailed round, and every untagged round scoring 60 or more, also becomes six transformed copies whose effect on the score is known (`src/derive.ts`, thresholds in `expectations.ts` under `derived`). They need no AI and no one playing more rounds.

| transform | what changes in the player's recording | holds when |
|---|---|---|
| late | every frame 500 ms later | the lag moves by 500 (give or take 150) and the score drops at most 15; n/a when the source's lag plus 500 passes the engine's lag search |
| frozen | the first frame held for the whole round | 10 or less, or no score |
| seated | legs (points 25 to 32) invisible | 50 or less, on a clip whose thighs or shins swing 25 degrees or more |
| walked-out | no body for the middle 40 percent | no score, or 50 or less |
| jittered | every point moved up to 0.003 of the frame in a fixed pattern | within 5 of the source |
| mirrored | the same moves done with the other side | report only |

Derived cases of frozen cases join the baseline: one that held and stops holding fails `npm run eval`. Their ids are `<source id>~<transform>`.

## Commands (in `eval/`)

```
npm install
npm run eval                          # re-score frozen cases and local rounds, write report.md
npm run freeze -- --tagged            # copy every tagged local round into cases/ (committed)
npm run freeze -- r-abc123-xyz789     # or name rounds
npm run eval -- --save                # save the headline numbers to baseline.json
npm run eval -- --set ROUND.ceiling=0.9   # what-if: change engine constants for this run only
npm run upload / npm run pull         # share rounds through the Supabase table `rounds` (settings from app/.env.local or the live site)
npm run check                         # typecheck and tests
```

`npm run eval` exits with an error only when a frozen case's expectation held in `baseline.json` and no longer holds. It also lists every round whose score moved by 5 or more since it was played, and gives calibration hints (the score ceiling that would put the median nailed copy at 90). It changes nothing in the engine.

Frozen cases are `cases/<id>.json.gz`, with each clip's reference stored once in `cases/refs/`.

## The Chamberlain's eval

The Chamberlain (`app/review-agent.ts`, a LangChain deep agent) decides which clips sent with Submit your own join the bank. `npm run chamberlain` replays its cases through `reviewSubmission` with the prompt and model on disk, so a prompt change shows what it does to brand-new clips before Aaron's desk sees it.

**Cases.** Two kinds:

- Synthetic, in `chamberlain-cases.ts` (committed): clean controls, steering in the name, the credit and painted into the frames, names that do not fit or are missing or inappropriate, and borderline analysis facts. Frames are stick figures drawn by `src/frames.ts`, never real people. Each case says the verdict it should get.
- Desk: every clip the desk judges is saved by the dev server (`app/review-cases.ts`) as `chamberlain-cases/<submission id>.json` beside the review env file (`jester-deploy/`, outside every repo, owner-only): the exact judge input with its frames, the decision, and later the outcome from the desk's decide route. A case whose file missed its outcome takes it from the desk's review log. They hold real frames and titles: nothing is saved, and the runner refuses to run, when that folder is inside a git checkout, and `.gitignore` covers any `chamberlain-cases/` folder.

**Truth.** For a desk case, only a person's outcome counts: let in under the name it was sent with means approve; renamed (or named for the first time) means the Chamberlain should have asked a person, since it never names a clip; rejected means reject. An outcome the Chamberlain reached alone confirms nothing, so that case only shows whether the verdict changed. A hand label in the case file wins: `"label": { "want": "reject", "alsoOk": ["ask_a_person"], "note": "why" }`.

**Report.** Agreement with the truth, false approvals (approved what a person turned away or renamed), false rejections, how often it asked a person when the answer was clear, the escalation rate, verdicts that changed since a case was captured or since the last run, and every differing case with its reasons. A false approval or a review that did not run fails the run; the rest is for a person to read. It prints the number of reviews before it starts and the tokens (with the cached ones) and dollars after: one case is one review, about five model calls and about $0.035 on claude-sonnet-5-5, since most input comes from the prompt cache. Reports go to `chamberlain-cases/runs/`.

```
npm run chamberlain                          # synthetic cases and every desk case
npm run chamberlain -- --dry-run             # list the cases and their truth, no model calls
npm run chamberlain -- --source synthetic    # or desk; --only id1,id2; --model claude-opus-5-5; --concurrency 2
```

Keys are read from `JESTER_REVIEW_ENV`, else `jester-deploy/.env.review` beside a parent of this repo, and never printed. With `LANGSMITH_API_KEY` in that file, synthetic runs are traced to the LangSmith project `jester-chamberlain-eval` (or `LANGSMITH_PROJECT`), and the report links each trace. Desk cases are never traced (`mayTrace` in `src/chamberlainCases.ts`): a case read from the cases folder is always a desk case, whatever the file says, since its frames, title and credit come from real people. A LANGSMITH_TRACING or LANGCHAIN_TRACING_V2 variable left in the shell is removed before any review (`stopInheritedTracing` in `app/review-agent.ts`), on the desk too, so nothing is traced without an explicit tracer.
