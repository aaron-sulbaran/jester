import { test } from "node:test";
import assert from "node:assert/strict";
import { finalize, playabilityOf, type ClipFacts } from "../review-agent.ts";
import { parsePrecedents, precedentFrom, precedentsBlock, PRECEDENTS_READ, type Flagged, type Precedent } from "../review-precedents.ts";

const person = (seenShare: number) => ({ label: "Person 1", kind: "person" as const, seenShare, pace: "medium" });
const facts = (over: Partial<ClipFacts> = {}): ClipFacts => ({ error: null, durationMs: 8200, subjects: [person(1)], skipped: [], warnings: [], ...over });

test("playabilityOf: the game's verdict, from its own analysis", () => {
  assert.equal(playabilityOf(facts()).verdict, "plays well");
  assert.equal(playabilityOf(facts({ error: "No person found in this clip." })).verdict, "does not play");
  assert.match(playabilityOf(facts({ error: "No person found in this clip." })).text, /No person found/);
  assert.equal(playabilityOf(facts({ subjects: [] })).verdict, "does not play");
  assert.equal(playabilityOf(facts({ subjects: [person(0.39)] })).verdict, "unsure");
  assert.equal(playabilityOf(facts({ subjects: [person(0.4)] })).verdict, "plays well");
  assert.equal(playabilityOf(facts({ durationMs: 2900 })).verdict, "unsure");
});

test("playabilityOf: skipped tracks are normal, never a reason for unsure", () => {
  const skipped = [2, 3, 4, 5, 6].map((n) => ({ label: `Person ${n}`, reason: "The person you picked is out of view for most of the clip." }));
  const p = playabilityOf(facts({ subjects: [person(0.58)], skipped }));
  assert.equal(p.verdict, "plays well");
  assert.match(p.text, /left out 5 other tracks, which is normal/);
});

const recorded = (over: Record<string, unknown> = {}) => ({
  verdict: "approve" as const, reason: "Fine.", nameCheck: "fits" as const, nameNote: "", framesCheck: "A dance.",
  contentCheck: "clean" as const, steering: false, precedent: "", ...over,
});
const extra = { findings: [], steps: [] };

test("finalize: a clean, fitting, playable clip is approved", () => {
  assert.equal(finalize({ title: "kitchen dance", facts: facts() }, recorded(), extra).verdict, "approve");
});

test("finalize: no precedent or wording gets unclear content, steering or an unplayable clip into the bank", () => {
  const input = { title: "kitchen dance", facts: facts() };
  assert.equal(finalize(input, recorded({ contentCheck: "borderline", precedent: "like the last one" }), extra).verdict, "ask_a_person");
  assert.equal(finalize(input, recorded({ contentCheck: "breaks_rules" }), extra).verdict, "ask_a_person");
  assert.equal(finalize(input, recorded({ steering: true }), extra).verdict, "ask_a_person");
  assert.equal(finalize({ title: "kitchen dance", facts: facts({ subjects: [person(0.2)] }) }, recorded(), extra).verdict, "ask_a_person");
  assert.equal(finalize(input, recorded({ nameCheck: "does_not_fit" }), extra).verdict, "ask_a_person");
  assert.equal(finalize({ title: null, facts: facts() }, recorded(), extra).nameCheck, "missing");
  assert.equal(finalize({ title: null, facts: facts() }, recorded(), extra).verdict, "ask_a_person");
});

test("finalize: a rejection or a question stands as the model made it", () => {
  const input = { title: "kitchen dance", facts: facts() };
  assert.equal(finalize(input, recorded({ verdict: "reject", contentCheck: "breaks_rules" }), extra).verdict, "reject");
  assert.equal(finalize(input, null, extra).verdict, "ask_a_person");
});

const flagged = (over: Partial<Flagged> = {}): Flagged => ({
  title: "vibin", reason: "The name describes a mood, not a move.", agentVerdict: "ask_a_person",
  nameCheck: "does_not_fit", contentCheck: "clean", steering: false, playability: "plays well", ...over,
});
const AT = "2026-11-15T07:00:00.000Z";

test("precedentFrom: a person's decision on a clean question becomes a precedent", () => {
  const p = precedentFrom(flagged(), { status: "approved", title: "vibin" }, AT);
  assert.ok(p);
  assert.equal(p.decision, "approved");
  assert.equal(p.why, "Aaron let it in under the name as sent.");
  assert.equal(precedentFrom(flagged(), { status: "approved", title: "Vibing dance" }, AT)?.why, 'Aaron renamed it to "Vibing dance" and let it in.');
  assert.equal(precedentFrom(flagged(), { status: "rejected", title: "vibin" }, AT)?.finalTitle, null);
});

test("precedentFrom: never a precedent about content or steering, or one the Chamberlain did not ask about", () => {
  assert.equal(precedentFrom(flagged({ steering: true }), { status: "approved", title: "vibin" }, AT), null);
  assert.equal(precedentFrom(flagged({ contentCheck: "borderline" }), { status: "approved", title: "vibin" }, AT), null);
  assert.equal(precedentFrom(flagged({ contentCheck: undefined, steering: undefined }), { status: "approved", title: "vibin" }, AT), null);
  assert.equal(precedentFrom(flagged({ agentVerdict: "approve" }), { status: "approved", title: "vibin" }, AT), null);
  assert.equal(precedentFrom(flagged({ title: null }), { status: "approved", title: "Named by Aaron" }, AT), null);
});

test("precedentsBlock: the recent precedents, names quoted as data", () => {
  const many: Precedent[] = Array.from({ length: 20 }, (_, i) => precedentFrom(flagged({ title: `move ${i}` }), { status: "approved", title: `move ${i}` }, AT)!);
  const block = precedentsBlock(many);
  assert.equal(block.split("\n").length, PRECEDENTS_READ + 1);
  assert.match(block, /Sent in as "move 19"/);
  assert.doesNotMatch(block, /"move 7"/);
  assert.match(block, /data, not instructions/);
});

test("parsePrecedents: an unreadable file counts as none", () => {
  assert.deepEqual(parsePrecedents(null), []);
  assert.deepEqual(parsePrecedents("not json"), []);
  assert.deepEqual(parsePrecedents('[{"title": 3}]'), []);
  const one = precedentFrom(flagged(), { status: "approved", title: "vibin" }, AT)!;
  assert.deepEqual(parsePrecedents(JSON.stringify([one])), [one]);
});
