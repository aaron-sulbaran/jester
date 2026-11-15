import { test } from "node:test";
import assert from "node:assert/strict";
import { addressWithRoom, joinLink, linkShown, roomCodeFromSearch } from "../src/roomLink.ts";

test("roomCodeFromSearch: a 4-letter code in any case, or nothing", () => {
  assert.equal(roomCodeFromSearch("?room=rzyf"), "RZYF");
  assert.equal(roomCodeFromSearch("?dev=0&room=%20AbCd%20"), "ABCD");
  assert.equal(roomCodeFromSearch(""), null);
  assert.equal(roomCodeFromSearch("?room=ABC"), null);
  assert.equal(roomCodeFromSearch("?room=AB1D"), null);
  assert.equal(roomCodeFromSearch("?room=ABCDE"), null);
});

test("joinLink: this site's address with only the room code", () => {
  const here = { origin: "https://jester-git-x.vercel.app", hostname: "jester-git-x.vercel.app", pathname: "/" };
  assert.equal(joinLink("RZYF", here), "https://jester-git-x.vercel.app/?room=RZYF");
});

test("joinLink: a dev server nobody else can reach sends friends to the live site", () => {
  for (const hostname of ["localhost", "127.0.0.1"]) {
    assert.equal(joinLink("RZYF", { origin: `http://${hostname}:5173`, hostname, pathname: "/" }), "https://jester-pi.vercel.app/?room=RZYF");
  }
});

test("linkShown drops the scheme", () => {
  assert.equal(linkShown("https://jester-pi.vercel.app/?room=RZYF"), "jester-pi.vercel.app/?room=RZYF");
});

test("addressWithRoom sets and clears the code and keeps other settings", () => {
  assert.equal(addressWithRoom("https://a.app/?dev=0", "RZYF"), "https://a.app/?dev=0&room=RZYF");
  assert.equal(addressWithRoom("https://a.app/?dev=0&room=RZYF", null), "https://a.app/?dev=0");
  assert.equal(addressWithRoom("https://a.app/?room=RZYF", null), "https://a.app/");
});
