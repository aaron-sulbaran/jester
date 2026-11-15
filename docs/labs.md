# Lab pages

Each lab is a plain page beside the game in `app/` that tries one part on its own, so it can be checked by eye. They run on the dev server only (`make dev`, then `http://localhost:5173/<name>`); the build ships just `index.html` and `room.html`. Other notes link to these pages by name, so they stay where they are.

- `clip-lab.html`: runs the clip side on one video and draws what it found (people, skeletons, outlines, cuts), to check a guide by eye. URL switches are listed in `app/README.md`.
- `things-lab.html`: the same, with people and things together (a dog, a ball, a car), the way blind mode deals roles.
- `link-lab.html`: paste a YouTube, Shorts, TikTok or Reels link and grab the moves from the playing clip through tab capture. Desktop Chrome and Edge.
- `bank-lab.html`: adds clips to the video bank (finds the cast, checks the outlines, writes `index.json`, the poster and the guides).
- `duel-lab.html`: the competing mode by hand: a room, a clip, everyone plays, standings, the reveal, elimination rounds. Not in the main game yet.
- `eval-lab.html`: plays one tagged round at a time (nailed, stood still, seated, and so on) so the round log records a known case for `eval/`.
- `badge-lab.html`: the face badge on your own camera: your face, levelled, in the jester's cap and collar in every player colour. Nothing leaves the device.
- `bar-lab.html`: the jester loading bar, filling, held and done, to judge how it moves.

`room.html` is not a lab: it is the online room page that ships with the game.
