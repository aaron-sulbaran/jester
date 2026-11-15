// Which rounds the agent may read. The live site records every scored round, but it does not yet tell players so,
// or that numbers derived from their rounds could be read by Anthropic and the Meta Model API. So by default the
// agent works only on rounds from the simulated stand-in player and on the cases derived from them.
//
// JESTER_SEND_REAL_PLAYER_ROUNDS_TO_MODELS=true, set in agent/.env.local (git ignores it, so no commit can turn it
// on), lets the agent read real players' rounds too and send numbers derived from them to Anthropic and the Meta
// Model API. Aaron decides whether it is ever on. README "What leaves this laptop" lists exactly what is sent.

import type { RoundRecord } from "../../eval/src/record.ts";

export const SEND_REAL_PLAYER_ROUNDS = process.env.JESTER_SEND_REAL_PLAYER_ROUNDS_TO_MODELS === "true";

/** A real player is someone on a camera; the simulated stand-in player has none. */
export const isRealPlayer = (r: RoundRecord): boolean => r.device.camera !== null;

/** Whether the agent may read this round in the current mode. */
export const mayRead = (r: RoundRecord): boolean => SEND_REAL_PLAYER_ROUNDS || !isRealPlayer(r);

export const MODE_LINE = SEND_REAL_PLAYER_ROUNDS
  ? "Real players' rounds: ON (JESTER_SEND_REAL_PLAYER_ROUNDS_TO_MODELS=true). Numbers derived from them go to Anthropic and the Meta Model API."
  : "Real players' rounds: off. Only the simulated stand-in player's rounds and the cases derived from them are read.";
