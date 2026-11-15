// Reveal composite: put every player's recording into ONE frame, each player standing where
// their clip character stands. Pure functions plus a canvas drawer; no camera, no video.
// Poses are 33 MediaPipe landmarks {x, y, visibility}, normalized image coords, unmirrored.
import { mirrorPose } from "./score.mjs";

export const PLAYER_COLORS = ["#f5c542", "#4cc9f0", "#f72585", "#80ed99", "#c77dff"];
export const MAX_GAP_MS = 200; // a recording with a longer hole than this shows no figure there
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];

// The recorded frame nearest to clip time t, or null if the nearest is further than MAX_GAP_MS.
export function sampleTimeline(frames, t, maxGapMs = MAX_GAP_MS) {
  if (!frames || frames.length === 0) return null;
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (frames[mid].t < t) lo = mid + 1; else hi = mid; }
  let best = frames[lo];
  if (lo > 0 && Math.abs(frames[lo - 1].t - t) <= Math.abs(best.t - t)) best = frames[lo - 1];
  return Math.abs(best.t - t) <= maxGapMs ? best : null;
}

function stance(pose, aspect) {
  const mid = (a, b) => ({ x: (pose[a].x + pose[b].x) / 2 * aspect, y: (pose[a].y + pose[b].y) / 2 });
  const hip = mid(23, 24), shoulder = mid(11, 12);
  return { hip, torso: Math.hypot(shoulder.x - hip.x, shoulder.y - hip.y) };
}

// Re-place a player's pose onto a clip character: mirror the player (as the game does), scale so
// the torso matches the character's, and move the hips to the character's hips. Works in
// "image height" units so different camera and clip aspects do not squash the figure.
export function fitToCharacter(playerPose, playerAspect, characterPose, clipAspect, { mirror = true } = {}) {
  if (!playerPose || !characterPose) return null;
  const p = mirror ? mirrorPose(playerPose) : playerPose;
  const from = stance(p, playerAspect), to = stance(characterPose, clipAspect);
  if (from.torso < 1e-6) return null;
  const k = to.torso / from.torso;
  return p.map((lm) => ({
    ...lm,
    x: ((lm.x * playerAspect - from.hip.x) * k + to.hip.x) / clipAspect,
    y: (lm.y - from.hip.y) * k + to.hip.y,
  }));
}

// One composite frame: for each role { timeline, characterPose, name? } at clip time t.
export function composeFrame(roles, t, { playerAspect, clipAspect }) {
  return roles.map((role, i) => {
    const frame = sampleTimeline(role.timeline.frames, t);
    const pose = frame ? fitToCharacter(frame.landmarks, role.timeline.aspect ?? playerAspect, role.characterPose, clipAspect) : null;
    return { pose, color: PLAYER_COLORS[i % PLAYER_COLORS.length], name: role.name ?? "Player " + (i + 1) };
  });
}

// Draw stick figures (one colour per player) on a canvas, over a plain background.
export function drawComposite(ctx, w, h, figures, { background = "#16161d", highlight = -1 } = {}) {
  ctx.fillStyle = background; ctx.fillRect(0, 0, w, h);
  figures.forEach((fig, i) => {
    if (!fig.pose) return;
    ctx.globalAlpha = highlight < 0 || highlight === i ? 1 : 0.35;
    ctx.strokeStyle = fig.color; ctx.fillStyle = fig.color; ctx.lineWidth = highlight === i ? 7 : 4; ctx.lineCap = "round";
    ctx.beginPath();
    for (const [a, b] of BONES) {
      const p = fig.pose[a], q = fig.pose[b];
      if ((p.visibility ?? 1) < 0.5 || (q.visibility ?? 1) < 0.5) continue;
      ctx.moveTo(p.x * w, p.y * h); ctx.lineTo(q.x * w, q.y * h);
    }
    ctx.stroke();
    if ((fig.pose[0].visibility ?? 1) >= 0.5) { ctx.beginPath(); ctx.arc(fig.pose[0].x * w, fig.pose[0].y * h, h * 0.04, 0, Math.PI * 2); ctx.fill(); }
  });
  ctx.globalAlpha = 1;
}

// Winner = best score; ties keep the first. scores: array of numbers or null.
export function winnerIndex(scores) {
  let best = -1, top = -Infinity;
  scores.forEach((s, i) => { if (s != null && s > top) { top = s; best = i; } });
  return best;
}
