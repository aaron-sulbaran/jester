# Jester look: the parts to reuse

The scrapbook theatre look, as listed by Aaron's frontend agent. Everything is on main in `app/index.html`, `app/src/style.css` and `app/src/ui/`. How to use it: the "Design changes: one look" section of `AGENTS.md`.

## Screens and text

- **Screen:** `<section class="screen" id="screen-x" hidden>`, shown through `show("x")` in `app/src/ui/game.ts`. One main action per screen. A row of buttons: `.row-actions`.
- **Headings:** `<div class="masking"><h2 class="tape">` (masking tape). Big moments: `.wins`, filled by `letters(el, text)` from `game.ts` (alphabet stickers).
- **The Jester's lines:** `<div class="note-wrap"><p class="note">` (blue ballpoint on a torn scrap).
- **Plain text:** `<p class="typed">`. Small print: `<p class="aside">`. Errors: `<p class="problem" role="alert">`.

## Buttons and choices

- **Main action:** `<button class="btn btn-main"><span class="ticket"><span class="ticket-text">` (a ticket stub).
- **Secondary:** `.btn.btn-quiet` (a punched paper tag).
- **Choices:** `.chip` with `aria-pressed`. A two-way choice as paper cards: `.mode` with `role=radio` and `aria-checked`.
- **Quiet text link:** `.link`. Top-left nav: `.tab-btn` (the circus tent Home).

## Cards, forms and the stage

- **Cards:** `.print` (white photo, hard shadow). A pickable taped photo: `.clip` with `.washi`, `.clip-pic`, `.clip-name`, `.clip-hint`. A numbered card: `.step`. Tape: `.washi.w-pink`, `.w-mint` or `.w-dots`.
- **Forms:** `.field` (label, input, small helper), `.consent` (a checkbox line), `.who` (a name row with a colour dot).
- **Stage:** the shoebox `.box`. Copy the block from `screen-turn` or `screen-crown`: `.board-wrap`, `.inside`, `.walls`, `.stage`, `.valance`, and the `.curtain.l` and `.curtain.r` pair.
- **Loading:** any `<progress>`; `jesterBars()` turns it into the running jester bar by itself.
- **Modals:** `<dialog class="leave">` holding `.note-wrap` and `.row-actions`.

## Jesters

- A player's face on the 3D jester: `new FaceJester(face, variantFor(i))` from `app/src/ui/faceJester.ts`.
- The host as a sticker puppet: `.puppet > .stick + .jester.jester-dance` (or `jester-win`). The drum: `.drum`.

## Tokens

- **Colours:** `--kraft`, `--photo`, `--ink`, `--pen` (the Jester's voice), `--stamp` (accent and errors), `--ticket` (main action), `--p1` to `--p4` (players).
- **Fonts:** `--hand` (Gaegu: headings and the Jester), `--type` (Special Elite: body and labels), `--sticker` (Titan One: big numbers and stickers).
- **Shadows:** `--shade` and `--lift`, hard offset only.

## Never

New colours, fonts or icons. Em dashes. Emoji. All caps. Soft blurred shadows. Plain rounded cards. A cartoon placeholder face (use a grey head and shoulders silhouette).
