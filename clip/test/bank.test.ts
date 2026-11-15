import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bankEntry, emptyBankIndex, guidesJson, readBankIndex, resolveBankPath, slugFor, withClip, withoutClip,
} from "../../app/src/bankIndex.ts";

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: "Dog fetch", credit: "Someone, CC BY 3.0", durationMs: 8000, people: 1, things: 1,
  video: `${id}/clip.webm`, poster: `${id}/poster.jpg`, guides: `${id}/guides.json`, ...extra,
});

test("readBankIndex: reads a bank/1 index", () => {
  const read = readBankIndex({ schema: "bank/1", clips: [entry("dog-fetch")] });
  assert.equal(read.error, null);
  assert.deepEqual(read.data, [entry("dog-fetch")]);
});

test("readBankIndex: refuses anything that is not a bank/1 index", () => {
  for (const json of [null, [], "x", { schema: "bank/2", clips: [] }, { schema: "bank/1" }, { schema: "bank/1", clips: {} }]) {
    assert.equal(readBankIndex(json).error, "That is not a clip bank index.");
  }
});

test("readBankIndex: leaves out malformed entries and keeps the rest", () => {
  const clips = [
    entry("ok"),
    entry("Bad Id"),
    entry("no-title", { title: "  " }),
    entry("no-one", { people: 0, things: 0 }),
    entry("neg", { durationMs: -1 }),
    entry("frac", { people: 1.5 }),
    entry("escape", { video: "../secret.mp4" }),
    entry("elsewhere", { video: "https://example.com/x.mp4" }),
    entry("other-folder", { guides: "ok/guides.json" }),
    { id: "partial" },
    "nonsense",
    entry("ok", { title: "Second with the same id" }),
  ];
  const read = readBankIndex({ schema: "bank/1", clips });
  assert.deepEqual(read.data?.map((c) => c.id), ["ok"]);
  assert.equal(read.data?.[0]?.title, "Dog fetch");
});

test("resolveBankPath: works with and without a trailing slash", () => {
  assert.equal(resolveBankPath("https://jester-pi.vercel.app/bank", "a/clip.mp4"), "https://jester-pi.vercel.app/bank/a/clip.mp4");
  assert.equal(resolveBankPath("http://localhost:5178/bank/", "index.json"), "http://localhost:5178/bank/index.json");
});

test("slugFor: short lowercase slugs, unique against those taken", () => {
  assert.equal(slugFor("Dog Fetches Stick!", []), "dog-fetches-stick");
  assert.equal(slugFor("Café  crème", []), "cafe-creme");
  assert.equal(slugFor("!!!", []), "clip");
  assert.equal(slugFor("Dog fetch", ["dog-fetch", "dog-fetch-2"]), "dog-fetch-3");
  const long = slugFor("a very long title that goes on and on and on forever", []);
  assert.ok(long.length <= 32 && !long.endsWith("-"), long);
  // Every slug it makes is one the index accepts.
  for (const title of ["Dog Fetches Stick!", "Café  crème", "!!!", "a very long title that goes on and on and on forever"]) {
    const id = slugFor(title, ["dog-fetch"]);
    assert.equal(readBankIndex({ schema: "bank/1", clips: [entry(id)] }).data?.length, 1, id);
  }
});

test("withClip and withoutClip: add, replace in place, remove", () => {
  const a = bankEntry({ id: "a", title: "A", credit: "", durationMs: 1000, people: 1, things: 0 }, "mp4");
  assert.equal(a.video, "a/clip.mp4");
  assert.equal(a.poster, "a/poster.jpg");
  assert.equal(a.guides, "a/guides.json");
  const b = bankEntry({ id: "b", title: "B", credit: "", durationMs: 1000, people: 0, things: 1 }, "webm");
  let index = withClip(withClip(emptyBankIndex(), a), b);
  assert.deepEqual(index.clips.map((c) => c.id), ["a", "b"]);
  index = withClip(index, { ...a, title: "A again" });
  assert.deepEqual(index.clips.map((c) => c.title), ["A again", "B"]);
  index = withoutClip(index, "a");
  assert.deepEqual(index.clips.map((c) => c.id), ["b"]);
  assert.equal(readBankIndex(index).data?.length, 1);
});

test("guidesJson: keeps whole numbers, rounds the rest to 4 decimals", () => {
  assert.equal(guidesJson([{ tMs: 66.66666666, x: 0.123456789, n: 15, s: "guide/1" }]), '[{"tMs":66.6667,"x":0.1235,"n":15,"s":"guide/1"}]');
});
