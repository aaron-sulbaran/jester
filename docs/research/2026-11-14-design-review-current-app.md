# Design review: the current app (subtract pass)

2026-11-14, about 7:30 PM. Surface: `app/index.html` at 1440 x 900, before any look work. Ledger loaded (updated 2026-11-11, 46 lines).

## Verdict

It reads as a test bench, not a game, because every control the builders needed is on the player's screen at once: a file input, a "simulated player" checkbox, a wobble slider, a progress bar, a status line and a disabled start button, above two black canvases labelled "Clip" and "You". The first move is not restyling these; it is splitting them into a sequence of screens where each screen asks for one thing, and moving the test switches off the player's path.

## Findings

| P | Class | Pattern | Evidence | Ledger | Harm | Fix |
|---|---|---|---|---|---|---|
| P0 | defect | The clip is on screen during play | `#stage` shows the `Clip` canvas beside `You` | none | Blind mode's whole joke is that you never see the clip; this screen gives it away | Play screen shows only the camera and your part's outline |
| P1 | defect | One page holds the whole flow | `#setup`, `#stage`, `#results` all on one page | C1 | No sense of a game moving forward; nothing says what to do next | A screen per step: start, cast, play, reveal, results |
| P1 | slop | Test switches on the player's path | `#simPlayer`, `#noise`, scorer version in the status line | C5 | Looks like a lab; a judge sees a debug panel first | Keep them behind `?nocam=1` or a small dev toggle, off the main screens |
| P1 | defect | Native file input | `<input type="file">` reads "Choose File, No file chosen" | C28 | The browser's default control is the least game-like thing on screen | A drop zone or button that names what it does: "Upload a video" |
| P2 | slop | Default system font, one yellow button style for everything | `style.css` | C32 | Nothing says Jester; every button weighs the same, so nothing is the next step | A chosen face and one main action per screen |
| P2 | defect | Results are a table of limb bars | `#limbs` | none | Reads as a report; the moment should be the reveal and a rank | Lead with the reveal video and a ranked score per player; limb detail one tap away |
| P2 | defect | Status sentences carry the state | `#status` ("Pick a clip to start.", "Round over. Scorer 0.7.0.") | C46 | State hides in a line of small text | The screen itself changes; the Jester's line says what to do |

## The one move

Turn the single page into a sequence of full screens, so the play screen can show only you and your outline.

## Unknowns

Not checked with a real camera or a real uploaded clip; not checked at phone width (the app has no phone layout yet).
