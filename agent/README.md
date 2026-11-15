# Jester referee coach (LangChain deep agent)

A `createDeepAgent` agent that investigates the round log with the real, deterministic scorer and reports to Alex. It never scores a round and never edits the engine. Plan: `docs/design/eval-deep-agent.md`.

## Setup

1. `npm install` in `agent/`.
2. Fill in `agent/.env.local` (git-ignored; `.env.example` lists the names). Never commit keys or paste them in chat or the hub.
   - `ANTHROPIC_API_KEY`: the orchestrator, Claude Opus 5.5.
   - `MODEL_API_KEY`: Meta Model API (dev.meta.ai), for subagents on Muse Spark 1.3. Model API credit, not the Muse Code terminal subscription.
   - `LANGSMITH_API_KEY`: traces at smith.langchain.com (free tier). `LANGSMITH_TRACING=true` and `LANGSMITH_PROJECT=jester-referee-coach` are already filled in.

## Run

```
npm run spike                          # plumbing check: plan, one tool, one subagent on Muse
JESTER_SUBAGENT=haiku npm run spike    # the same with the subagent on Claude Haiku 5.5
```

The spike prints the orchestrator's tool calls in order, tokens and cost per model, and four checks (planned, called the tool, delegated, subagent answered). It exits with an error if any check fails.

## Models

Claude Opus 5.5 at medium effort plans and decides; Opus 5.5 rejects sampling settings and cannot turn thinking off, and LangChain's wrapper sends neither. Server-side fallbacks are on, so a request a safety classifier declines is retried on a fallback model instead of failing. Subagents run on Muse Spark 1.3 through Meta's OpenAI-compatible endpoint (`https://api.meta.ai/v1`), or on Claude Haiku 5.5.
