// The clip's own sound: playing a reference clip with it, and recording it into the reveal keepsake.

/** Elements whose sound is kept off the speakers for now (see setAloud). */
const quiet = new WeakSet<HTMLMediaElement>();
/** The speaker side of an element routed through Web Audio (soundTrack): its gain turns the speakers on and off. */
const speakers = new WeakMap<HTMLMediaElement, GainNode>();

/**
 * Turns `media`'s sound on the speakers off (false) or back on (true). A recording made with soundTrack still gets
 * the sound. Online, only the host's laptop plays a recap aloud, so two laptops side by side do not play it twice.
 * Where the sound is not routed through Web Audio, the only way to keep it quiet is to mute it, so the recording
 * gets no sound then either.
 */
export function setAloud(media: HTMLMediaElement, aloud: boolean) {
  if (aloud) quiet.delete(media); else quiet.add(media);
  const gain = speakers.get(media);
  if (gain) gain.gain.value = aloud ? 1 : 0;
  else if (!aloud) media.muted = true;
}

/** Plays `media` with its sound. If the browser refuses sound (no click on the page yet), it plays muted instead. */
export async function playWithSound(media: HTMLMediaElement): Promise<void> {
  // Kept quiet and not routed (see setAloud): stay muted. Routed: unmuted, the speaker gain does the rest.
  media.muted = quiet.has(media) && !speakers.has(media);
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
    const speaker = audio.createGain();
    speaker.gain.value = quiet.has(media) ? 0 : 1;
    source.connect(speaker);
    speaker.connect(audio.destination);
    source.connect(tap);
    taps.set(media, tap);
    speakers.set(media, speaker);
    media.muted = false; // the speaker gain keeps it quiet now, and a muted element would record silence
    return tap.stream.getAudioTracks()[0] ?? null;
  } catch {
    return null;
  }
}
