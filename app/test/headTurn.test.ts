import assert from "node:assert/strict";
import { test } from "node:test";
import { headTurn } from "../src/clipside/puppet3d.ts";

const at = (x: number) => ({ x });

test("a face square to the camera keeps the body's facing", () => {
  assert.equal(headTurn(at(100), at(115), at(85), 0), 0);
});

test("the nose off to one side of the ears turns the head that way, past the body", () => {
  const head = headTurn(at(110), at(115), at(85), 0);
  assert.ok(head > 0.4 && head < 0.6, `head ${head}`);
  // A body turned one way with the face back toward the camera: the head comes back round.
  assert.ok(headTurn(at(100), at(108), at(92), -1.1) > -0.3);
});

test("a believable neck: never more than 1 radian from the body", () => {
  assert.equal(headTurn(at(200), at(102), at(98), 0), 1);
});

test("without the nose or ears, or with the body facing away, the body's facing stands", () => {
  assert.equal(headTurn(null, at(115), at(85), 0.3), 0.3);
  assert.equal(headTurn(at(100), null, null, 0.3), 0.3);
  assert.equal(headTurn(at(130), at(115), at(85), Math.PI), Math.PI);
});
