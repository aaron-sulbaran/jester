// Jester clip side. Import from here; everything else is internal.

export type * from "./types.ts";
export { boxFromLandmarks, iou } from "./boxes.ts";
export { linkTracks, rejoinTracks } from "./tracks.ts";
export type { LinkOptions, RejoinOptions } from "./tracks.ts";
export { bodyShape, repairIdentities, shapeDistance, shapeSignature } from "./identity.ts";
export type { IdentityOptions, IdentityResult } from "./identity.ts";
export { frameSignature, signatureDistance, findCuts, shotRanges } from "./cuts.ts";
export { crossingShare, motionPerFrame, rankCandidates, pickConfirmFrame, pointNearFrame, withConfirmBoxes } from "./rank.ts";
export { checkClip, checkSubject } from "./rules.ts";
export type { Verdict } from "./rules.ts";
export { keyMoments, paceOf } from "./moments.ts";
export { buildGuide } from "./guide.ts";
export { hideUnsureJoints, UNSURE_BELOW, UNSURE_RADIUS } from "./steady.ts";
export { largestBlobInBox } from "./outline.ts";
export type { BinaryMask } from "./outline.ts";
export { placeSubject } from "./view.ts";
export { bodySpread, bodyTurns, frameTurn, widestSpread, NO_TURN } from "./turn.ts";
export type { Turn } from "./turn.ts";
export { boneLengths, facingOf, liftPose } from "./lift.ts";
export type { BoneLengths, Lifted, Vec3 } from "./lift.ts";
export type { Placement, View } from "./view.ts";
export {
  linkThings, withoutPeople, rankThings, thingMotionPerFrame, thingMoves, thingName, thingPace,
  boxPolygon, boxEllipse, buildThingGuide, thingGuides, THING_STILL, THING_OTHER_SHOT, thingObjectName, thingHint, boxTrackAt,
} from "./things.ts";
export type { ThingDetection, ThingFrame, ThingPoint, ThingTrack, ThingCandidate, ThingLinkOptions } from "./things.ts";
