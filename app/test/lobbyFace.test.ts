import { test } from "node:test";
import assert from "node:assert/strict";
import { LOBBY_FACE_EVERY_MS, LOBBY_FACE_MAX_CHARS, LobbyFaceGate, lobbyFaceSideOk } from "../src/lobbyFace.ts";

const pic = (n: number) => `data:image/webp;base64,${"A".repeat(n)}`;

test("a lobby photo from someone not in the room is dropped", () => {
  const gate = new LobbyFaceGate(() => 0);
  assert.equal(gate.take("stranger", pic(10), false), false);
  assert.equal(gate.take("ben", pic(10), true), true);
});

test("an oversized lobby photo is dropped: too long, or too large a picture to decode", () => {
  const gate = new LobbyFaceGate(() => 0);
  assert.equal(gate.take("ben", pic(LOBBY_FACE_MAX_CHARS), true), false);
  assert.equal(lobbyFaceSideOk(160, 160), true);
  assert.equal(lobbyFaceSideOk(513, 160), false);
  assert.equal(lobbyFaceSideOk(160, 4000), false);
  assert.equal(lobbyFaceSideOk(0, 0), false);
});

test("a second photo from one player inside the window waits; the newest goes through after it", () => {
  let t = 0;
  const gate = new LobbyFaceGate(() => t);
  assert.equal(gate.take("ben", pic(1), true), true);
  gate.done("ben");
  t += LOBBY_FACE_EVERY_MS - 1;
  assert.equal(gate.take("ben", pic(2), true), false);
  assert.equal(gate.take("cy", pic(2), true), true); // one window per player
  t += 1;
  assert.equal(gate.take("ben", pic(3), true), true);
  assert.equal(gate.current("ben"), pic(3));
});

test("one decode at a time per player, and the same picture is never decoded twice", () => {
  let t = 0;
  const gate = new LobbyFaceGate(() => t);
  assert.equal(gate.take("ben", pic(1), true), true);
  t += LOBBY_FACE_EVERY_MS;
  assert.equal(gate.take("ben", pic(2), true), false); // still decoding the first
  gate.done("ben");
  assert.equal(gate.take("ben", pic(2), true), true);
  gate.done("ben");
  t += LOBBY_FACE_EVERY_MS;
  assert.equal(gate.take("ben", pic(2), true), false); // the same picture again: nothing to do
});
