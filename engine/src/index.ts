// Jester accuracy engine. Import from here; everything else is internal.

export { SCORER_VERSION, GRID_HZ } from "./constants.ts";
export * as constants from "./constants.ts";
export type * from "./types.ts";
export { comparePoses, scorePoseRound, limbCredit } from "./pose.ts";
export type { PoseComparison, LimbComparison, CompareOptions, PoseRoundOptions } from "./pose.ts";
export { scoreTrajectoryRound, detectEvents, matchEvents, BODY_PARTS } from "./trajectory.ts";
export type { TrajectoryRoundOptions, BodyPart } from "./trajectory.ts";
export { skeletonGate } from "./gate.ts";
export { scorePlacement } from "./placement.ts";
export type { GateResult } from "./gate.ts";
export { LIMBS, LIMB_NAMES } from "./geometry.ts";
export { fromWebcamFrames, fromClipSamples } from "./adapters.ts";
export type { WebcamFrame, WebcamAdapterOptions, ClipSample, ClipAdapterOptions, LandmarkObject } from "./adapters.ts";
