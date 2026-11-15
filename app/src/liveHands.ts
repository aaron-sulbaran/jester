// The newest fingers from the webcam tracker, for draw.ts to draw on the player's mirror view.
// Each hand: 21 points {x, y} normalized to the camera image (see FINGER_BONES in skeleton.mjs).
export const live: { hands: { label: string; landmarks: { x: number; y: number }[] }[]; at: number } = { hands: [], at: 0 };
