// Jester clip side. Import from here; everything else is internal.

export type * from "./types.ts";
export { boxFromLandmarks, iou } from "./boxes.ts";
export { linkTracks } from "./tracks.ts";
export type { LinkOptions } from "./tracks.ts";
export { frameSignature, signatureDistance, findCuts, shotRanges } from "./cuts.ts";
export { motionPerFrame, rankCandidates, pickConfirmFrame, withConfirmBoxes } from "./rank.ts";
export { checkClip, checkSubject } from "./rules.ts";
export type { Verdict } from "./rules.ts";
export { keyMoments, paceOf } from "./moments.ts";
export { buildGuide } from "./guide.ts";
export { largestBlobInBox } from "./outline.ts";
export type { BinaryMask } from "./outline.ts";
export { placeSubject } from "./view.ts";
export type { Placement, View } from "./view.ts";
export {
  linkThings, withoutPeople, rankThings, thingMotionPerFrame, thingMoves, thingName, thingPace,
  boxPolygon, buildThingGuide, thingGuides, THING_STILL, THING_OTHER_SHOT,
} from "./things.ts";
export type { ThingDetection, ThingFrame, ThingPoint, ThingTrack, ThingCandidate, ThingLinkOptions } from "./things.ts";
