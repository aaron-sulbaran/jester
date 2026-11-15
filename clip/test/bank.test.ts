import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bankEntry, bankIdFor, cleanText, emptyBankIndex, guidesJson, readBankIndex, resolveBankPath, slugFor, withClip, withoutClip,
} from "../../app/src/bankIndex.ts";
import { escapeHtml } from "../../app/src/escape.ts";

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

test("cleanText: strips control and direction characters, collapses spaces, trims, caps the length", () => {
  assert.equal(cleanText("  The\u0000 Dougie\n\t ", 80), "The Dougie");
  assert.equal(cleanText("abc\u202Edef\u200B", 80), "abc def");
  assert.equal(cleanText("x".repeat(100), 80).length, 80);
  assert.equal(cleanText("   ", 80), "");
});

test("a title with markup is stored and listed as plain text, and escapes wherever HTML is built", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const entry = bankEntry({ id: "the-dougie-9c23e4", title: ` ${evil}\u0007 `, credit: "<b>Lisa</b>", durationMs: 8200, people: 1, things: 0 }, "mp4");
  assert.equal(entry.title, evil);          // kept as the literal text it is: never parsed or decoded
  assert.equal(entry.credit, "<b>Lisa</b>");
  const listed = readBankIndex(withClip(emptyBankIndex(), entry)).data![0]!;
  assert.equal(listed.title, evil);
  // The clip cards and the desk use textContent; the room list and duel lab build HTML with escapeHtml.
  assert.equal(escapeHtml(listed.title), "&lt;img src=x onerror=alert(1)&gt;");
  assert.ok(!escapeHtml(listed.credit).includes("<"));
});

test("bankIdFor: a plain slug from the title plus a short fingerprint, unique and accepted by the index", () => {
  const fp = "9c23e4027445aee3" + "0".repeat(48);
  assert.equal(bankIdFor("The Dougie!", fp, []), "the-dougie-9c23e4");
  assert.equal(bankIdFor("The Dougie!", fp, ["the-dougie-9c23e4"]), "the-dougie-9c23e402");
  assert.equal(bankIdFor("<img src=x onerror=alert(1)>", fp, []), "img-src-x-onerror-alert-1-9c23e4");
  assert.equal(bankIdFor("!!!", fp, []), "clip-9c23e4");
  const long = bankIdFor("a very long dance name that goes on and on and on", fp, []);
  assert.ok(long.length <= 40, long);
  for (const id of [long, bankIdFor("The Dougie!", fp, []), bankIdFor("!!!", fp, [])]) {
    assert.equal(readBankIndex({ schema: "bank/1", clips: [entry(id)] }).data?.length, 1, id);
  }
});
