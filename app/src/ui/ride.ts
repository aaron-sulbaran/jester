// Surprise me's merry-go-round. When Play starts a surprise, the ride gets a push: it pulls back a little, is shoved,
// coasts round with friction, runs a few degrees past the picked photo and settles back; then the picked photo lifts
// toward you and gets the gold star. One set of curves drives the ring, each photo's bob (tied to the ring's angle,
// so the bobs slow and stop with it) and the lift. The cast table is in the hub's
// jester/research/2026-11-15-surprise-ride-cast.md.
//
// Blind never gives the clip away: every photo is the same question mark with no name. Normal shows the posters and
// names of the clips Surprise me draws from. A click, a tap, Escape, Enter or Space jumps to the landed frame;
// reduced motion shows only the landed frame.

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface RidePhoto {
  /** The clip's name, or "" in Blind. */
  name: string;
  /** The clip's poster, or null in Blind. */
  poster: string | null;
}

export interface Ride {
  /** Settles once the ride has landed and the landed frame has held a moment (at once after a skip). */
  landed: Promise<void>;
  /** Swaps the Jester's note, for a wait after landing. */
  say(text: string): void;
  /** Takes the ride away. */
  close(): void;
}

// Timings, in ms from the push. Pull back, then push and coast, then run past and settle back.
const PULL_MS = 240;
const COAST_MS = 2000;
const SETTLE_MS = 380;
const LIFT_MS = 420;
const HOLD_MS = 520;
const PULL_DEG = 10;
const PAST_DEG = 4;
/** How far each photo bobs on its pole, and how many bobs per turn of the ring. */
const BOB_PX = 7;
const BOBS_PER_TURN = 3;
/** The ring is seen from a little above. */
const TILT_DEG = -11;

/** A cubic bezier easing curve, as CSS writes it: x1, y1, x2, y2. */
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 24; i++) {
      t = (lo + hi) / 2;
      if (at(x1, x2, t) < x) lo = t; else hi = t;
    }
    return at(y1, y2, t);
  };
}
/** The push: starts from rest, builds fast, then a long coast that comes to rest with no jolt. */
const coast = bezier(0.3, 0, 0.12, 1);
const sine = (p: number) => 0.5 - Math.cos(Math.PI * Math.min(1, Math.max(0, p))) / 2;
const outBack = (p: number) => { const c = 1.4; const q = Math.min(1, Math.max(0, p)) - 1; return 1 + (c + 1) * q ** 3 + c * q * q; };

/**
 * Opens the ride over the start screen with `photos` round the ring and `pick` (an index into them) as the one it
 * lands on, then shows `note` in the Jester's hand as it settles.
 */
export function startRide(photos: RidePhoto[], pick: number, note: string): Ride {
  const ride = $("ride");
  const ring = $("rideRing");
  const noteEl = $("rideNote");
  const noteWrap = noteEl.parentElement as HTMLElement;
  const n = photos.length;
  const step = 360 / n;
  const cardW = parseFloat(getComputedStyle(ride.querySelector(".ride-stage")!).getPropertyValue("--card-w")) || 126;
  const radius = (n * (cardW + 26)) / (2 * Math.PI);

  ring.replaceChildren();
  const mast = document.createElement("span");
  mast.className = "ride-mast";
  ring.append(mast);
  const cards = photos.map((photo, i) => {
    const slot = document.createElement("div");
    slot.className = "ride-slot";
    slot.style.transform = `rotateY(${i * step}deg) translateZ(${radius.toFixed(1)}px)`;
    slot.innerHTML = `<span class="ride-pole"></span><div class="ride-card"><div class="ride-face"><span class="clip-pic"><span class="clip-q">?</span></span><span class="ride-name"></span></div><div class="ride-back"></div></div>`;
    if (photo.poster) {
      // The poster url comes from the bank, so it is set as an attribute rather than written into markup.
      const img = document.createElement("img");
      img.src = photo.poster;
      img.alt = "";
      slot.querySelector(".clip-pic")!.prepend(img);
    }
    slot.querySelector(".ride-name")!.textContent = photo.name;
    ring.append(slot);
    return slot.querySelector<HTMLElement>(".ride-card")!;
  });
  const star = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  star.setAttribute("class", "ride-star");
  star.setAttribute("aria-hidden", "true");
  star.innerHTML = `<use href="#star" />`;
  cards[pick]!.append(star);

  noteEl.textContent = note;
  noteWrap.style.opacity = "0";

  // The ring turns forward one to two full turns and stops with the picked photo at the front.
  const target = 360 + ((360 - ((pick * step) % 360)) % 360);
  const angleAt = (t: number) => {
    if (t < PULL_MS) return -PULL_DEG * sine(t / PULL_MS);
    if (t < PULL_MS + COAST_MS) return -PULL_DEG + (target + PAST_DEG + PULL_DEG) * coast((t - PULL_MS) / COAST_MS);
    return target + PAST_DEG - PAST_DEG * sine((t - PULL_MS - COAST_MS) / SETTLE_MS);
  };

  // The lift starts as the ride settles, not after it: the picked photo comes forward while the ring runs back.
  const liftAt = (t: number) => (t > PULL_MS + COAST_MS ? outBack((t - PULL_MS - COAST_MS) / LIFT_MS) : 0);
  const noteAt = (t: number) => Math.min(1, Math.max(0, (t - PULL_MS - COAST_MS) / 300));
  const cardAt = (t: number, i: number) => {
    const bob = BOB_PX * Math.sin(((angleAt(t) + i * step) * BOBS_PER_TURN * Math.PI) / 180);
    const l = i === pick ? liftAt(t) : 0;
    return `translateY(${(bob * (1 - Math.min(1, l))).toFixed(2)}px) translateZ(${(56 * l).toFixed(1)}px) scale(${(1 + 0.14 * l).toFixed(3)})`;
  };
  /** Sets one frame by hand: the first frame, or the landed one under reduced motion. */
  const draw = (t: number) => {
    ring.style.transform = `rotateX(${TILT_DEG}deg) rotateY(${angleAt(t).toFixed(2)}deg)`;
    // The mast always faces you, so it reads as a round pole from every side.
    mast.style.transform = `rotateY(${(-angleAt(t)).toFixed(2)}deg)`;
    cards.forEach((card, i) => { card.style.transform = cardAt(t, i); });
    star.style.transform = `scale(${Math.max(0, liftAt(t)).toFixed(3)})`;
    noteWrap.style.opacity = String(noteAt(t));
  };

  // The motion runs as Web Animations sampled from the curves above, not a requestAnimationFrame loop: loading the
  // clip's moves can hold the page's main thread for most of a second, and a transform animation keeps running
  // on the compositor through that, where a frame loop would freeze and then jump.
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const total = PULL_MS + COAST_MS + Math.max(SETTLE_MS, LIFT_MS);
  const samples = Math.ceil(total / 16);
  const frames = Array.from({ length: samples + 1 }, (_, k) => (k / samples) * total);
  const play = (el: Element, keyframes: Keyframe[]) => el.animate(keyframes, { duration: total, easing: "linear", fill: "forwards" });
  const keys = (style: (t: number) => Keyframe) => frames.map((t) => ({ ...style(t), offset: t / total }));
  const anims: Animation[] = [];
  const run = () => {
    anims.push(play(ring, keys((t) => ({ transform: `rotateX(${TILT_DEG}deg) rotateY(${angleAt(t).toFixed(2)}deg)` }))));
    anims.push(play(mast, keys((t) => ({ transform: `rotateY(${(-angleAt(t)).toFixed(2)}deg)` }))));
    cards.forEach((card, i) => anims.push(play(card, keys((t) => ({ transform: cardAt(t, i) })))));
    anims.push(play(star, keys((t) => ({ transform: `scale(${Math.max(0, liftAt(t)).toFixed(3)})` }))));
    anims.push(play(noteWrap, keys((t) => ({ opacity: String(noteAt(t)) }))));
  };

  let finish: () => void = () => {};
  const landed = new Promise<void>((resolve) => { finish = resolve; });
  let done = false;
  const land = (hold: number) => {
    if (done) return;
    done = true;
    for (const a of anims) a.finish();
    if (!anims.length) draw(total);
    setTimeout(finish, hold);
  };
  // Never locks input: any press jumps to the landed frame.
  const skip = () => land(0);
  const onKey = (e: KeyboardEvent) => { if (["Escape", "Enter", " "].includes(e.key)) { e.preventDefault(); skip(); } };
  ride.addEventListener("click", skip);
  document.addEventListener("keydown", onKey);

  ride.hidden = false;
  draw(still ? total : 0);
  // Opened on the next frame so the backdrop fades in rather than appearing.
  requestAnimationFrame(() => ride.classList.add("ride-open"));
  if (still) land(HOLD_MS + 300);
  else {
    run();
    void anims[0]!.finished.then(() => land(HOLD_MS), () => {});
  }

  return {
    landed,
    say: (text) => { noteEl.textContent = text; },
    close: () => {
      done = true;
      for (const a of anims) a.cancel();
      ride.removeEventListener("click", skip);
      document.removeEventListener("keydown", onKey);
      ride.classList.remove("ride-open");
      ride.hidden = true;
      ring.replaceChildren();
    },
  };
}
