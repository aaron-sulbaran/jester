// The referee coach's tools. Each one runs the real, deterministic scorer through eval/src; none of them asks a
// model for a number, and none writes to the repo. Raw pose data never reaches the model.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { SCORER_VERSION } from "../../engine/src/index.ts";
import { clipName, judge, rescore, type Rescored } from "../../eval/src/judge.ts";
import { deriveAll } from "../../eval/src/derive.ts";
import { isFrozen, loadCases, loadDataRounds } from "../../eval/src/store.ts";

/** Every frozen case and local round re-scored now, with its expectation, plus every derived case. */
export function evalSummary() {
  const frozen = loadCases().rounds;
  const local = loadDataRounds().rounds.filter((r) => !isFrozen(r.id));
  const items: Rescored[] = [...frozen, ...local].map((record) => ({ record, now: rescore(record), was: record.result.score }));
  const rounds = items.map((it) => {
    const v = judge(it, items);
    return {
      id: it.record.id,
      frozenCase: isFrozen(it.record.id),
      clip: clipName(it.record),
      mode: it.record.mode,
      channel: it.record.channel,
      tag: it.record.tag,
      scoreWhenPlayed: it.was,
      scoreNow: it.now.score,
      lagMs: Math.round(it.now.lagMs),
      expectation: v?.expectation ?? null,
      holds: v?.holds ?? null,
      detail: v?.detail ?? null,
    };
  });
  const derived = deriveAll(items).map((d) => ({
    id: d.id,
    transform: d.transform,
    clip: clipName(d.record),
    sourceScore: d.source.now.score,
    scoreNow: d.now.score,
    expectation: d.verdict.expectation,
    holds: d.verdict.holds,
    detail: d.verdict.detail,
  }));
  return {
    scorerVersion: SCORER_VERSION,
    roundCount: rounds.length,
    rounds,
    derived,
    notHolding: [...rounds.filter((r) => r.holds === false).map((r) => r.id), ...derived.filter((d) => d.holds === false).map((d) => d.id)],
  };
}

export const evalSummaryTool = tool(async () => JSON.stringify(evalSummary()), {
  name: "eval_summary",
  description:
    "Re-scores every recorded Jester round with the current scorer and returns, as JSON: each round (clip, mode, tag, score when played, score now, lag, expectation, whether it holds), every derived case (late, frozen, seated, walked-out, jittered and mirrored copies of good rounds, with whether each expectation holds), and the ids that do not hold. Deterministic: the same code and rounds always give the same answer.",
  schema: z.object({}),
});
