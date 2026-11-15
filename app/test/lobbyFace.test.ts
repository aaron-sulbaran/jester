import { test } from "node:test";
import assert from "node:assert/strict";
import { LOBBY_FACE_EVERY_MS, LOBBY_FACE_MAX_CHARS, LobbyFaceChoice, LobbyFaceGate, lobbyFaceSideOk } from "../src/lobbyFace.ts";

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

/** The lobby's loop for one player (room.ts syncFaces): what to wear, then the gate before any decode. */
function lobbyLoop(now: () => number) {
  const gate = new LobbyFaceGate(now), choice = new LobbyFaceChoice();
  let decodes = 0;
  return {
    see(media: { lobbyface?: string; face?: string }) {
      const want = choice.pick("ben", media);
      if (want && gate.current("ben") !== want && gate.take("ben", want, true)) { decodes++; gate.done("ben"); }
      return want;
    },
    get decodes() { return decodes; },
  };
}

test("taking a photo off keeps the cooldown: empty, picture, empty, picture inside the window decodes once", () => {
  const t = 0;
  const loop = lobbyLoop(() => t);
  loop.see({ lobbyface: pic(1) });
  assert.equal(loop.see({ lobbyface: "" }), null);
  loop.see({ lobbyface: pic(2) });
  loop.see({ lobbyface: "" });
  loop.see({ lobbyface: pic(3) });
  assert.equal(loop.decodes, 1);
});

test("a removal wins over a face from a finished round until a new photo arrives", () => {
  const choice = new LobbyFaceChoice();
  assert.equal(choice.pick("ben", { lobbyface: pic(1) }), pic(1));
  assert.equal(choice.pick("ben", { lobbyface: pic(1), face: pic(9) }), pic(9)); // a round brings a newer face
  assert.equal(choice.pick("ben", { lobbyface: "", face: pic(9) }), null); // taken off: grey, round face or not
  assert.equal(choice.pick("ben", {}), null); // a new round clears the room's media: still grey
  assert.equal(choice.pick("ben", { face: pic(8) }), null); // even with another round's face
  assert.equal(choice.pick("ben", { lobbyface: pic(2), face: pic(8) }), pic(2)); // a new photo: on again
});
