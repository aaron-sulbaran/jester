// The people step every clip goes through: link each frame's detections into tracks, join people
// the linker split into pieces (one after another, or overlapping where the pose model saw someone
// twice), then keep each person on their own track where people cross.
// Clips from a file (app/src/clipside/analyze.ts) and from a link (grab.ts) both call this, so a
// clip is followed the same way whichever way it came in.

import { repairIdentities } from "./identity.ts";
import { linkTracks, mergeOverlapping, rejoinTracks } from "./tracks.ts";
import type { FrameDetections, Track } from "./types.ts";

/** A track survives this long without a match (about a second). */
const LINK_GAP_SECONDS = 1;
/** A person lost for up to this long (behind someone, at the back) is joined back into one track. */
const REJOIN_SECONDS = 3;

export interface TrackPeopleOptions {
  /** Analysed frames per second. */
  sampleHz: number;
  /** Frame width over height. */
  aspect: number;
}

export interface TrackedPeople {
  tracks: Track[];
  /** How many tracks linking made before pieces were joined, for the clip lab. */
  pieces: number;
}

/** Each person in the clip as one track, ordered by id. Pure and quick, so saved analyses run it again. */
export function trackPeople(frames: readonly FrameDetections[], cuts: readonly number[], options: TrackPeopleOptions): TrackedPeople {
  const linked = linkTracks(frames, cuts, { maxGap: Math.round(LINK_GAP_SECONDS * options.sampleHz) });
  const rejoin = { maxGap: Math.round(REJOIN_SECONDS * options.sampleHz), aspect: options.aspect };
  // Merging overlapping pieces can leave a merged track that the next piece now follows, so re-join again after.
  const joined = rejoinTracks(mergeOverlapping(rejoinTracks(linked, rejoin)), rejoin);
  // Puts back skeletons that crossing dancers swapped, and drops frames that show someone else's pose.
  const { tracks } = repairIdentities(joined, { aspect: options.aspect });
  return { tracks, pieces: linked.length };
}
