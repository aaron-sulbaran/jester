import assert from "node:assert/strict";
import { test } from "node:test";
import { playWithSound, setAloud } from "../src/sound.ts";

// A clip element where Web Audio never took over its sound (no soundTrack call), as in a browser without it.
const fakeMedia = () => ({ muted: false, played: 0, async play() { this.played++; } }) as unknown as HTMLMediaElement & { played: number };

test("a device that is not the host keeps the clip quiet while it plays the recap, then gets its sound back", async () => {
  const media = fakeMedia();
  setAloud(media, false);
  assert.equal(media.muted, true);
  await playWithSound(media);                    // the recap's clock starts the clip: it must stay quiet
  assert.equal(media.muted, true);
  assert.equal(media.played, 1);
  setAloud(media, true);
  await playWithSound(media);                    // the next turn plays the music again
  assert.equal(media.muted, false);
});

test("the host's clip plays aloud as before", async () => {
  const media = fakeMedia();
  setAloud(media, true);
  await playWithSound(media);
  assert.equal(media.muted, false);
});
