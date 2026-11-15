/**
 * The desk's line when the every-minute chip is on but no bank folder is picked: the Chamberlain cannot start
 * then, because an approved clip is written into that folder. Null when the desk is not stuck that way.
 * `button` is the folder button's own label, so the line points at exactly what to click.
 */
export function folderWait(waiting: number, stuck: boolean, button: string): string | null {
  if (!stuck) return null;
  const label = button.includes('"') ? button : `"${button}"`;
  const clips = waiting === 0 ? "New clips wait" : waiting === 1 ? "1 clip is waiting" : `${waiting} clips are waiting`;
  return `Not reviewing yet: ${clips} for the bank folder. Click ${label} above to start.`;
}
