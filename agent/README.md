# Jester referee coach (LangChain deep agent)

A `createDeepAgent` agent that investigates the round log with the real, deterministic scorer and reports to Alex. It never scores a round and never edits the engine: the agent proposes, the replay proves. Plan: `jester/design/eval-deep-agent.md` in the team hub (design docs moved there in jester#81).

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
