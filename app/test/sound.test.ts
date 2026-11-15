// The game's sound switch (sfx.ts): read from and written to localStorage as jester.sound. Run from app/: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>([["jester.sound", "off"]]);
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } },
});
const { soundOn, setSound } = await import("../src/sfx.ts");

test("the switch starts from what this browser remembered", () => {
  assert.equal(soundOn(), false);
});

test("setSound turns it on and off and remembers", () => {
  setSound(true);
  assert.equal(soundOn(), true);
  assert.equal(store.get("jester.sound"), "on");
  setSound(false);
  assert.equal(soundOn(), false);
  assert.equal(store.get("jester.sound"), "off");
});
