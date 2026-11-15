// How a bank clip's cast reads on its card. Every subject is one player's role: people, and things such as a
// dog or a ball when the round includes them. Pure, so app/test/castWords.test.ts runs it under node.

/** Players a clip takes: its people, plus its things unless the round is played people only. */
export function playersFor(people: number, things: number, withThings = true): number {
  return people + (withThings ? things : 0);
}

/** "1 player", "3 players". */
export function playerLine(people: number, things: number, withThings = true): string {
  const n = playersFor(people, things, withThings);
  return `${n} ${n === 1 ? "player" : "players"}`;
}

/** The card's subtitle: the players and the length, for example "3 players, 15 s". */
export function castLine(people: number, things: number, durationMs: number, withThings = true): string {
  return `${playerLine(people, things, withThings)}, ${Math.round(durationMs / 1000)} s`;
}

/** Who sent it in: "Sent in by Lisa", or "Sent in by Anonymous" when no name was given. */
export function sentInBy(credit: string | null | undefined): string {
  const name = (credit ?? "").trim();
  // Clips let in before names were asked for carry the old placeholder: they read as anonymous too.
  return `Sent in by ${name && !/^sent in with submit your own$/i.test(name) ? name : "Anonymous"}`;
}
