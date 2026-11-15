# Jester testing, round two: derived test cases and a deep agent that referees the referee

Written Saturday 11:35 PM Eastern for Aaron. Research sources at the end. Nothing here is built yet.

## The short version

Keep the scorer and the replay as the only source of numbers. Add two layers on top:

1. **Derived test cases (no AI, no keys, about 1 hour).** Each real "nailed" round is turned into six transformed copies whose right answer is known: half a second late, frozen still, legs hidden, mirrored, walked out halfway, slightly jittered. One real round becomes seven test cases, so the suite grows without anyone playing more.
2. **A LangChain deep agent, the "referee coach" (about 2 to 2.5 hours, needs three keys).** It plans an investigation of the round log, sends subagents to dig into each failing tag or clip, runs what-if replays of the deterministic scorer to test its ideas, and writes a report for Alex with a proposed constants change that a person must approve. It never scores a round and never edits the engine.

The agent's hard rule is the selling point: the agent proposes, the replay proves. Every number in its report comes from a tool that ran the real scorer.

```
                   +--------------------------------------------+
  rounds played -> | round log (built): exact replay, tags,      |
  (dev + live)     | expectations, ratchet, what-if constants    |
                   +----------------------+---------------------+
                                          |
                   +----------------------v---------------------+
                   | derived cases (new, deterministic):        |
                   | late, frozen, seated, mirrored, walked out,|
                   | jittered copies of each nailed round       |
                   +----------------------+---------------------+
                                          | tools (read-only)
                   +----------------------v---------------------+
                   | referee coach (new, createDeepAgent):      |
                   | plan -> subagents -> what-if replays ->    |
                   | report + proposal (human approves)         |
                   +--------------------------------------------+
```

## What counts as a deep agent

- **The track's rule** (hub `kb/track-deepagents.md`): build the agent with `createDeepAgent` (JS) or `create_deep_agent` (Python). The packet states no other rule. Prize: Nintendo Switch 2.
- **The idea behind it** (LangChain's "Deep Agents" post): Claude Code and deep research agents work because they combine four things, and a deep agent is one that has all four:
  1. a **planning tool** (`write_todos`), even though it does nothing but write a list;
  2. **subagents** (the `task` tool) that go deep on one piece in their own context;
  3. a **file system** as shared scratch space, so big tool output does not flood the context;
  4. a **detailed system prompt**.
- **What does not count, in spirit:** one LLM call, or a plain tool loop with a short prompt. It would pass the letter of the rule and fail the judges' eye.
- **Why this job earns all four for real reasons:** the round log is too big to read in one context (file system), each failing tag or clip is its own investigation (subagents), the investigation is multi-step with experiments (planning), and the domain rules are strict (prompt: never change constants, cite a replay for every claim, Alex owns the engine).
- **Is an agent the right tool at all?** Using the Claude API guide's four checks: the task is open-ended (yes), the outcome is worth a few dollars (yes), models are good at this kind of analysis (yes), and a mistake costs little because the output is a report a person approves (yes).

## What the referee coach does, step by step

1. **Plan.** Reads the eval summary (which expectations fail, which tags have too few rounds, which scores moved) and writes a todo list.
2. **Delegate.** One subagent per question, for example "why did stood-still score 18 on the starter clip?" A subagent pulls the round's per-limb credit, its credit-per-second strip and the guide's motion in the same stretch, and writes a finding to `/findings/<topic>.md`.
3. **Test ideas.** For a suspected constant, the agent calls `replay_with` (the eval's what-if) and gets every case before and after, plus any expectation that would break. It may sweep a few values. Every run is the real scorer.
4. **Check derived cases.** Calls `derive_cases` to make late, frozen, seated and mirrored copies of a nailed round and confirms the relations still hold under the proposal.
5. **Report.** Writes `/reports/<time>.md`: findings, an evidence table built by a tool from replay results (the model does not type numbers), the proposed change, regressions (must be none), and the next five rounds a tester should play to fill gaps.
6. **Propose, gated.** `propose_constants_change` writes a patch file only after a person approves it (`interruptOn`). It never touches `engine/src`; Alex applies it or not.

Tools, all deterministic and read-only on the repo (they wrap `eval/src` directly, no shelling out):

| Tool | Returns |
|---|---|
| `eval_summary` | headline numbers, failing expectations, drifted rounds |
| `list_rounds` | id, clip, mode, tag, score, lag, worst limb (filterable) |
| `get_round` | per-limb credit, 1 s credit strip, tracking gaps; never raw landmarks |
| `replay_with` | constant overrides in, every case's before and after plus broken expectations out |
| `derive_cases` | transformed copies of a round and whether each relation holds |
| `write_evidence_table` | the report's number table, from replay results |
| `propose_constants_change` | a patch file in the workspace, after human approval |

## Models and API calls

| Model | Price per million tokens, in / out | Role here |
|---|---|---|
| Claude Opus 5.5 (`claude-opus-5-5`) | $4 / $20 | **Orchestrator.** Judgment over numbers: is the scorer wrong, the guide wrong, or the player? Most reliable tool use in LangChain, which defaults to Claude. |
| Claude Sonnet 5.5 (`claude-sonnet-5-5`) | $2 / $10 | Orchestrator at half the cost if needed. |
| Muse Spark 1.3 (`muse-spark-1.3`, Meta Model API) | $1.25 / $4.25, on your credits | **Subagents.** Reading-heavy, many calls; prepaid credits make volume free to you. Tool calling and parallel tool calls are supported; 1M context. |
| Claude Haiku 5.5 (`claude-haiku-5-5`) | $0.10 / $0.50 | Subagent fallback if Muse's tool calls misbehave in LangChain. |
| Muse Spark 1.3 contributor | $0.10 / $0.20 | Cheapest, but Meta may train on what you send. Not needed. |

My pick: **Opus 5.5 orchestrator at medium effort, Muse Spark 1.3 subagents, Haiku 5.5 as the subagent fallback.** Not all Muse: Muse reaches LangChain through an OpenAI-compatible layer that has not been tried with deep agents' tool loop, and the orchestrator is where a wrong call costs the most. Not Fable 5.2: twice Opus's price and long turns, which hurt a live demo.

Cost per investigation run, estimated: the orchestrator reads about 300K input tokens and writes about 20K over a run, about $1.60 on Opus before caching (well under $1 with it). Five subagents at about 50K each are about $0.30 on Muse credits. A dozen runs tonight is about $10 to $20 of Claude.

**One thing to confirm:** the Muse Code subscription you use in the terminal ("Max Usage" tier) is a different meter from Meta Model API credits. If the couple hundred dollars is Model API credit (dev.meta.ai), it plugs in. If it is only the subscription, LangChain cannot use it and the subagents go to Haiku 5.5.

How the calls run:

- **Never from the browser.** The agent is a Node command in a new `agent/` folder beside `eval/`, TypeScript like the rest of the repo, importing `eval/src` directly. Keys live in `agent/.env.local` (git-ignored), never in the hub or the app.
- **Claude:** `ChatAnthropic` from `@langchain/anthropic` (it wraps the official Anthropic SDK) with `claude-opus-5-5`.
- **Muse:** `ChatOpenAI` with base URL `https://api.meta.ai/v1`, key `MODEL_API_KEY`, model `muse-spark-1.3`. Meta also offers an Anthropic Messages-compatible endpoint, a second route if the OpenAI one misbehaves.
- **Tracing:** LangSmith (`LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY`, free tier). The trace is the evidence for LangChain's judges.
- **Demo surface:** LangGraph Studio through `npx @langchain/langgraph-cli dev` with a `langgraph.json`. It shows the todo list, subagents and files live with no UI work. The terminal stream is the fallback.

Known API traps to check first, in the spike:

- Opus 5.5 rejects `temperature`, `top_p` and `top_k`, cannot turn thinking off, and returns 400 on a forced tool choice. LangChain's structured output can force a tool, so the orchestrator gets no `responseFormat`.
- deepagents' docs examples use older Claude ids. Use only the ids in the table above.

## Derived test cases

Each transform takes a real round and changes the player's recording in a way whose effect on the score is known. They run inside `npm run eval` (no AI), and the agent can call them too.

| Transform | What it does to the recording | Expectation |
|---|---|---|
| late | shifts every frame 500 ms later | lag within 150 ms of 500, score within 15 of the source |
| frozen | every frame becomes the first frame's pose | 10 or less |
| seated | legs (points 25 to 32) set invisible | 50 or less when the clip uses the legs |
| walked out | no body for the middle 40 percent | no score, or 50 or less |
| jittered | points moved by 2 degrees of noise, fixed seed | within 5 of the source |
| mirrored | left and right swapped | report only (whether it should cost points is Alex's call) |

## Steps, with "done when"

It is 11:35 PM; feature freeze is 4:00 AM. Steps 1 and 2 are independent and can run at the same time.

0. **Keys (Aaron, 10 minutes).** An Anthropic API key, a Meta Model API key (check the credit balance at dev.meta.ai), and a LangSmith key (free account). Put them in `agent/.env.local` yourself; never paste them in chat or the hub.
   *Done when:* the three variable names are set on your laptop.
1. **Derived cases (me, about 1 hour, no keys).** `eval/src/derive.ts` and the six transforms, wired into `npm run eval` for every nailed round, with tests.
   *Done when:* one nailed round shows six derived rows in the report, and the suite still passes.
2. **Spike (me, 30 minutes, needs keys).** Smallest `createDeepAgent`: Opus 5.5 orchestrator, one Muse subagent, one tool (`eval_summary`), LangSmith on.
   *Done when:* one LangSmith trace shows a `write_todos` call, a `task` call answered by Muse, and a tool result, with no 400s. If Muse fails, the subagent moves to Haiku 5.5 and I say so.
3. **Referee coach (me, about 1.5 hours).** All tools above, the system prompt, two subagent types (tag investigator, clip investigator), a disk-backed workspace for `/findings` and `/reports`, the approval gate, and `npm run coach`, which prints cost at the end.
   *Done when:* a run over the current rounds writes a report whose every number appears in a tool result, with at least one subagent and a todo list, for under $3.
4. **Demo (me 20 minutes, then Aaron).** `langgraph.json` and the Studio command, plus a 60-second script for LangChain's table.
   *Done when:* Aaron opens Studio and watches a run end to end.
5. **Alex (optional, after the report).** She reads it and decides whether any proposed constant goes into the engine.

**If time runs short:** step 1 alone is still a real improvement to testing. Steps 1 to 3 qualify for the track. Step 4 makes it visible.

## Risks

- **Time.** About 3.5 hours of agent work landing near the freeze. Everything is in new folders, so it cannot break the demo build.
- **Data.** Two live rounds today. Derived cases and your seven tagged rounds are what give the agent something to reason about.
- **Compatibility.** Opus 5.5's stricter API inside LangChain, and Muse through the OpenAI-compatible layer. The spike tests both before anything else is built.
- **Overclaiming.** The demo must say the agent recommends and a person approves; it does not tune the game by itself tonight.

## Sources

- Hub `kb/track-deepagents.md` (track rule, prize, package names)
- LangChain, "Deep Agents": https://blog.langchain.com/deep-agents
- Deep Agents docs: https://docs.langchain.com/oss/python/deepagents/overview
- deepagents JS source and README (via Context7): https://github.com/langchain-ai/deepagentsjs
- Meta Model API docs (model ids, base URL, tool calling, Messages-compatible endpoint): https://dev.meta.ai/docs/
- Muse Spark 1.3 pricing (third-party, Meta's own page did not load): https://docs.litellm.ai/blog/muse_spark_1_3 and https://anotherwrapper.com/llm-pricing/muse-spark-1.3
- Claude model ids and prices: the Claude API guide bundled with Claude Code, cached November 3, 2026
