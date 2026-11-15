// Compact form of a performance timeline, small enough to send to other devices.
// x and y are stored as integers (range -0.5..1.5 so slightly off-screen joints survive),
// visibility as 0..100. Landmark z is dropped. Video and masks are never included.

const Q = 1000, OFFSET = 0.5;
const qc = (v) => Math.max(0, Math.min(2 * Q, Math.round((v + OFFSET) * Q)));
const dc = (n) => n / Q - OFFSET;

export function serializeTimeline(timeline, { every = 1 } = {}) {
  return {
    v: 1, aspect: timeline.aspect, dur: timeline.durationMs, cov: Math.round(timeline.coverage * 100) / 100, model: timeline.model,
    f: timeline.frames.filter((_, i) => i % every === 0).map((fr) => {
      const lm = [];
      for (const p of fr.landmarks) lm.push(qc(p.x), qc(p.y), Math.round((p.visibility ?? 1) * 100));
      const o = [];
      if (fr.outline) for (const [x, y] of fr.outline) o.push(qc(x), qc(y));
      return { t: Math.round(fr.t), lm, o };
    }),
  };
}

export function deserializeTimeline(data) {
  if (!data || data.v !== 1 || !Array.isArray(data.f)) throw new Error("Unsupported timeline format");
  return {
    version: 1, source: "webcam", mirrored: false, model: data.model, aspect: data.aspect,
    durationMs: data.dur, coverage: data.cov,
    frames: data.f.map((fr) => {
      const landmarks = [];
      for (let i = 0; i + 2 < fr.lm.length; i += 3) landmarks.push({ x: dc(fr.lm[i]), y: dc(fr.lm[i + 1]), z: 0, visibility: fr.lm[i + 2] / 100 });
      let outline = null;
      if (fr.o && fr.o.length) { outline = []; for (let i = 0; i + 1 < fr.o.length; i += 2) outline.push([dc(fr.o[i]), dc(fr.o[i + 1])]); }
      return { t: fr.t, landmarks, outline };
    }),
  };
}
