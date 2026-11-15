// Which body parts a blind mode role can be copied with. A hand, the head or a foot copies the role's
// path across the screen, scored by the engine's trajectory channel. A role who stays in one place has
// no path, so the engine can only answer "nothing to mimic" and the player would see "no score". Those
// parts are not offered. The whole body is scored on the pose and is always offered.
//
// The check is the engine's own: it scores a still stand-in player for each part and drops the parts the
// engine answers "nothing-to-mimic" for. That answer depends only on the role's path (the stand-in is
// always fully seen), so the game and the engine cannot disagree.

// Straight from trajectory.ts, not the engine's index: in a dev or recording build the index's scorers
// save every call as a played round (app/round-log-plugin.ts), and these checks are not rounds.
import { BODY_PARTS, scoreTrajectoryRound, type BodyPart } from "../../engine/src/trajectory.ts";
import type { BoxTrack, Landmark, PoseTimeline } from "../../engine/src/types.ts";
import { makeStickPose, POSES } from "../../spikes/pose-match/synthetic.mjs";

/** A player standing still in full view for the length of `track`. */
function stillPlayer(track: BoxTrack): PoseTimeline {
  const pose = (makeStickPose(POSES.rest, { aspect: track.source.width / track.source.height }) as { x: number; y: number }[])
    .map((p): Landmark => [p.x, p.y, 1]);
  return {
    schema: "pose-timeline/1",
    source: { width: track.source.width, height: track.source.height, mirrored: false },
    frames: track.frames.map((f) => ({ tMs: f.tMs, landmarks: pose })),
  };
}

/** The body parts worth offering for a role whose path is `track`, whole body first. */
export function partsWorthOffering(track: BoxTrack): BodyPart[] {
  const player = stillPlayer(track);
  return (Object.keys(BODY_PARTS) as BodyPart[]).filter((part) =>
    part === "body" || scoreTrajectoryRound(track, player, { bodyPart: part, eitherSide: true }).failure !== "nothing-to-mimic");
}
