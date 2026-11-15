# Jester eval suite

Every round anyone plays on a dev server is saved, and one command replays them all through the engine code on disk and says whether a change made scoring better or worse. Nobody has to do anything for rounds to be saved.

## How rounds get saved

`app/round-log-plugin.ts` gives every app file that imports `engine/src/index.ts` a generated module whose scorers come from `app/src/dev/roundTap.ts`, bound to that file's name. The tap calls the real scorer, returns its result untouched, and when the page is idle saves the round. On a dev server it goes to the dev server, which writes `eval/data/rounds/<id>.json` (git-ignored); `JESTER_ROUND_LOG=0 npm run dev` turns it off. On the live site, built with `JESTER_RECORD_ROUNDS=1`, it goes straight to the Supabase table `rounds`; `npm run pull` brings those rounds here. Solo, rooms, blind, duel and the labs are all covered, and no game file changed. A build without that setting includes none of it.

A round keeps the exact two timelines the engine compared (33 points per frame as x, y and visibility; no video, no images, no masks), the full result, the scorer version, the commit and a hash of the engine code, the mode (from the page and the call stack), the bank clip and subject when the page fetched its guides, the camera's size, frame rate and label, the GPU name, and a random id per browser. A 20 second round is about 0.5 MB on disk.

## Test cases on purpose

Add `?dev=1` to any page (it stays on for the tab), or `?tag=nailed` to tag every round on that page load. A small panel in the corner asks what you are about to do on purpose before the round: `nailed`, `stood-still`, `seated`, `late-half-second`, `wrong-moves`, `left-right-swapped`, `walked-out-of-frame`. The tag counts for one round. `app/eval-lab.html` does the same with one clip at a time and no game screens.

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
| late | every frame 500 ms later | the lag moves by 500 (give or take 150) and the score drops at most 15 |
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
