// Run from app/: npm test. The Chamberlain's case files, written by the dev server for the eval.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bankAround, casesDirFor, checkoutAround, inputId, saveJudged, saveOutcome, type ChamberlainCase } from "../review-cases.ts";
import type { Decision, ReviewInput } from "../review-agent.ts";

const ROW = "0b5f3c2e-1d4a-4c8e-9f00-123456789abc";
const input: ReviewInput = {
  title: "jumping jacks",
  credit: "Sam",
  facts: { error: null, durationMs: 8000, subjects: [{ label: "Person 1", kind: "person", seenShare: 0.95, pace: "steady" }], skipped: [], warnings: [] },
  frames: ["data:image/jpeg;base64,AAAA", "data:image/jpeg;base64,BBBB"],
};
const decision: Decision = {
  verdict: "approve", reason: "Fine.", nameCheck: "fits", nameKind: "describes_clip", nameNote: "", framesCheck: "A person.",
  contentCheck: "clean", steering: false, playability: "plays well", precedent: "", findings: [], steps: ["Plan"],
};
const fresh = () => join(mkdtempSync(join(tmpdir(), "chamberlain-cases-")), "chamberlain-cases");
const read = (dir: string, id: string) => JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as ChamberlainCase;

test("the cases folder sits beside the env file", () => {
  assert.equal(casesDirFor("/a/jester-deploy/.env.review"), "/a/jester-deploy/chamberlain-cases");
  assert.equal(casesDirFor(undefined), undefined);
});

test("a judged clip is saved with its exact input, owner-only", () => {
  const dir = fresh();
  const saved = saveJudged(dir, { id: ROW, videoPath: `${ROW}.mp4`, model: "m", prompt: "p1", input, decision });
  assert.equal(saved.error, null);
  const c = read(dir, ROW);
  assert.deepEqual(c.input, input);
  assert.equal(c.decision?.verdict, "approve");
  assert.equal(c.outcome, null);
  assert.equal(c.prompt, "p1");
  assert.equal(statSync(join(dir, `${ROW}.json`)).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("the outcome is added later, and a second judge keeps it and the hand label", () => {
  const dir = fresh();
  saveJudged(dir, { id: ROW, videoPath: null, model: "m", prompt: "p1", input, decision });
  const added = saveOutcome(dir, ROW, { status: "approved", by: "aaron", title: "Jumping jacks", reason: "Let in by hand.", bankId: "jumping-jacks" });
  assert.deepEqual(added, { data: true, error: null });
  const path = join(dir, `${ROW}.json`);
  writeFileSync(path, JSON.stringify({ ...read(dir, ROW), label: { want: "approve" } }));
  saveJudged(dir, { id: ROW, videoPath: null, model: "m", prompt: "p2", input, decision: null, error: "timeout" });
  const c = read(dir, ROW);
  assert.equal(c.outcome?.by, "aaron");
  assert.equal(c.outcome?.title, "Jumping jacks");
  assert.equal(c.label?.want, "approve");
  assert.equal(c.decision, null);
  assert.equal(c.error, "timeout");
  assert.equal(c.prompt, "p2");
});

test("an outcome for a clip that was never judged changes nothing", () => {
  const dir = fresh();
  assert.deepEqual(saveOutcome(dir, ROW, { status: "rejected", by: "check", title: null, reason: "No person found." }), { data: false, error: null });
  assert.deepEqual(saveOutcome(undefined, ROW, { status: "rejected", by: "check", title: null, reason: "" }), { data: false, error: null });
});

test("no submission id: a stable id from the input, and no path tricks", () => {
  const dir = fresh();
  const saved = saveJudged(dir, { id: null, videoPath: null, model: "m", prompt: "p", input, decision });
  assert.equal(saved.error, null);
  assert.match(inputId(input), /^x-[0-9a-f]{16}$/);
  assert.equal(read(dir, inputId(input)).id, inputId(input));
  assert.notEqual(saveJudged(dir, { id: "../escape", videoPath: null, model: "m", prompt: "p", input, decision }).error, null);
  assert.notEqual(saveJudged(undefined, { id: ROW, videoPath: null, model: "m", prompt: "p", input, decision }).error, null);
});

test("nothing is saved inside a git checkout, however deep", () => {
  const repo = mkdtempSync(join(tmpdir(), "chamberlain-repo-"));
  mkdirSync(join(repo, ".git"));
  const dir = join(repo, "app", "public", "chamberlain-cases");
  assert.ok(checkoutAround(dir));
  const saved = saveJudged(dir, { id: ROW, videoPath: null, model: "m", prompt: "p", input, decision });
  assert.match(saved.error ?? "", /inside the git checkout/);
  assert.equal(existsSync(dir), false);
  assert.equal(checkoutAround(fresh()), null);
});

test("an outcome never trusts the id written inside the file", () => {
  const dir = fresh();
  saveJudged(dir, { id: ROW, videoPath: null, model: "m", prompt: "p", input, decision });
  writeFileSync(join(dir, `${ROW}.json`), JSON.stringify({ ...read(dir, ROW), id: "../escaped" }));
  const added = saveOutcome(dir, ROW, { status: "rejected", by: "aaron", title: null, reason: "" });
  assert.equal(added.data, null);
  assert.equal(existsSync(join(dir, "..", "escaped.json")), false);
});

test("writes leave no temporary files behind", () => {
  const dir = fresh();
  saveJudged(dir, { id: ROW, videoPath: null, model: "m", prompt: "p", input, decision });
  saveOutcome(dir, ROW, { status: "approved", by: "aaron", title: "jumping jacks", reason: "" });
  assert.deepEqual(readdirSync(dir), [`${ROW}.json`]);
});

test("nothing is saved inside a bank folder: the one the dev server serves, or any folder with a bank index", () => {
  const root = mkdtempSync(join(tmpdir(), "chamberlain-bank-"));
  const bank = join(root, "bank");
  mkdirSync(bank);
  // The served bank folder, given by the dev server, with no index yet.
  const inServed = join(bank, "chamberlain-cases");
  assert.match(saveJudged(inServed, { id: ROW, videoPath: null, model: "m", prompt: "p", input, decision }, bank).error ?? "", /inside the bank folder/);
  assert.match(saveOutcome(inServed, ROW, { status: "rejected", by: "aaron", title: null, reason: "" }, bank).error ?? "", /inside the bank folder/);
  // Any folder holding a bank index, with no bank folder given.
  writeFileSync(join(bank, "index.json"), JSON.stringify({ schema: "bank/1", clips: [] }));
  const deep = join(bank, "some", "chamberlain-cases");
  assert.equal(bankAround(deep), bankAround(bank));
  assert.match(saveJudged(deep, { id: ROW, videoPath: null, model: "m", prompt: "p", input, decision }).error ?? "", /inside the bank folder/);
  assert.equal(existsSync(inServed) || existsSync(deep), false);
  // Beside the bank, as jester-deploy/ lays it out, is fine.
  const beside = join(root, "chamberlain-cases");
  assert.equal(saveJudged(beside, { id: ROW, videoPath: null, model: "m", prompt: "p", input, decision }, bank).error, null);
});
