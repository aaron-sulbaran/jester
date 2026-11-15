// A player's own face on the 3D jester. The Blender render (art/jester/jester.py --faces) leaves the jester's
// face as a hole and writes, for every frame, where the hole is: centre, radius, sideways squash from turning,
// and tilt. Each frame draws the player's photo into the hole first, then the jester on top, so the cap and
// collar sit over the edges like a mask. Nothing here sends the photo anywhere; in an online room the room code
// shares it live with the other players (packMedia.ts), and it is never saved.

export type JesterAnim = "idle" | "dance" | "win" | "lose";

interface FaceTrack {
  fps: number;
  frameSize: number;
  variants: Record<string, string[]>;
  anims: Record<JesterAnim, { frames: number; loop: boolean; face: [number, number, number, number, number][] }>;
}

const BASE = "/jester/";
let track: Promise<FaceTrack> | null = null;
const strips = new Map<string, Promise<HTMLImageElement>>();

function loadTrack(): Promise<FaceTrack> {
  track ??= fetch(BASE + "face-track.json").then((r) => r.json() as Promise<FaceTrack>);
  return track;
}

function loadStrip(variant: string, anim: JesterAnim): Promise<HTMLImageElement> {
  const key = `${variant}-${anim}`;
  let p = strips.get(key);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Missing jester strip ${key}`));
      img.src = `${BASE}face-${key}.webp`;
    });
    strips.set(key, p);
  }
  return p;
}

/** Player n (0 based) wears colourway p1 to p4, matching the skin's --p1 to --p4. */
export const variantFor = (index: number) => `p${(index % 4) + 1}`;

/**
 * Every rendered colourway, keyed by its main colour: the four player colours, then red, orange and purple
 * (art/jester/jester.py ALL_PLAYERS, the same suits a player can pick on the cast screen).
 */
const VARIANT_OF_COLOUR: Readonly<Record<string, string>> = {
  "#f47fa6": "p1", "#4f7bf0": "p2", "#ffc93c": "p3", "#3fbf8f": "p4", "#d93a2b": "p5", "#ec8234": "p6", "#6b2fb3": "p7",
};
export const VARIANTS = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"] as const;

/** The rendered jester for a player colour, or null when that colour has none. */
export const variantOfColour = (color: string): string | null => VARIANT_OF_COLOUR[color.trim().toLowerCase()] ?? null;

/** Loads every strip for these colourways ahead of time, so nothing pops in during the crowning. */
export function preloadJesters(variants: string[]) {
  void loadTrack();
  for (const v of variants) for (const a of ["idle", "dance", "win", "lose"] as JesterAnim[]) void loadStrip(v, a).catch(() => {});
}

/**
 * One animated jester on its own canvas. `face` is a square photo (or null: a plain grey stand-in, never a
 * cartoon face). Loops idle and dance; holds the last frame of win and lose.
 */
export class FaceJester {
  readonly canvas: HTMLCanvasElement;
  private face: HTMLCanvasElement | null;
  private variant: string;
  private anim: JesterAnim = "idle";
  private started = 0;
  private raf = 0;

  constructor(face: HTMLCanvasElement | null, variant: string, size = 240) {
    this.face = face;
    this.variant = variant;
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.canvas.height = size;
    this.canvas.className = "face-jester";
  }

  play(anim: JesterAnim) {
    this.anim = anim;
    this.started = performance.now();
    if (!this.raf) this.tick();
  }

  stop() { cancelAnimationFrame(this.raf); this.raf = 0; }

  /** Puts a new face on this jester (or the grey stand-in for null); the next frame shows it. */
  setFace(face: HTMLCanvasElement | null) { this.face = face; }

  private tick = () => {
    this.raf = requestAnimationFrame(this.tick);
    void this.draw();
  };

  private async draw() {
    const t = await loadTrack();
    const strip = await loadStrip(this.variant, this.anim).catch(() => null);
    if (!strip) return;
    const a = t.anims[this.anim];
    const n = Math.floor(((performance.now() - this.started) / 1000) * t.fps);
    const i = a.loop ? n % a.frames : Math.min(n, a.frames - 1);
    const [x, y, r, squash, rot] = a.face[i]!;
    const size = this.canvas.width, k = size / t.frameSize;
    const ctx = this.canvas.getContext("2d")!;
    ctx.clearRect(0, 0, size, size);
    // The face, turned and squashed with the head, a touch larger than the hole so no gap shows at the rim.
    ctx.save();
    ctx.translate(x * k, y * k);
    ctx.rotate(rot);
    ctx.scale(squash, 1);
    const rr = r * k * 1.04;
    ctx.beginPath(); ctx.arc(0, 0, rr, 0, Math.PI * 2); ctx.clip();
    if (this.face) ctx.drawImage(this.face, -rr, -rr, rr * 2, rr * 2);
    else {
      ctx.fillStyle = "#DEDDD8"; ctx.fillRect(-rr, -rr, rr * 2, rr * 2);
      ctx.fillStyle = "#A8A7A1";
      ctx.beginPath(); ctx.ellipse(0, -rr * 0.05, rr * 0.42, rr * 0.52, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    ctx.drawImage(strip, i * t.frameSize, 0, t.frameSize, t.frameSize, 0, 0, size, size);
  }
}
