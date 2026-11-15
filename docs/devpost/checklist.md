# Devpost checklist

Everything to paste and attach on Devpost, in order. The story is `docs/devpost/story.md`; its pictures live in `app/public/devpost/` and are served at `https://jester-pi.vercel.app/devpost/<name>.png` once this is merged and the site has rebuilt. A preview of the page is at `/devpost/preview.html` on the dev server or the live site.

Our submit target is **7:30 AM Sunday**; Devpost closes at 8:30 AM.

## 1. Before pasting

1. Merge the PR, wait for the live site to rebuild (about 3 minutes), then open these and check each one loads:
   - https://jester-pi.vercel.app/devpost/hero.png
   - https://jester-pi.vercel.app/devpost/heading-inspiration.png (and heading-what, heading-how, heading-stack, heading-challenges, heading-wins, heading-learned, heading-next)
   - https://jester-pi.vercel.app/devpost/track-entertainment.png
   - https://jester-pi.vercel.app/devpost/diagram-round.png and diagram-clip-to-guide.png
2. Open https://jester-pi.vercel.app/devpost/preview.html and read the story top to bottom.
3. Every line marked `[check]` (yellow in the preview) is one I could not confirm from the code. Confirm it, reword it or delete it, and remove the marker. There are 12.

## 2. The fields

| Devpost field | What goes in |
| --- | --- |
| Project name | Jester |
| Elevator pitch | the tagline below |
| About the project | all of `docs/devpost/story.md`, pasted as it is |
| Built with | the tags below, one at a time |
| Try it out | https://jester-pi.vercel.app and https://github.com/aaron-sulbaran/jester |
| Video demo link | the YouTube link (slot 0 below) |
| Image gallery | the six screenshots below, in order, each with its caption |
| Main track | Entertainment |
| Team | add Lisa Hadi and Alex Huang, so all three get prizes |

Also asked for on submission: each person's Discord username.

## Tagline

```text
Act out any clip. Get judged.
```

If the field wants more (it allows about 200 characters): "Any video becomes a party game: copy your secret part of a clip on the webcam, then watch the reveal with everyone on top."

## Built with

```text
typescript
vite
mediapipe
webcodecs
mediabunny
indexeddb
supabase
vercel
blender
python
```

## 3. Gallery

Devpost shows gallery pictures at 3 to 2. Capture at 1500 by 1000 (or 1800 by 1200): in Chrome, open DevTools, turn on the device toolbar and type the size, then "Capture screenshot" from its menu. Use a bank clip we are allowed to show, and real people at the camera. Nothing here is mocked: each slot is a real screen from a real round.

**0. Demo video (first in the gallery, as the Video demo link).** YouTube, 2 minutes at most. One full round with two or three people, from picking a clip to the crown, with the reveal as the payoff. Only clips we are allowed to show.

**1. Start screen.** The wordmark, the bank cards under their question marks, Blind picked.
Caption: "Pick a clip. In Blind mode nobody sees it until the end."

**2. Who's playing.** The cast screen with two or three names typed in.
Caption: "Two to four players, one laptop. Everyone gets a secret part."

**3. Pass the laptop.** The handover screen: one player's name in big stickers and "Everyone else, look away."
Caption: "Pass the laptop. Everyone else, look away."

**4. Your part.** A turn before the countdown: the stick figure or outline on the shoebox stage, with the whole body, hand, head and foot choices.
Caption: "Your part and nothing else: a stick figure for a person, an outline for a thing."

**5. Playing.** A real person mid-move: the part on the left, the camera on the right. Best with a big, readable pose.
Caption: "Copy it live. Your part on the left, you on the right."

**6. The reveal.** The "Your cast" part of the reveal video, with everyone's cutouts on the real clip and their names and scores. If the clip has a dog or a ball, use the moment that shows who played it.
Caption: "The reveal: everyone's cutout on the real clip. Surprise, you were the dog."

Spare if one slot does not come out well: the crown, with each player's face on a jester and the spotlight on the winner. Caption: "The crown. One jester wins."

## 4. Paste and check

1. Paste `story.md` into About the project. Use Devpost's preview tab.
2. Check that every picture shows. If one is missing, its address is wrong or the site has not rebuilt yet.
3. Check the Tech stack table. If Devpost does not draw it as a table, replace it with this list:

```text
- **Language and build:** TypeScript 5.7, Vite 6
- **Body tracking:** MediaPipe Tasks Vision 0.10.14: Pose Landmarker (lite, full), Hand Landmarker
- **Things in clips:** MediaPipe Object Detector with EfficientDet-Lite0
- **Video decoding:** Mediabunny on WebCodecs, with a video element fallback
- **Saved analyses:** IndexedDB, keyed by the file's SHA-256
- **Reveal video:** Canvas capture and MediaRecorder (WebM)
- **Clip submissions and rooms:** Supabase (Storage, a table, Realtime)
- **Hosting:** Vercel
- **The jester:** Blender 5.2, scripted in Python, rendered with EEVEE
- **Fonts:** Gaegu, Special Elite, Titan One (SIL Open Font License)
- **Tests:** Node's built-in test runner
```

4. The story is Markdown only on purpose: it is not confirmed that Devpost keeps raw HTML.
5. Main track: Entertainment. Do not tick any sponsor track unless that feature is in main: LangChain deep agents, Amazon's Best Practical AI Innovation and the Gemini API prize are not (no code uses them today).
6. Submit, then open the public project page once to see it as a judge will.

## Adding a track banner

If a sponsor track is confirmed and its feature is in main: add one line to `TRACKS` in `art/devpost/render.mjs`, for example `{ slug: "gemini", name: "Gemini API", kicker: "Special track", line: "Sponsored by Google" }`, run the renderer (below), and add a section to the story after the Entertainment one: the banner image, a `###` heading and three or four bullets. Sponsor names are text only, no logos.

## Rendering the pictures again

```bash
node art/devpost/render.mjs
```

It needs Playwright and its Chromium. If `playwright` is not installed where Node can find it, point at any copy with `PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs`. It renders every picture in `art/devpost/` to `app/public/devpost/`, warns about any file over 800 KB, and rebuilds `preview.html` from this folder.
