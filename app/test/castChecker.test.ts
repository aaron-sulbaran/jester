// Run from app/: npm test. The cast checker's code rules: what it accepts from the model, and when a person looks.
import { test } from "node:test";
import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { ANTHROPIC_API_URL, anthropicModel, castRefusal, CastUsageMeter, checkCast, finalizeCast, missedIn, personIn, recountIn, subagentAnswers, thingIn, type Evidence, type RecordedCast } from "../cast-checker.ts";
import type { CastGuide } from "../castFrames.ts";

/** A guide seen from `from` to `to` seconds of a 10 s stretch at 15 Hz, at one place. */
function guide(label: string, kind: "person" | "thing", from: number, to: number, at = { cx: 0.5, cy: 0.5, w: 0.3, h: 0.6 }): CastGuide {
  const frames = Array.from({ length: 150 }, (_, i) => {
    const tMs = Math.round((i * 1000) / 15);
    return { tMs, box: tMs >= from * 1000 && tMs <= to * 1000 ? at : null };
  });
  return { subject: { kind, label }, range: { startMs: 0, endMs: 10000 }, boxTrack: { source: { width: 576, height: 1024 }, frames } };
}

const recount = (people: number, things: number, missed = "none") => ({ from: "recounter" as const, about: "", text: `people ${people}, things ${things}\nmissed: ${missed}\nThe boxes follow everyone.` });
const fine = (label: string) => ({ from: "person-checker" as const, about: label, text: "one person throughout\nThe same dancer in every crop." });
const real = (label: string) => ({ from: "thing-checker" as const, about: label, text: "one real object\nThe same car throughout." });
const said = (r: Partial<RecordedCast>): RecordedCast => ({ peopleSeen: 1, thingsSeen: 0, subjects: [], missed: [], verdict: "clear", reason: "Matches.", ...r });
/** Evidence that the tools showed every subject's crops and the frames. */
const looked = (guides: CastGuide[]): Evidence => ({
  framesSampled: 12, framesViewed: 1,
  cropsBySubject: Object.fromEntries(guides.map((g) => [g.subject.label, 6])),
  subjectsViewed: guides.map((g) => g.subject.label),
});

test("punching: the computer vision kept one dancer of two, so a person looks", () => {
  const guides = [guide("the person in the clip", "person", 0, 10)];
  const r = finalizeCast(guides, said({ peopleSeen: 2, missed: [{ kind: "person", where: "the dancer on the left", why: "no box" }], verdict: "ask_a_person", reason: "Two dancers." }), [recount(2, 0, "the dancer on the left"), fine("the person in the clip")], looked(guides));
  assert.equal(r.verdict, "ask_a_person");
  assert.equal(r.peopleSeen, 2);
  assert.ok(r.why.some((w) => w.includes("missed someone")));
});

test("a model that says clear with a missed person still asks a person", () => {
  const guides = [guide("the person in the clip", "person", 0, 10)];
  assert.equal(finalizeCast(guides, said({ peopleSeen: 2, verdict: "clear" }), [recount(2, 0), fine("the person in the clip")], looked(guides)).verdict, "ask_a_person");
});

test("a cast that matches, with every check done and shown, is clear", () => {
  const guides = [guide("the person on the left", "person", 0, 10), guide("the person on the right", "person", 0, 10, { cx: 0.8, cy: 0.5, w: 0.3, h: 0.6 })];
  const r = finalizeCast(guides, said({ peopleSeen: 2 }), [recount(2, 0), fine("the person on the left"), fine("the person on the right")], looked(guides));
  assert.equal(r.verdict, "clear");
  assert.deepEqual(r.why, []);
});

test("no recount, a disagreeing or malformed recount, or a recount that names a miss means a person looks", () => {
  const guides = [guide("the person in the clip", "person", 0, 10)];
  const ev = looked(guides), ok = fine("the person in the clip");
  assert.equal(finalizeCast(guides, said({}), [ok], ev).verdict, "ask_a_person");
  assert.equal(finalizeCast(guides, said({}), [recount(2, 0), ok], ev).verdict, "ask_a_person");
  assert.equal(finalizeCast(guides, said({}), [{ from: "recounter", about: "", text: "About two people." }, ok], ev).verdict, "ask_a_person");
  assert.equal(finalizeCast(guides, said({}), [recount(1, 0), { from: "recounter", about: "", text: "garbled" }, ok], ev).verdict, "ask_a_person", "one malformed recount is enough");
  assert.equal(finalizeCast(guides, said({}), [{ from: "recounter", about: "", text: "people 1, things 0\nThe box follows a poster." }, ok], ev).verdict, "ask_a_person", "no missed line");
  assert.equal(finalizeCast(guides, said({}), [recount(1, 0, "the dancer; the box is on a poster"), ok], ev).verdict, "ask_a_person");
  assert.equal(finalizeCast(guides, null, [recount(1, 0), ok], ev).verdict, "ask_a_person");
});

test("every person needs its own person-checker answer, crops, and a tool that showed them", () => {
  const guides = [guide("the person in the clip", "person", 0, 10)];
  const ev = looked(guides);
  assert.equal(finalizeCast(guides, said({}), [recount(1, 0)], ev).verdict, "ask_a_person", "no person-checker answer");
  assert.equal(finalizeCast(guides, said({}), [recount(1, 0), { ...fine("x"), about: "" }], ev).verdict, "ask_a_person", "an answer about no one");
  assert.equal(finalizeCast(guides, said({}), [recount(1, 0), { from: "person-checker", about: "the person in the clip", text: "not one person\nThe box jumps." }], ev).verdict, "ask_a_person");
  assert.equal(finalizeCast(guides, said({}), [recount(1, 0), fine("the person in the clip")], { ...ev, subjectsViewed: [] }).verdict, "ask_a_person", "crops never shown");
  assert.equal(finalizeCast(guides, said({}), [recount(1, 0), fine("the person in the clip")], { ...ev, cropsBySubject: {} }).verdict, "ask_a_person", "never seen at a sample");
  assert.equal(finalizeCast(guides, said({}), [recount(1, 0), fine("the person in the clip")], { ...ev, framesViewed: 0 }).verdict, "ask_a_person", "frames never shown");
  assert.equal(finalizeCast(guides, said({}), [recount(1, 0), fine("the person in the clip")], { ...ev, framesSampled: 0 }).verdict, "ask_a_person", "no frames");
});

test("a person is never dropped, even when a thing shares its label", () => {
  const car = { cx: 0.8, cy: 0.6, w: 0.3, h: 0.2 };
  const guides = [guide("Person 1", "person", 0, 10), guide("Car 1", "thing", 0, 7, car), guide("Car 2", "thing", 6, 10, car)];
  const r = finalizeCast(guides, said({ thingsSeen: 1, subjects: [{ label: "Person 1", action: "drop", reason: "x" }, { label: "Car 2", action: "merge", into: "Car 1", reason: "Same car." }] }), [recount(1, 1), fine("Person 1"), real("Car 1")], looked(guides));
  assert.equal(r.subjects.find((s) => s.label === "Person 1")!.allowed, "keep");
  assert.equal(r.subjects.find((s) => s.label === "Car 2")!.allowed, "merge");
  assert.equal(r.verdict, "ask_a_person", "asking to drop a person sends it to a person");
  const ok = finalizeCast(guides, said({ thingsSeen: 1, subjects: [{ label: "Car 2", action: "merge", into: "Car 1", reason: "Same car." }] }), [recount(1, 1), fine("Person 1"), real("Car 1")], looked(guides));
  assert.equal(ok.verdict, "clear");
  // Codex's case: a person and a briefly seen thing both labelled "X".
  const twins = [guide("X", "person", 0, 10), guide("X", "thing", 0, 1, car), guide("A", "person", 0, 10), guide("B", "person", 0, 10)];
  const t = finalizeCast(twins, said({ peopleSeen: 3, subjects: [{ label: "X", action: "drop", reason: "blip" }] }), [recount(3, 0), fine("X"), fine("A"), fine("B")], looked(twins));
  assert.ok(t.subjects.filter((s) => s.kind === "person").every((s) => s.allowed === "keep"));
  assert.equal(t.verdict, "ask_a_person", "two subjects share a label");
});

test("every kept thing needs its own thing-checker answer of one real object", () => {
  const guides = [guide("Person 1", "person", 0, 10), guide("Car 1", "thing", 0, 10, { cx: 0.8, cy: 0.6, w: 0.3, h: 0.2 })];
  const base = [recount(1, 1), fine("Person 1")];
  assert.equal(finalizeCast(guides, said({ thingsSeen: 1 }), [...base, real("Car 1")], looked(guides)).verdict, "clear");
  assert.equal(finalizeCast(guides, said({ thingsSeen: 1 }), base, looked(guides)).verdict, "ask_a_person", "no thing-checker answer");
  assert.equal(finalizeCast(guides, said({ thingsSeen: 1 }), [...base, { from: "thing-checker", about: "Car 1", text: "changes\nA different car each time." }], looked(guides)).verdict, "ask_a_person");
  assert.equal(finalizeCast(guides, said({ thingsSeen: 1, subjects: [{ label: "Car 1", action: "keep", changes: true, reason: "x" }] }), [...base, real("Car 1")], looked(guides)).verdict, "ask_a_person");
  const far = [guide("Person 1", "person", 0, 10), guide("Car 1", "thing", 0, 7, { cx: 0.8, cy: 0.6, w: 0.3, h: 0.2 }), guide("Car 2", "thing", 6, 10, { cx: 0.1, cy: 0.6, w: 0.3, h: 0.2 })];
  const r = finalizeCast(far, said({ thingsSeen: 1, subjects: [{ label: "Car 2", action: "merge", into: "Car 1", reason: "Same car." }] }), [recount(1, 1), fine("Person 1"), real("Car 1"), real("Car 2")], looked(far));
  assert.equal(r.subjects.find((s) => s.label === "Car 2")!.allowed, "keep", "not at the same place");
  assert.equal(r.verdict, "ask_a_person");
});

test("answer parsers read only the agreed form", () => {
  assert.deepEqual(recountIn("people 2, things 0\nmissed: the left dancer"), { people: 2, things: 0 });
  assert.deepEqual(recountIn("**People: 3; things: 1**"), { people: 3, things: 1 });
  assert.equal(recountIn("I count two people."), null);
  assert.equal(missedIn("people 1, things 0\nmissed: none"), "none");
  assert.equal(missedIn("people 1, things 0\n**Missed: None.**"), "none");
  assert.equal(missedIn("people 2, things 0\nmissed: the dancer on the left, 0 to 10 s"), "the dancer on the left, 0 to 10 s");
  assert.equal(missedIn("people 1, things 0\nThe boxes miss no one."), null);
  assert.equal(personIn("One person throughout."), "one person throughout");
  assert.equal(personIn("Not \"one person throughout\": unsure"), null);
  assert.equal(thingIn("changes\nA different car each time."), "changes");
});

test("subagentAnswers: matched by tool call, with the label the request named", () => {
  const messages = [
    { tool_calls: [
      { id: "a", name: "task", args: { subagent_type: "thing-checker", description: "Check the thing labelled Car 11." } },
      { id: "b", name: "task", args: { subagent_type: "recounter", description: "Count everyone" } },
      { id: "c", name: "task", args: { subagent_type: "general-purpose", description: "Person 1" } },
    ] },
    { tool_call_id: "a", content: "one real object" },
    { tool_call_id: "b", content: [{ type: "text", text: "people 1, things 0" }] },
    { tool_call_id: "c", content: "people 9, things 9" },
  ];
  const answers = subagentAnswers(messages, ["Person 1", "Car 1", "Car 11"]);
  assert.deepEqual(answers.map((a) => [a.from, a.about]), [["thing-checker", "Car 11"], ["recounter", ""]], "Car 11 is not read as Car 1, and the general-purpose reply is not counted");
});

test("checkCast is refused under every LangChain tracing switch, before anything is loaded or sent", async () => {
  const guides = [guide("Person 1", "person", 0, 10)];
  const frames = { id: "x", video: "/nowhere/clip.mp4", width: 576, height: 1024, times: [], boxed: [], subjects: [], flags: [] };
  for (const k of ["LANGSMITH_TRACING", "LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING_V2", "LANGCHAIN_TRACING"]) {
    const before = process.env[k];
    process.env[k] = "true";
    try {
      await assert.rejects(checkCast(guides, frames, { apiKey: "unused" }), /Tracing to LangSmith is on/, k);
    } finally {
      if (before === undefined) delete process.env[k]; else process.env[k] = before;
    }
  }
});

test("castRefusal: only its own meter as a callback, and never inside another LangChain run", async () => {
  assert.equal(await castRefusal({}, {}), null);
  assert.equal(await castRefusal({ meter: new CastUsageMeter() }, {}), null);
  class Exporter extends BaseCallbackHandler { name = "cast-usage-meter"; }
  assert.match((await castRefusal({ meter: new Exporter() as never }, {}))!, /no callback but its own usage meter/);
  // As LangChain does on Node once a runnable or traceable has loaded.
  AsyncLocalStorageProviderSingleton.initializeGlobalInstance(new AsyncLocalStorage());
  assert.equal(await castRefusal({}, {}), null, "at the top level, outside any run");
  const inside = await AsyncLocalStorageProviderSingleton.runWithConfig({}, () => castRefusal({}, {}));
  assert.match(inside!, /inside another LangChain or LangSmith run/);
});

test("the model is pinned to Anthropic's API, whatever the environment says", async () => {
  const before = { gw: process.env.LANGSMITH_GATEWAY, base: process.env.ANTHROPIC_BASE_URL };
  process.env.LANGSMITH_GATEWAY = "true";
  process.env.ANTHROPIC_BASE_URL = "https://example.invalid";
  try {
    const m = await anthropicModel("unused");
    assert.equal((m as unknown as { apiUrl?: string }).apiUrl, ANTHROPIC_API_URL);
  } finally {
    if (before.gw === undefined) delete process.env.LANGSMITH_GATEWAY; else process.env.LANGSMITH_GATEWAY = before.gw;
    if (before.base === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = before.base;
  }
});
