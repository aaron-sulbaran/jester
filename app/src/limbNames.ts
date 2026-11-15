// Names for the engine's limb keys, said from the player's own side.
import { LIMBS, type Orientation } from "../../engine/src/index.ts";

/**
 * Limb keys use the clip performer's sides. A mirror copy puts the player's left where the performer's right
 * is, so the side words swap; a same-side copy (engine 0.11.0 orientation "same-side") keeps them.
 */
export function playerSideLabel(limb: string, orientation: Orientation = "mirror"): string {
  const label = LIMBS[limb]?.label ?? limb;
  if (orientation === "same-side") return label;
  return label.replace(/\b(left|right)\b/g, (m) => (m === "left" ? "right" : "left"));
}

/** "left thigh, right thigh and left shin", from the player's own side; all four leg parts read as "legs". */
export function listLabels(limbs: string[], orientation: Orientation = "mirror"): string {
  const legs = ["leftThigh", "rightThigh", "leftShin", "rightShin"];
  if (legs.every((l) => limbs.includes(l)) && limbs.every((l) => legs.includes(l))) return "legs";
  const labels = limbs.map((l) => playerSideLabel(l, orientation));
  return labels.length < 2 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
