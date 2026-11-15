# Jester look: the parts to reuse

The scrapbook theatre look, as listed by Aaron's frontend agent and checked against `app/src/style.css` and `app/index.html` on main on Saturday night. Every part below exists today. How to use it: the "Design changes: one look" section of `AGENTS.md`.

## Layout and words

- **Screen:** `<section class="screen" id="screen-<name>" hidden>`, shown through `show("<name>")` in `app/src/ui/game.ts`, which sets `body[data-screen]`. One main action per screen. A row of buttons: `.row-actions`.
- **Headings:** `<div class="masking"><h2 class="tape">` (masking tape).
- **The Jester's lines:** `<div class="note-wrap"><p class="note">` (blue ballpoint on a torn scrap).
- **Small print:** `.typed` (typewriter). A quiet line under a block: `.aside`.
- **Errors:** `<p class="problem" role="alert" hidden>`.
- **Big moments:** `.wins`, filled by `letters(el, text, color?)` in `ui/game.ts` (cut-out letters). The whole word is also carried in hidden text for screen readers.
- **Read aloud but not shown:** `.vh`.
- **For the team only:** `.dev-only` shows only when `body.dev` is set, which is on a dev server or with `?dev=1`. `?dev=0` shows what a visitor sees.

## Buttons and choices

- **Main action:** `.btn.btn-main > .ticket > .ticket-text` (the yellow ticket). One per screen.
- **Secondary:** `.btn-quiet` (the paper tag). A text button: `.link`.
- **Small label:** `.chip`.
- **A choice card:** `.mode` with `role=radio`, inside `.modes-pick`. On the start screen only (`#screen-start`), `.mode` is one paper switch with two halves, and the picked mode's line shows under it in `#modeSays`.
- **Top bar:** `.tab-btn` inside `#gameNav`. Home is the tent, top left in the game. On the start screen, `.start-nav` holds the How to play paper tag in the top right corner; a Sound switch will join it there.

## Pictures and cards

- **A photo print:** `.print` (white border, hard shadow).
- **A clip card:** `.clip` with `.clip-pic`, `.clip-name`, `.clip-credit`, `.clip-hint`, `.clip-star`, `.clip-q`.
- **An illustrated step:** `.step` with `.step-pic`, as on How to play.
- **Tape strips:** `.washi.w-pink`, `.w-mint`, `.w-dots`.
- **The stage:** `.box`, the shoebox around any canvas or video. Copy the block from `screen-turn` or `screen-crown`.
- **Stage size:** each `*-wrap` is `(100dvh - budget) * 16 / 9 + 140px` wide, where the budget is the height of the heading and controls around it, so the main button stays on screen on a laptop. Budgets today: part 500, turn 360, reveal 460, crown 460.

## Forms

- `label.field > span + input`, with an optional `small`.
- `label.consent > input[type=checkbox] + span`.
- `.who`: a player name tag.

## Motion and characters

- **Loading:** any `<progress>` becomes the running jester bar through `jesterBars()`; `.jbar` is the result. Never style either by hand.
- **Are you sure:** `<dialog class="leave">`, the paper dialog.
- **A player's face on the 3D jester:** `new FaceJester(face, variantFor(i))` from `ui/faceJester.ts`. Animations: idle, dance, win, lose.
- **The host puppet:** `.puppet > .stick + .jester.jester-dance` (or `.jester-win`). The drum roll: `.drum`.

## Tokens (`:root` in `style.css`)

- **Colours:** `--kraft` (the desk), `--photo`, `--card`, `--wood`, `--ink`, `--pen` (the Jester's voice), `--stamp` (accent and errors), `--ticket` (main action), `--gold`, and `--p1` to `--p4` (player colours, matched to `variantFor`).
- **Type:** `--hand` (Gaegu, handwriting), `--type` (Special Elite, typewriter), `--sticker` (Titan One, big words).
- **Depth and motion:** `--shade`, `--lift`, `--ease`, `--grain`, `--gutter`.

## Never

- Colours, fonts, icons, gradients or shadows outside the tokens.
- Em dashes or emoji on screen. All caps.
- Hotlinked fonts or images: everything is bundled in `app/public`.
- A glossy app look: rounded cards, glass or blur. Things are paper, tape, stamps and tickets.
- A cartoon placeholder face; use a grey head and shoulders silhouette.
- Face photos never leave the device.
