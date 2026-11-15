import type { Guide } from "./types.ts";

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth"];
const ordinal = (n: number): string => ORDINALS[n - 1] ?? `number ${n}`;

/**
 * The names for `count` people standing in a row, left to right as seen on screen: "the dancer" for one;
 * "the dancer on the left" and "on the right" at the ends, "in the middle" for the one in the centre of an
 * odd row, and "second from the left" (or right) in between. Lower case, so they read inside a sentence
 * ("was the dancer on the left").
 */
export function positionNames(count: number): string[] {
  if (count <= 0) return [];
  if (count === 1) return ["the dancer"];
  return Array.from({ length: count }, (_, k) => {
    if (k === 0) return "the dancer on the left";
    if (k === count - 1) return "the dancer on the right";
    if (count % 2 === 1 && k === (count - 1) / 2) return "the dancer in the middle";
    return k < count / 2 ? `the dancer ${ordinal(k + 1)} from the left` : `the dancer ${ordinal(count - k)} from the right`;
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
 * Copies of the guides with every person named by where they stand on screen (see `positionNames`),
 * from each one's mean box centre over the frames it is seen in. Ties, and anyone never seen, keep
 * their order in `guides` (unseen people go after the seen ones). Things keep their labels, and the
 * order of the guides does not change. Run it on guides that share one stretch of the clip.
 */
export function nameByPosition(guides: readonly Guide[]): Guide[] {
  const people = guides
    .map((guide, index) => ({ index, x: guide.subject.kind === "person" ? meanCentreX(guide) : null, person: guide.subject.kind === "person" }))
    .filter((p) => p.person)
    .sort((a, b) => (a.x ?? Infinity) - (b.x ?? Infinity) || a.index - b.index);
  const names = positionNames(people.length);
  const nameOf = new Map(people.map((p, k) => [p.index, names[k]!]));
  return guides.map((guide, index) => {
    const name = nameOf.get(index);
    return name === undefined ? guide : { ...guide, subject: { ...guide.subject, label: name } };
  });
}
