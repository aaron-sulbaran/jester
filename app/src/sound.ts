// The clip's own sound: playing a reference clip with it, and recording it into the reveal keepsake.

/** Plays `media` with its sound. If the browser refuses sound (no click on the page yet), it plays muted instead. */
export async function playWithSound(media: HTMLMediaElement): Promise<void> {
  media.muted = false;
  try {
    await media.play();
  } catch {
    media.muted = true;
    await media.play().catch(() => {});
  }
}

let audio: AudioContext | null = null;
const taps = new WeakMap<HTMLMediaElement, MediaStreamAudioDestinationNode>();

/**
 * The element's sound as a track to add to a recording, while it still plays through the speakers. Null when
 * the browser cannot (no Web Audio, or sound not allowed yet). The element's sound is routed through Web
 * Audio from the first call on, so it is only tapped once the audio context is running.
 */
export async function soundTrack(media: HTMLMediaElement): Promise<MediaStreamTrack | null> {
  const known = taps.get(media);
  if (known) return known.stream.getAudioTracks()[0] ?? null;
  try {
    audio ??= new AudioContext();
    if (audio.state !== "running") await audio.resume();
    if (audio.state !== "running") return null;
    const source = audio.createMediaElementSource(media);
    const tap = audio.createMediaStreamDestination();
    source.connect(audio.destination);
    source.connect(tap);
    taps.set(media, tap);
    return tap.stream.getAudioTracks()[0] ?? null;
  } catch {
    return null;
  }
}
