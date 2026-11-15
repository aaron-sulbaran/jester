// The blind mode guide puppet as a solid 3D jester, built at run time from simple shapes with three.js (no
// model files). Loaded on demand (clipside/blind.ts imports this module only when the 3D puppet is asked
// for), so three.js stays out of the main bundle.
//
// One shared WebGL canvas renders the puppet with an orthographic camera laid exactly over the guide canvas,
// so every joint lands where the stick figure's would; depth (from ../../../clip/src/lift.ts) only changes
// how the body looks: limbs that point at the camera, a torso that turns, a face that goes round the head.
// Limbs are tapered tubes that run into round joints, so nothing shows a seam, pin or screw.
//
// The look keeps the scrapbook rules: each part has two flat tones (the player's colour, its 80/20 light
// with --photo or its 72/28 dark with --ink), no gradients; ink outlines from slightly larger back faces;
// then on the 2D canvas a white die-cut edge and one hard --shade shadow, as the #die-cut filter does.

import {
  BackSide, BufferAttribute, BufferGeometry, ColorManagement, CylinderGeometry, Group, LinearSRGBColorSpace, Matrix4, Mesh,
  MeshBasicMaterial, OctahedronGeometry, OrthographicCamera, QuadraticBezierCurve3, Quaternion, Scene, ShaderMaterial,
  SphereGeometry, TorusGeometry, Vector3, WebGLRenderer, type Material,
} from "three";
import type { Lifted, Turn, Vec3 } from "../../../clip/src/index.ts";
import type { Suit } from "./puppet.ts";

// Colours are used exactly as written: no colour management, no output conversion.
ColorManagement.enabled = false;

const INK = "#1E1B18", PHOTO = "#FFFFFF", GOLD = "#F4BE1A", STAMP = "#D93A2B", WOOD = "#EDCB8E";
const SHADE_ALPHA = 0.34;

function rgb(color: string): [number, number, number] {
  const m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(color.trim());
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
  const h = color.trim().replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [parseInt(full.slice(0, 2), 16) / 255, parseInt(full.slice(2, 4), 16) / 255, parseInt(full.slice(4, 6), 16) / 255];
}
const mixHex = (a: string, b: string, t: number): [number, number, number] => {
  const x = rgb(a), y = rgb(b);
  return [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t];
};

// ---- Materials: two flat tones, lit or in shade, split down the middle for the suit when asked ----

const VERTEX = `
varying vec3 vNormal;
varying float vSide;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vSide = position.x;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAGMENT = `
uniform vec3 uLit; uniform vec3 uShade; uniform vec3 uLitB; uniform vec3 uShadeB; uniform float uSplit;
varying vec3 vNormal;
varying float vSide;
void main() {
  bool b = uSplit > 0.5 && vSide < 0.0;
  float d = dot(normalize(vNormal), normalize(vec3(-0.45, 0.6, 0.65)));
  vec3 lit = b ? uLitB : uLit;
  vec3 shade = b ? uShadeB : uShade;
  gl_FragColor = vec4(d > 0.08 ? lit : shade, 1.0);
}`;

type Tones = { lit: [number, number, number]; shade: [number, number, number] };

function toon(a: Tones, b?: Tones): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERTEX, fragmentShader: FRAGMENT,
    uniforms: {
      uLit: { value: new Vector3(...a.lit) }, uShade: { value: new Vector3(...a.shade) },
      uLitB: { value: new Vector3(...(b ?? a).lit) }, uShadeB: { value: new Vector3(...(b ?? a).shade) },
      uSplit: { value: b ? 1 : 0 },
    },
  });
}
function setTones(m: ShaderMaterial, a: Tones, b?: Tones) {
  (m.uniforms.uLit!.value as Vector3).set(...a.lit); (m.uniforms.uShade!.value as Vector3).set(...a.shade);
  (m.uniforms.uLitB!.value as Vector3).set(...(b ?? a).lit); (m.uniforms.uShadeB!.value as Vector3).set(...(b ?? a).shade);
}
const flat = (color: string) => new MeshBasicMaterial({ color: rgb(color).reduce((n, v) => n * 256 + Math.round(v * 255), 0) });

// ---- Shapes ----

/** A tube along +y from 0 to 1, radius 1 at the bottom and `tip` at the top, open ended (joints cap it). */
function taperGeometry(tip: number) {
  const g = new CylinderGeometry(tip, 1, 1, 18, 1, true);
  g.translate(0, 0.5, 0);
  return g;
}

/** A tube along a curve with its radius easing from `r0` to `r1`, closed at the thin end. */
function hornGeometry(points: Vector3[], r0: number, r1: number): BufferGeometry {
  const curve = new QuadraticBezierCurve3(points[0]!, points[1]!, points[2]!);
  const rings = 16, sides = 12;
  const pos: number[] = [], index: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const c = curve.getPoint(t), tan = curve.getTangent(t);
    const n = new Vector3(0, 0, 1).cross(tan).normalize();
    if (n.lengthSq() < 1e-6) n.set(1, 0, 0);
    const b = tan.clone().cross(n).normalize();
    const r = r0 + (r1 - r0) * t;
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      pos.push(c.x + (n.x * Math.cos(a) + b.x * Math.sin(a)) * r, c.y + (n.y * Math.cos(a) + b.y * Math.sin(a)) * r, c.z + (n.z * Math.cos(a) + b.z * Math.sin(a)) * r);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let k = 0; k < sides; k++) {
      const a = i * sides + k, b2 = i * sides + ((k + 1) % sides), c2 = a + sides, d = b2 + sides;
      index.push(a, b2, c2, b2, d, c2);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

const UP = new Vector3(0, 1, 0);
const tmpQ = new Quaternion();

interface Part { fill: Mesh; hull: Mesh }

/** The figure: every mesh built once, posed each frame. */
class Figure {
  readonly scene = new Scene();
  readonly sphere = new SphereGeometry(1, 28, 18);
  readonly ink = new MeshBasicMaterial({ color: 0x1e1b18, side: BackSide });
  readonly mats = {
    a: toon({ lit: rgb("#888888"), shade: rgb("#444444") }),
    b: toon({ lit: rgb("#888888"), shade: rgb("#444444") }),
    suit: toon({ lit: rgb("#888888"), shade: rgb("#444444") }, { lit: rgb("#999999"), shade: rgb("#555555") }),
    cap: toon({ lit: rgb("#888888"), shade: rgb("#444444") }, { lit: rgb("#999999"), shade: rgb("#555555") }),
    shoe: toon({ lit: rgb("#888888"), shade: rgb("#444444") }),
    wood: toon({ lit: rgb(WOOD), shade: mixHex(WOOD, INK, 0.2) }),
    white: toon({ lit: rgb(PHOTO), shade: mixHex(PHOTO, INK, 0.14) }),
    gold: toon({ lit: rgb(GOLD), shade: mixHex(GOLD, INK, 0.28) }),
    red: toon({ lit: rgb(STAMP), shade: mixHex(STAMP, INK, 0.28) }),
    inkFlat: flat(INK), whiteFlat: flat(PHOTO), redFlat: flat(STAMP),
  };
  private readonly limbs: Record<string, Part> = {};
  private readonly joints: Record<string, Part> = {};
  readonly head = new Group();
  private readonly headParts: Record<string, Part> = {};
  private readonly caps = new Map<number, SphereGeometry>();
  private readonly cap: Part;
  private readonly horns: { side: 1 | -1; part: Part; bell: Part }[] = [];
  private hullInk = 0.06;

  constructor() {
    const LIMB_TIPS: Record<string, number> = { upperArm: 0.84, forearm: 0.84, thigh: 0.8, shin: 0.8 };
    for (const side of ["l", "r"]) {
      for (const [name, tip] of Object.entries(LIMB_TIPS)) {
        const g = taperGeometry(tip);
        this.limbs[side + name] = this.part(g, side === "l" ? this.mats.a : this.mats.b, this.scene);
      }
      for (const name of ["shoulder", "elbow", "hip", "knee"]) this.joints[side + name] = this.part(this.sphere, side === "l" ? this.mats.a : this.mats.b, this.scene);
      this.joints[side + "cuffW"] = this.part(this.sphere, this.mats.white, this.scene);
      this.joints[side + "cuffA"] = this.part(this.sphere, this.mats.white, this.scene);
      this.joints[side + "hand"] = this.part(this.sphere, this.mats.wood, this.scene);
      this.joints[side + "shoe"] = this.part(this.sphere, this.mats.shoe, this.scene);
      this.joints[side + "pompom"] = this.part(this.sphere, this.mats.gold, this.scene);
    }
    this.joints.torso = this.part(this.sphere, this.mats.suit, this.scene);
    this.joints.ruff = this.part(this.sphere, this.mats.white, this.scene);
    // The head, in head space: radius 1, the face toward +z, the subject's left toward +x.
    this.scene.add(this.head);
    this.headParts.skull = this.part(this.sphere, this.mats.wood, this.head);
    this.cap = this.part(this.capGeometry(0.42), this.mats.cap, this.head);
    for (const side of [1, -1] as const) {
      const pts = [new Vector3(0.3 * side, 0.8, -0.1), new Vector3(1.25 * side, 1.4, -0.25), new Vector3(1.62 * side, 0.5, -0.3)];
      const part = this.part(hornGeometry(pts, 0.42, 0.13), side === 1 ? this.mats.a : this.mats.b, this.head);
      (part.hull.geometry as BufferGeometry).dispose();
      part.hull.geometry = hornGeometry(pts, 0.42 + this.hullInk, 0.13 + this.hullInk);
      const bell = this.part(this.sphere, this.mats.gold, this.head);
      this.place(bell, new Vector3(1.66 * side, 0.36, -0.3), 0.24);
      this.horns.push({ side, part, bell });
    }
    // The face.
    const onHead = (lon: number, lat: number, out = 1) => new Vector3(Math.sin(lon) * Math.cos(lat) * out, Math.sin(lat) * out, Math.cos(lon) * Math.cos(lat) * out);
    const facing = (m: Mesh, at: Vector3) => m.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), at.clone().normalize());
    for (const side of [1, -1]) {
      const eye = new Mesh(this.sphere, this.mats.inkFlat);
      const at = onHead(0.32 * side, 0.06, 0.97);
      eye.position.copy(at); eye.scale.set(0.12, 0.17, 0.07); facing(eye, at);
      const glint = new Mesh(this.sphere, this.mats.whiteFlat);
      const gat = onHead(0.32 * side - 0.05, 0.13, 1.03);
      glint.position.copy(gat); glint.scale.setScalar(0.045);
      const cheek = new Mesh(new OctahedronGeometry(1), this.mats.redFlat);
      const cat = onHead(0.6 * side, -0.2, 0.98);
      cheek.position.copy(cat); cheek.scale.set(0.09, 0.12, 0.03); facing(cheek, cat);
      this.head.add(eye, glint, cheek);
    }
    const nose = this.part(this.sphere, this.mats.red, this.head);
    this.place(nose, onHead(0, -0.1, 1.04), 0.13);
    const smile = new Mesh(new TorusGeometry(0.22, 0.05, 8, 20, Math.PI), this.mats.inkFlat);
    const sat = onHead(0, -0.38, 0.95);
    smile.position.copy(sat); facing(smile, sat); smile.rotateZ(Math.PI);
    this.head.add(smile);
  }

  /** A mesh and its ink hull (the same shape drawn from its back faces a little bigger). */
  private part(geometry: BufferGeometry, material: Material, parent: Scene | Group): Part {
    const fill = new Mesh(geometry, material), hull = new Mesh(geometry, this.ink);
    parent.add(fill, hull);
    return { fill, hull };
  }

  private capGeometry(cover: number): SphereGeometry {
    const key = Math.round(cover * 20) / 20;
    let g = this.caps.get(key);
    if (!g) { g = new SphereGeometry(1.04, 28, 14, 0, Math.PI * 2, 0, Math.PI * key); this.caps.set(key, g); }
    return g;
  }

  /** A round part at `c` (radii in px, or head units inside the head). */
  place(p: Part, c: Vector3, r: number, ry = r, rz = r, q?: Quaternion, ink = this.hullInk) {
    for (const [m, grow] of [[p.fill, 0], [p.hull, ink]] as const) {
      m.visible = true;
      m.position.copy(c);
      m.scale.set(r + grow, ry + grow, rz + grow);
      if (q) m.quaternion.copy(q); else m.quaternion.identity();
    }
  }

  /** A limb from `a` to `b`, `r` thick at `a`. */
  segment(p: Part, a: Vector3, b: Vector3, r: number, ink: number) {
    const d = b.clone().sub(a);
    const len = d.length();
    if (len < 1e-3) { p.fill.visible = p.hull.visible = false; return; }
    tmpQ.setFromUnitVectors(UP, d.divideScalar(len));
    for (const [m, grow] of [[p.fill, 0], [p.hull, ink]] as const) {
      m.visible = true;
      m.position.copy(a);
      m.scale.set(r + grow, len, r + grow);
      m.quaternion.copy(tmpQ);
    }
  }

  hide() {
    for (const p of [...Object.values(this.limbs), ...Object.values(this.joints)]) p.fill.visible = p.hull.visible = false;
    this.head.visible = false;
  }

  pose(joints: (Vector3 | null)[], facing: number, face: number, T: number, ink: number, suit: Suit) {
    this.hide();
    const tone = (lit: string, shade: string): Tones => ({ lit: rgb(lit), shade: rgb(shade) });
    // The subject's left in the player's colour, the right in its light shade, shadows in the dark shade.
    setTones(this.mats.a, tone(suit.base, suit.dark));
    setTones(this.mats.b, tone(suit.light, suit.base));
    setTones(this.mats.suit, tone(suit.base, suit.dark), tone(suit.light, suit.base));
    setTones(this.mats.cap, tone(suit.base, suit.dark), tone(suit.light, suit.base));
    setTones(this.mats.shoe, tone(suit.dark, suit.dark), undefined);
    const j = (i: number) => joints[i] ?? null;
    const sides = [["l", 11, 13, 15, 23, 25, 27, 29, 31, [17, 19]], ["r", 12, 14, 16, 24, 26, 28, 30, 32, [18, 20]]] as const;
    const R = { shoulder: 0.19, elbow: 0.16, wrist: 0.135, hip: 0.25, knee: 0.2, ankle: 0.16 };
    for (const [s, sh, el, wr, hp, kn, an, he, to, fingers] of sides) {
      const S = j(sh), E = j(el), W = j(wr), Hp = j(hp), K = j(kn), A = j(an);
      if (S) this.place(this.joints[s + "shoulder"]!, S, R.shoulder * T, undefined, undefined, undefined, ink);
      if (S && E) this.segment(this.limbs[s + "upperArm"]!, S, E, R.shoulder * T, ink);
      if (E) this.place(this.joints[s + "elbow"]!, E, R.elbow * T, undefined, undefined, undefined, ink);
      if (E && W) {
        this.segment(this.limbs[s + "forearm"]!, E, W, R.elbow * T, ink);
        this.place(this.joints[s + "cuffW"]!, W, R.wrist * T * 1.25, undefined, undefined, undefined, ink);
        const f = fingers.map(j).filter((p): p is Vector3 => !!p);
        const toward = f.length ? f.reduce((acc, p) => acc.add(p), new Vector3()).divideScalar(f.length).sub(W) : W.clone().sub(E);
        const reach = Math.min(Math.max(toward.length() * 0.7, T * 0.08), T * 0.2);
        this.place(this.joints[s + "hand"]!, W.clone().add(toward.normalize().multiplyScalar(reach)), T * 0.17, undefined, undefined, undefined, ink);
      }
      if (Hp) this.place(this.joints[s + "hip"]!, Hp, R.hip * T * 0.9, undefined, undefined, undefined, ink);
      if (Hp && K) this.segment(this.limbs[s + "thigh"]!, Hp, K, R.hip * T, ink);
      if (K) this.place(this.joints[s + "knee"]!, K, R.knee * T, undefined, undefined, undefined, ink);
      if (K && A) {
        this.segment(this.limbs[s + "shin"]!, K, A, R.knee * T, ink);
        this.place(this.joints[s + "cuffA"]!, A, R.ankle * T * 1.25, undefined, undefined, undefined, ink);
        const heel = j(he) ?? A, toe = j(to);
        const along = toe ? toe.clone().sub(heel) : new Vector3(0, -1, 0).multiplyScalar(T * 0.2);
        const len = Math.max(along.length(), T * 0.25);
        const mid = heel.clone().add(toe ?? heel.clone().add(along)).multiplyScalar(0.5);
        const q = new Quaternion().setFromUnitVectors(new Vector3(1, 0, 0), along.clone().normalize());
        this.place(this.joints[s + "shoe"]!, mid, len * 0.62, T * 0.12, T * 0.13, q, ink);
        const tip = mid.clone().add(along.clone().normalize().multiplyScalar(len * 0.6));
        this.place(this.joints[s + "pompom"]!, tip, T * 0.065, undefined, undefined, undefined, ink);
      }
    }
    // The torso: an egg from the hips to the shoulders, as wide as the shoulders, half a torso deep. A joint
    // the tracker stays unsure of is hidden (missing here); the body stands in for it rather than vanish or
    // jump: a missing shoulder or hip mirrors its partner, missing hips hang a torso below the shoulders.
    const down = new Vector3(0, -1, 0);
    let ls = j(11), rs = j(12), lh = j(23), rh = j(24);
    const mirror = (a: Vector3 | null, b: Vector3 | null, aPair: Vector3 | null, bPair: Vector3 | null): [Vector3 | null, Vector3 | null] => {
      if (a && b) return [a, b];
      if (a && aPair && bPair) return [a, a.clone().sub(aPair).add(bPair)];
      if (b && aPair && bPair) return [b.clone().sub(bPair).add(aPair), b];
      return [a, b];
    };
    [ls, rs] = mirror(ls, rs, lh, rh);
    [lh, rh] = mirror(lh, rh, ls, rs);
    let sm: Vector3 | null = ls && rs ? ls.clone().add(rs).multiplyScalar(0.5) : null;
    let hm: Vector3 | null = lh && rh ? lh.clone().add(rh).multiplyScalar(0.5) : null;
    if (sm && !hm) hm = sm.clone().add(down.clone().multiplyScalar(T));
    if (!sm && hm) sm = hm.clone().sub(down.clone().multiplyScalar(T));
    let y = UP.clone();
    if (sm && hm) {
      y = sm.clone().sub(hm);
      const height = Math.max(y.length(), T * 0.5);
      y.normalize();
      const x = ls && rs ? ls.clone().sub(rs) : lh && rh ? lh.clone().sub(rh) : new Vector3(1, 0, 0);
      x.sub(y.clone().multiplyScalar(x.dot(y)));
      if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
      x.normalize();
      const z = x.clone().cross(y).normalize();
      const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
      const width = Math.max(ls && rs ? ls.distanceTo(rs) : T * 0.7, T * 0.6) * 0.55;
      this.place(this.joints.torso!, sm.clone().lerp(hm, 0.48), width, height * 0.62, T * 0.3, q, ink);
      // A soft white collar round the neck: a flattened ball, tipped toward us so it reads from the front.
      const tip = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.35);
      this.place(this.joints.ruff!, sm.clone().add(y.clone().multiplyScalar(T * 0.04)), width * 0.78, T * 0.13, T * 0.36, q.clone().multiply(tip), ink);
    }
    // The head sits on the neck, leaning with it, turned to face where the body faces. Without a body it
    // still shows where the ears or nose are.
    const ears = [j(7), j(8)].filter((p): p is Vector3 => !!p);
    const found = ears.length === 2 ? ears[0]!.clone().add(ears[1]!).multiplyScalar(0.5) : ears[0] ?? j(0) ?? (sm ? sm.clone().add(y.clone().multiplyScalar(T * 0.55)) : null);
    if (!found) return;
    const headAt = found.clone();
    if (sm) headAt.z = sm.z;
    const neck = sm ? headAt.clone().sub(sm) : new Vector3();
    const lean = neck.lengthSq() > 1e-6 ? new Vector3(neck.x, neck.y, 0).normalize() : y;
    const radius = T * 0.5;
    this.head.visible = true;
    this.head.position.copy(headAt.add(lean.clone().multiplyScalar(radius * 0.1)));
    this.head.quaternion.setFromUnitVectors(UP, lean).multiply(new Quaternion().setFromAxisAngle(UP, facing));
    this.head.scale.setScalar(radius);
    // Inside the head everything is in head radii, so the outline is the ink over the radius.
    const hullInk = ink / radius;
    if (Math.abs(hullInk - this.hullInk) > 0.015) this.rebuildHulls(hullInk);
    this.place(this.headParts.skull!, new Vector3(), 1, 1, 1, undefined, this.hullInk);
    const cover = 0.42 + (0.86 - 0.42) * (1 - Math.min(1, Math.max(0, face)));
    const capGeo = this.capGeometry(cover);
    this.cap.fill.geometry = capGeo; this.cap.hull.geometry = capGeo;
    this.place(this.cap, new Vector3(), 1, 1, 1, undefined, this.hullInk);
    for (const h of this.horns) { h.part.fill.visible = h.part.hull.visible = true; h.bell.fill.visible = h.bell.hull.visible = true; }
  }

  /** Head-space outlines are in head radii; when the head's size changes a lot, their thickness follows. */
  private rebuildHulls(ink: number) {
    this.hullInk = ink;
    for (const h of this.horns) {
      const pts = [new Vector3(0.3 * h.side, 0.8, -0.1), new Vector3(1.25 * h.side, 1.4, -0.25), new Vector3(1.62 * h.side, 0.5, -0.3)];
      h.part.hull.geometry.dispose();
      h.part.hull.geometry = hornGeometry(pts, 0.42 + ink, 0.13 + ink);
      this.place(h.bell, h.bell.fill.position.clone(), 0.24, 0.24, 0.24, undefined, ink);
    }
  }
}

// ---- Rendering onto the guide's 2D canvas ----

let shared: { renderer: WebGLRenderer; camera: OrthographicCamera; figure: Figure } | null = null;
let failed = false;

function setup() {
  if (shared || failed) return shared;
  try {
    const canvas = document.createElement("canvas");
    const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.outputColorSpace = LinearSRGBColorSpace;
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0);
    shared = { renderer, camera: new OrthographicCamera(0, 1, 0, -1, -10000, 10000), figure: new Figure() };
  } catch {
    failed = true;
  }
  return shared;
}

/** True when this browser can draw the 3D puppet (WebGL works). */
export function available(): boolean {
  return setup() !== null;
}

const layers = new WeakMap<object, HTMLCanvasElement>();

export interface Puppet3dFrame {
  /** The lifted pose with every joint already in canvas pixels (x right, y down, z away from the camera). */
  lifted: Lifted;
  turn: Turn;
  /** Torso length in canvas pixels. */
  torso: number;
  suit: Suit;
}

/** Draws the 3D puppet onto `ctx` (over whatever is there): its hard shadow, white die-cut edge, then the figure. */
export function drawPuppet3d(ctx: CanvasRenderingContext2D, frame: Puppet3dFrame): boolean {
  const s = setup();
  if (!s) return false;
  const { width: w, height: h } = ctx.canvas;
  const { renderer, camera, figure } = s;
  if (renderer.domElement.width !== w || renderer.domElement.height !== h) renderer.setSize(w, h, false);
  camera.left = 0; camera.right = w; camera.top = 0; camera.bottom = -h;
  camera.updateProjectionMatrix();
  const T = frame.torso;
  const ink = Math.max(3, T * 0.065);
  // Three's world: y up and z toward the camera.
  const world = frame.lifted.joints.map((p: Vec3 | null) => (p ? new Vector3(p[0], -p[1], -p[2]) : null));
  figure.pose(world, frame.lifted.facing, frame.turn.face, T, ink, frame.suit);
  renderer.render(figure.scene, camera);
  const gl = renderer.domElement;

  // The sticker: the figure grown by the rim in white, with one hard shadow, as the #die-cut filter does.
  let layer = layers.get(ctx.canvas);
  if (!layer) { layer = document.createElement("canvas"); layers.set(ctx.canvas, layer); }
  if (layer.width !== w || layer.height !== h) { layer.width = w; layer.height = h; }
  const l = layer.getContext("2d")!;
  const rim = Math.max(3, T * 0.07);
  l.globalCompositeOperation = "source-over";
  l.clearRect(0, 0, w, h);
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    l.drawImage(gl, Math.cos(a) * rim, Math.sin(a) * rim);
  }
  l.globalCompositeOperation = "source-in";
  l.fillStyle = INK;
  l.fillRect(0, 0, w, h);
  ctx.save();
  ctx.globalAlpha = SHADE_ALPHA;
  ctx.drawImage(layer, Math.max(3, T * 0.045), Math.max(4, T * 0.055));
  ctx.restore();
  l.fillStyle = PHOTO;
  l.fillRect(0, 0, w, h);
  l.globalCompositeOperation = "source-over";
  ctx.drawImage(layer, 0, 0);
  ctx.drawImage(gl, 0, 0);
  return true;
}
