# Jester referee coach (LangChain deep agent)

Jester looks like a party game, but underneath it is a computer vision judge: a webcam pose tracker and a deterministic scoring engine decide how well you copied someone. There is no model to retrain, so making that judge fairer means finding the cases its rules get wrong. The referee coach is a `createDeepAgent` agent that does exactly that: it reads every recorded round, re-runs the real scorer with changed settings to test ideas, and reports to Alex, who owns the engine. It never scores a round and never edits the engine: the agent proposes, the replay proves.

## What it has found

The pieces underneath it found two real scoring gaps on Saturday night, and each was fixed in the engine within minutes:

- **Standing still scored 66** on a real round that scored 73 when played. The derived test cases in `eval/` found it, posted at 11:39 PM; engine 0.10.0 fixed it at 12:07 AM, 28 minutes later (jester#82). Guard cases now make `npm run eval` fail if it ever comes back.
- **Copying with the other side scored 0.** Found after that fix and posted at 12:11 AM; engine 0.11.0 fixed it at 12:23 AM, 12 minutes later (jester#90). It was checked on 26 live rounds: 18 of 19 same-side copies now equal their original, and every other score is unchanged.

The coach's own first runs:

- **Run 1** (26 rounds, 140 cases, 15 minutes, $2.30): on a clip whose moves repeat, a copy pushed past the engine's 1.2 s lag search lines up with an earlier repeat. The seated cap only applies when the thighs are marked hidden. It recommended no engine change, because the setting it tried, raising the lag search, broke another case.
- **Run 2** (3.3 minutes, $1.47): on five of six person clips, every camera player was told "step back", because nothing on their camera view shows where to stand.

A person checks its findings before they are passed on. Once, that caught a wrong claim and led to a better tool.

The game's other deep agent, the Chamberlain (`app/review-agent.ts`), reviews clips people submit and asks a person when unsure.

## Setup

1. `npm install` in `agent/`.
2. Fill in `agent/.env.local` (git-ignored; `.env.example` lists the names). Never commit keys or paste them in chat or the hub.
   - `ANTHROPIC_API_KEY`: the orchestrator, Claude Opus 5.5.
   - `MODEL_API_KEY`: Meta Model API (dev.meta.ai), for subagents on Muse Spark 1.3. Model API credit, not the Muse Code terminal subscription.
   - `LANGSMITH_API_KEY`: traces at smith.langchain.com. `LANGSMITH_TRACING=true` and `LANGSMITH_PROJECT=jester-referee-coach` are already filled in.
3. Pull the latest rounds first: `npm run pull` in `eval/`.

## Run

```
npm run coach                          # investigate the whole round log, write a report for Alex
npm run coach -- "why does mirroring score 0 on the person role?"   # one question
npm run traces -- 3                    # the last 3 runs, read back from LangSmith
npm run spike                          # the plumbing check: plan, one tool, one subagent
JESTER_SUBAGENT=haiku npm run coach    # subagents on Claude Haiku 5.5 instead of Muse
```

The terminal shows every tool call as it happens, subagents included. Reports, findings and proposals land in `agent/workspace/` (git-ignored).

## On autopilot: the watch

```
npm run watch                  # every 3 minutes: pull new live rounds, score them, coach only what newly fails
npm run watch -- --once        # one check, then exit
npm run watch -- --no-coach    # checks only, no model calls
npm run watch -- --baseline    # treat what fails now as already seen
```

Every round played on the live site reaches Supabase by itself. Each check downloads the new ones, scores them and their derived cases with the real engine (no model, no cost), and records one `watch check` run in LangSmith with what it found. When cases fail that no coach run has looked at, it starts `npm run coach` on just those ids; that run shows up as `referee coach (started by the watch)`, tagged `watch`, with the check's run id in its metadata. A gap between coach runs (15 minutes) and a spend cap per session (5 USD) keep it cheap. It runs on a laptop with `.env.local`, never on the public site, and no one approves a constant change while it runs, so proposals only appear in the report.

## How it works

All four parts of a deep agent, each for a real reason:

- **Planning:** `write_todos` (LangChain's `todoListMiddleware`), kept current through the run.
- **Subagents:** `case-investigator` explains one failing or odd case; `what-if-tester` tests one hypothesis about an engine constant. Both run on Muse Spark 1.3, several at once when independent.
- **File system:** a disk-backed workspace shared by every agent: `/findings/` from the investigators, `/reports/` for the final report, `/proposals/` for approved proposals.
- **Detailed prompt:** the rules in `src/coach.ts`. Never invent a number, read limits from the engine, back every fix with a replay, never touch the engine, check the report's numbers before finishing.

Tools (`src/tools.ts`), every one running the real scorer through `eval/src`:

| Tool | Returns |
|---|---|
| `eval_summary` | every round and derived case re-scored now, with its expectation and whether it holds |
| `get_round` | one round or derived case: credit per limb, credit for each second, motion, lag, hidden limbs |
| `engine_constants` | the scorer's limits as they are now, so the agent never guesses one |
| `replay_with` | what-if: constants changed for one call; what it would fix, break, and move by 5 or more |
| `check_numbers` | every number in a draft that no tool returned this run |
| `propose_constants_change` | a proposal file for Alex; a person approves each call at the terminal first |

After the run, the script checks on its own: planned, delegated, replayed, wrote the report, and every number in the report came from a tool.

## Models

Claude Opus 5.5 at medium effort plans and decides; it rejects sampling settings and cannot turn thinking off, and LangChain's wrapper sends neither. Server-side fallbacks are on, so a request a safety classifier declines is retried on a fallback model instead of failing. Subagents run on Muse Spark 1.3 through Meta's OpenAI-compatible endpoint (`https://api.meta.ai/v1`), or on Claude Haiku 5.5.
