// What a recorded round keeps about the camera. A camera's name can carry a person's device name (for example a
// phone used as a webcam, named after its owner), so rounds from the live site never keep it. Rounds on a dev server
// keep it for the team's own debugging. Width, height and frame rate stay in both, since replays and the overlay
// analysis use them.

export interface CameraFacts { label: string | null; width: number | null; height: number | null; frameRate: number | null }

/** The part of a camera track this reads. */
export interface CameraTrack {
  label: string;
  getSettings(): { width?: number; height?: number; frameRate?: number };
}

/** `live` is true on a production build (the live site), false on a dev server. */
export function cameraFacts(track: CameraTrack, live: boolean): CameraFacts {
  const s = track.getSettings();
  return { label: live ? null : track.label, width: s.width ?? null, height: s.height ?? null, frameRate: s.frameRate ?? null };
}
