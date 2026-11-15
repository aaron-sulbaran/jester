import { BODY_PARTS, type BodyPart } from "../../engine/src/index.ts";
import { thingObjectName } from "./things.ts";
import type { Guide } from "./types.ts";

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth"];
const ordinal = (n: number): string => ORDINALS[n - 1] ?? `number ${n}`;

/**
 * The names for `count` people standing in a row, left to right as seen on screen: "the person in the clip"
 * for one; "the person on the left" and "on the right" at the ends, "in the middle" for the one in the
 * centre of an odd row, and "second from the left" (or right) in between. Person, not dancer: clips are
 * squats and boxing too. Lower case, so they read inside a sentence ("was the person on the left").
 */
export function positionNames(count: number): string[] {
  if (count <= 0) return [];
  if (count === 1) return ["the person in the clip"];
  return Array.from({ length: count }, (_, k) => {
    if (k === 0) return "the person on the left";
    if (k === count - 1) return "the person on the right";
    if (count % 2 === 1 && k === (count - 1) / 2) return "the person in the middle";
    return k < count / 2 ? `the person ${ordinal(k + 1)} from the left` : `the person ${ordinal(count - k)} from the right`;
  });
}

/** Where a guide's subject stands across the clip: the mean centre x of its box over the frames it is seen in, or null if never seen. */
export function meanCentreX(guide: Guide): number | null {
  let sum = 0;
  let seen = 0;
  for (const frame of guide.boxTrack.frames) {
    if (!frame.box) continue;
    sum += frame.box.cx;
    seen++;
  }
  return seen === 0 ? null : sum / seen;
}

/**
 * Where a guide's subject stands for most of the clip: the median centre x of its box over the frames
 * it is seen in, or null if never seen. Unlike the mean, someone who steps across for a moment, or
 * swaps sides late in the clip, keeps the side they stand on most of the time.
 */
export function medianCentreX(guide: Guide): number | null {
  const xs = guide.boxTrack.frames.flatMap((frame) => (frame.box ? [frame.box.cx] : [])).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 === 1 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
}

/**
 * Copies of the guides with every person named by where they stand on screen (see `positionNames`),
 * from where each one stands for most of the clip (`medianCentreX`). Two people who swap sides are
 * named by the side each holds for longer. Ties, and anyone never seen, keep
 * their order in `guides` (unseen people go after the seen ones). Things keep their labels, and the
 * order of the guides does not change. Run it on guides that share one stretch of the clip.
 */
export function nameByPosition(guides: readonly Guide[]): Guide[] {
  const people = guides
    .map((guide, index) => ({ index, x: guide.subject.kind === "person" ? medianCentreX(guide) : null, person: guide.subject.kind === "person" }))
    .filter((p) => p.person)
    .sort((a, b) => (a.x ?? Infinity) - (b.x ?? Infinity) || a.index - b.index);
  const names = positionNames(people.length);
  const nameOf = new Map(people.map((p, k) => [p.index, names[k]!]));
  return guides.map((guide, index) => {
    const name = nameOf.get(index);
    return name === undefined ? guide : { ...guide, subject: { ...guide.subject, label: name } };
  });
}

/**
 * What a part is called inside a sentence, played with `part`: the subject's name for the whole body
 * ("the person on the left"); with a body part, the part first, so two "left"s do not collide ("the left
 * hand of the person on the left"). A thing is "the ball" (its label without the number, lower case), and
 * with a body part "the ball, with the left hand". Built here once; every screen that names a part uses it.
 */
export function partName(subject: Guide["subject"], part: BodyPart = "body"): string {
  const thing = thingObjectName(subject.label);
  const name = subject.kind === "person" ? subject.label : thing.startsWith("the ") ? thing : `the ${thing}`;
  if (part === "body") return name;
  const bodyPart = BODY_PARTS[part].label.toLowerCase();
  return subject.kind === "thing" ? `${name}, with the ${bodyPart}` : `the ${bodyPart} of ${name}`;
}
