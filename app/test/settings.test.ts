// The settings store's pure parts: what is read back from the browser, what is written, and what each setting
// means on a page. Run from app/: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { calmFor, DEFAULTS, developerFor, readSettings, voiceFor, writeSettings } from "../src/settings.ts";

test("nothing stored gives the defaults: sound on, full volume, motion follows the device, no announcer, no developer mode", () => {
  assert.deepEqual(readSettings(null, null), DEFAULTS);
  assert.deepEqual(DEFAULTS, { sound: true, volume: 1, motion: "system", voice: "off", developer: false });
});

test("the old jester.sound switch still decides sound", () => {
  assert.equal(readSettings("off", null).sound, false);
  assert.equal(readSettings("on", null).sound, true);
  assert.equal(writeSettings({ ...DEFAULTS, sound: false }).sound, "off");
});

test("what is written reads back the same", () => {
  const s = { sound: false, volume: 0.35, motion: "calm", voice: "browser", developer: true } as const;
  const out = writeSettings(s);
  assert.deepEqual(readSettings(out.sound, out.json), s);
});

test("broken or out of range values fall back to the defaults, volume is kept between 0 and 1", () => {
  assert.deepEqual(readSettings(null, "{not json"), DEFAULTS);
  assert.deepEqual(readSettings(null, "[1,2]"), DEFAULTS);
  const odd = readSettings(null, JSON.stringify({ volume: 7, motion: "wild", voice: "robot", developer: "yes" }));
  assert.deepEqual(odd, { ...DEFAULTS, volume: 1 });
  assert.equal(readSettings(null, JSON.stringify({ volume: -2 })).volume, 0);
});

test("calm motion: chosen, or following a device that asks for it", () => {
  assert.equal(calmFor("calm", false), true);
  assert.equal(calmFor("full", true), false);
  assert.equal(calmFor("system", true), true);
  assert.equal(calmFor("system", false), false);
});

test("developer mode: ?dev wins, then the setting, then a local dev server", () => {
  assert.equal(developerFor(null, "jester-pi.vercel.app", false), false);
  assert.equal(developerFor(null, "jester-pi.vercel.app", true), true);
  assert.equal(developerFor("1", "jester-pi.vercel.app", false), true);
  assert.equal(developerFor("0", "localhost", true), false);
  assert.equal(developerFor(null, "localhost", false), true);
  assert.equal(developerFor(null, "127.0.0.1", false), true);
});

test("the announcer: off by default, ?host=1 still asks for the browser's voice", () => {
  assert.equal(voiceFor(null, "off"), "off");
  assert.equal(voiceFor("1", "off"), "browser");
  assert.equal(voiceFor("1", "recorded"), "recorded");
  assert.equal(voiceFor(null, "browser"), "browser");
});
