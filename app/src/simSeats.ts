// How differently each simulated seat plays, so a game the computer plays ends with a winner and losers instead of
// everyone tied at 100. By turn order, and the same every run, so checks stay repeatable.

/** Extra wobble in degrees for a person's role, on top of the wobble slider. About 100, 76, 57 and 37 on the demo dance. */
export const SEAT_WOBBLE = [0, 25, 35, 45] as const;

/** A share of the full effort for a role copied with a box (a thing, or one body part). */
export const SEAT_EFFORT = [1, 0.7, 0.5, 0.3] as const;

const at = <T>(list: readonly T[], seat: number) => list[Math.min(Math.max(0, Math.floor(seat)), list.length - 1)]!;

/** The extra wobble for the player in turn order `seat` (0 is first). */
export const seatWobble = (seat: number) => at(SEAT_WOBBLE, seat);

/** The share of effort for the player in turn order `seat` (0 is first). */
export const seatEffort = (seat: number) => at(SEAT_EFFORT, seat);
