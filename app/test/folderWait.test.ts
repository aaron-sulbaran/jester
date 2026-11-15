import assert from "node:assert/strict";
import { test } from "node:test";
import { folderWait } from "../src/folderWait.ts";

test("says nothing when the desk is not stuck on the folder", () => {
  assert.equal(folderWait(3, false, "Pick the bank folder"), null);
});

test("counts the waiting clips and points at the folder button", () => {
  assert.equal(folderWait(3, true, "Pick the bank folder"), 'Not reviewing yet: 3 clips are waiting for the bank folder. Click "Pick the bank folder" above to start.');
  assert.equal(folderWait(1, true, "Pick the bank folder"), 'Not reviewing yet: 1 clip is waiting for the bank folder. Click "Pick the bank folder" above to start.');
  assert.equal(folderWait(0, true, "Pick the bank folder"), 'Not reviewing yet: New clips wait for the bank folder. Click "Pick the bank folder" above to start.');
});

test("a label that already has quotes is not quoted again", () => {
  assert.equal(folderWait(2, true, 'Use "bank" again'), 'Not reviewing yet: 2 clips are waiting for the bank folder. Click Use "bank" again above to start.');
});
