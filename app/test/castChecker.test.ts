// Run from app/: npm test. The cast checker's code rules: what it accepts from the model, and when a person looks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCast, finalizeCast, personIn, recountIn, subagentAnswers, thingIn, type RecordedCast } from "../cast-checker.ts";
import type { CastGuide } from "../castFrames.ts";

/** A guide seen from `from` to `to` seconds of a 10 s stretch at 15 Hz, at one place. */
function guide(label: string, kind: "person" | "thing", from: number, to: number, at = { cx: 0.5, cy: 0.5, w: 0.3, h: 0.6 }): CastGuide {
  const frames = Array.from({ length: 150 }, (_, i) => {
    const tMs = Math.round((i * 1000) / 15);
    return { tMs, box: tMs >= from * 1000 && tMs <= to * 1000 ? at : null };
  });
  return { subject: { kind, label }, range: { startMs: 0, endMs: 10000 }, boxTrack: { source: { width: 576, height: 1024 }, frames } };
}

const recount = (people: number, things: number) => ({ from: "recounter" as const, about: "", text: `people ${people}, things ${things}\nThe boxes miss no one.` });
const fine = (label: string) => ({ from: "person-checker" as const, about: label, text: "one person throughout\nThe same dancer in every crop." });
const said = (r: Partial<RecordedCast>): RecordedCast => ({ peopleSeen: 1, thingsSeen: 0, subjects: [], missed: [], verdict: "clear", reason: "Matches.", ...r });

test("punching: the computer vision kept one dancer of two, so a person looks", () => {
  const guides = [guide("the person in the clip", "person", 0, 10)];
  const r = finalizeCast(guides, said({ peopleSeen: 2, missed: [{ kind: "person", where: "the dancer on the left", why: "no box" }], verdict: "ask_a_person", reason: "Two dancers." }), [recount(2, 0), fine("the person in the clip")]);
  assert.equal(r.verdict, "ask_a_person");
  assert.equal(r.peopleSeen, 2);
  assert.ok(r.why.some((w) => w.includes("missed someone")));
});

test("a model that says clear with a missed person still asks a person", () => {
  const guides = [guide("the person in the clip", "person", 0, 10)];
  const r = finalizeCast(guides, said({ peopleSeen: 2, verdict: "clear" }), [recount(2, 0)]);
  assert.equal(r.verdict, "ask_a_person");
});

test("a cast that matches, checked by the recounter and the person checker, is clear", () => {
  const guides = [guide("the person on the left", "person", 0, 10), guide("the person on the right", "person", 0, 10, { cx: 0.8, cy: 0.5, w: 0.3, h: 0.6 })];
  const r = finalizeCast(guides, said({ peopleSeen: 2 }), [recount(2, 0), fine("the person on the left"), fine("the person on the right")]);
  assert.equal(r.verdict, "clear");
  assert.deepEqual(r.why, []);
});

test("no recount, a recount that disagrees, or a doubtful person checker means a person looks", () => {
  const guides = [guide("the person in the clip", "person", 0, 10)];
  assert.equal(finalizeCast(guides, said({}), []).verdict, "ask_a_person");
  assert.equal(finalizeCast(guides, said({}), [recount(2, 0)]).verdict, "ask_a_person");
  assert.equal(finalizeCast(guides, said({}), [{ from: "recounter", about: "", text: "About two people." }]).verdict, "ask_a_person");
  assert.equal(finalizeCast(guides, said({}), [recount(1, 0), { from: "person-checker", about: "the person in the clip", text: "not one person\nThe box jumps." }]).verdict, "ask_a_person");
  assert.equal(finalizeCast(guides, null, [recount(1, 0)]).verdict, "ask_a_person");
});

test("a person is never dropped; a duplicate thing at the same place is merged", () => {
  const car = { cx: 0.8, cy: 0.6, w: 0.3, h: 0.2 };
  const guides = [guide("Person 1", "person", 0, 10), guide("Car 1", "thing", 0, 7, car), guide("Car 2", "thing", 6, 10, car)];
  const r = finalizeCast(guides, said({ thingsSeen: 1, subjects: [{ label: "Person 1", action: "drop", reason: "x" }, { label: "Car 2", action: "merge", into: "Car 1", reason: "Same car." }] }), [recount(1, 1), fine("Person 1")]);
  assert.equal(r.subjects.find((s) => s.label === "Person 1")!.allowed, "keep");
  assert.equal(r.subjects.find((s) => s.label === "Car 2")!.allowed, "merge");
  assert.equal(r.verdict, "ask_a_person", "asking to drop a person sends it to a person");
  const ok = finalizeCast(guides, said({ thingsSeen: 1, subjects: [{ label: "Car 2", action: "merge", into: "Car 1", reason: "Same car." }] }), [recount(1, 1), fine("Person 1")]);
  assert.equal(ok.verdict, "clear");
});

test("a merge of a thing somewhere else, or a kept thing that changes, is refused", () => {
  const guides = [guide("Person 1", "person", 0, 10), guide("Car 1", "thing", 0, 7, { cx: 0.8, cy: 0.6, w: 0.3, h: 0.2 }), guide("Car 2", "thing", 6, 10, { cx: 0.1, cy: 0.6, w: 0.3, h: 0.2 })];
  const far = finalizeCast(guides, said({ thingsSeen: 1, subjects: [{ label: "Car 2", action: "merge", into: "Car 1", reason: "Same car." }] }), [recount(1, 1), fine("Person 1")]);
  assert.equal(far.subjects.find((s) => s.label === "Car 2")!.allowed, "keep");
  assert.equal(far.verdict, "ask_a_person");
  const changes = finalizeCast(guides, said({ thingsSeen: 2, subjects: [{ label: "Car 1", action: "keep", changes: true, reason: "Different cars park here." }] }), [recount(1, 2), fine("Person 1")]);
  assert.equal(changes.verdict, "ask_a_person");
});

test("answer parsers read only the first line in the agreed form", () => {
  assert.deepEqual(recountIn("people 2, things 0\nThe left dancer has no box."), { people: 2, things: 0 });
  assert.deepEqual(recountIn("**People: 3; things: 1**"), { people: 3, things: 1 });
  assert.equal(recountIn("I count two people."), null);
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
    { tool_call_id: "a", content: "one person throughout" },
    { tool_call_id: "b", content: [{ type: "text", text: "people 1, things 0" }] },
    { tool_call_id: "c", content: "people 9, things 9" },
  ];
  const answers = subagentAnswers(messages, ["Person 1", "Car 1", "Car 11"]);
  assert.deepEqual(answers.map((a) => [a.from, a.about]), [["thing-checker", "Car 11"], ["recounter", ""]], "Car 11 is not read as Car 1, and the general-purpose reply is not counted");
});

test("checkCast: refused while LangChain tracing is on, before anything is loaded or sent", async () => {
  const guides = [guide("Person 1", "person", 0, 10)];
  const frames = { id: "x", video: "/nowhere/clip.mp4", width: 576, height: 1024, times: [], boxed: [], subjects: [], flags: [] };
  for (const k of ["LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2"]) {
    const before = process.env[k];
    process.env[k] = "true";
    try {
      await assert.rejects(checkCast(guides, frames, { apiKey: "unused" }), /Tracing to LangSmith is on/);
    } finally {
      if (before === undefined) delete process.env[k]; else process.env[k] = before;
    }
  }
  const tracer = { name: "langchain_tracer" };
  await assert.rejects(checkCast(guides, frames, { apiKey: "unused", callbacks: [tracer as never] }), /Tracing to LangSmith is on/);
});
