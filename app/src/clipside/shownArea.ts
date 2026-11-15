// Which part of a canvas is actually on screen. A canvas shown with `object-fit: cover` in a box of another shape is
// cropped (the part screen on a phone shows only the middle of the guide canvas), and one CSS pixel is several canvas
// pixels; anything drawn for the player to read or tap, like the guide's corner card, has to sit in the shown part and
// be sized in CSS pixels. Assumes the default centred object-position.

export interface ShownArea {
  /** The shown part, in canvas pixels. */
  x: number; y: number; w: number; h: number;
  /** Canvas pixels per CSS pixel across and down. */
  sx: number; sy: number;
  /** The canvas point at the box's top left: canvas = off + css * s. */
  offX: number; offY: number;
}

/** For a `width` x `height` canvas shown in a `boxW` x `boxH` CSS box with the given object-fit. */
export function shownArea(width: number, height: number, boxW: number, boxH: number, fit: string): ShownArea {
  if (!(boxW > 0 && boxH > 0)) return { x: 0, y: 0, w: width, h: height, sx: 1, sy: 1, offX: 0, offY: 0 };
  let sx: number, sy: number;
  if (fit === "cover") sx = sy = 1 / Math.max(boxW / width, boxH / height);
  else if (fit === "contain" || fit === "scale-down") sx = sy = 1 / Math.min(boxW / width, boxH / height);
  else { sx = width / boxW; sy = height / boxH; }
  const offX = width / 2 - (boxW / 2) * sx, offY = height / 2 - (boxH / 2) * sy;
  const x = Math.max(0, offX), y = Math.max(0, offY);
  return { x, y, w: Math.min(width, offX + boxW * sx) - x, h: Math.min(height, offY + boxH * sy) - y, sx, sy, offX, offY };
}
