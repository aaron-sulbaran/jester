// The host: a canned line (feelText.ts) spoken by the browser's own speech at the drum roll, the crowning and the
// results. No network and no keys; a browser without speech stays quiet. It follows the game's sound switch
// (soundOn in sfx.ts). The clip's own sound is not touched.
//
// Off by default: the browser's voice sounds robotic. The announcer setting (settings.ts, #setVoice) turns it on,
// and `?host=1` in the address still does, to try a voice.

import { hostLine, type HostEvent } from "./feelText.ts";
import { soundOn } from "./sfx.ts";
import { announcerVoice } from "./settings.ts";

const speech = typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;

/** True when the announcer speaks with the browser's voice. The game's other sounds do not depend on it. */
const hostOn = () => announcerVoice() === "browser";

/** An English voice, a British one if there is one (it is a royal court, after all). */
function voice(): SpeechSynthesisVoice | null {
  const all = speech?.getVoices() ?? [];
  return all.find((v) => v.lang === "en-GB" && v.localService) ?? all.find((v) => v.lang === "en-GB")
    ?? all.find((v) => v.lang.startsWith("en") && v.localService) ?? all.find((v) => v.lang.startsWith("en")) ?? null;
}
// Some browsers list their voices only after asking once.
if (hostOn()) speech?.getVoices();

/** Says a line for `event`, cutting off any line still being said. */
export function say(event: HostEvent, vars: { winner?: string; title?: string } = {}) {
  if (!hostOn() || !speech || !soundOn()) return;
  try {
    speech.cancel();
    const u = new SpeechSynthesisUtterance(hostLine(event, vars));
    const v = voice();
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = 1.05;
    u.pitch = 1.15;
    speech.speak(u);
  } catch {
    // No speech here: the host just stays quiet.
  }
}
