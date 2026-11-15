# Jester look: the parts to reuse

The scrapbook theatre look, as listed by Aaron's frontend agent and checked against `app/src/style.css` and `app/index.html` on main on Saturday night. Every part below exists today. How to use it: the "Design changes: one look" section of `AGENTS.md`.

## Layout and words

- **Screen:** `<section class="screen" id="screen-<name>" hidden>`, shown through `show("<name>")` in `app/src/ui/game.ts`, which sets `body[data-screen]`. One main action per screen. A row of buttons: `.row-actions`.
- **Headings:** `<div class="masking"><h2 class="tape">` (masking tape).
- **The Jester's lines:** `<div class="note-wrap"><p class="note">` (blue ballpoint on a torn scrap).
- **Small print:** `.typed` (typewriter). A quiet line under a block: `.aside`.
- **Errors:** `<p class="problem" role="alert" hidden>`.
- **Big moments:** `.wins`, filled by `letters(el, text, color?)` in `ui/game.ts` (cut-out letters). The whole word is also carried in hidden text for screen readers. `.letters .word` groups the letters of one word, so a name wraps between words and never inside one.
- **Read aloud but not shown:** `.vh`.
- **For the team only:** `.dev-only` shows only when `body.dev` is set, which is on a dev server or with `?dev=1`. `?dev=0` shows what a visitor sees.

## Buttons and choices

- **Main action:** `.btn.btn-main > .ticket > .ticket-text` (the yellow ticket). One per screen.
- **Secondary:** `.btn-quiet` (the paper tag). A text button: `.link`.
- **Small label:** `.chip`.
- **A choice card:** `.mode` with `role=radio`, inside `.modes-pick`. On the start screen only (`#screen-start`), `.mode` is one paper switch with two halves, and the picked mode's line shows under it in `#modeSays`.
- **Top bar:** `.tab-btn` inside `#gameNav`. Home is the tent, top left in the game. `.side-nav` is fixed top right on every screen: it holds the Sound tag (`#soundToggle`, pressed when sound is on) and, on the start screen only, the How to play tag (`#howtoLink`).

## Pictures and cards

- **A photo print:** `.print` (white border, hard shadow).
- **A clip card:** `.clip` with `.clip-pic`, `.clip-name`, `.clip-credit`, `.clip-hint`, `.clip-star`, `.clip-q`.
- **The bank:** `.bank` is one row that scrolls sideways, each `.clip` snapping into place, so the Play ticket stays on screen however many clips there are. On phones a `.clip` is 68vw wide so the next card peeks in at the edge.
- **Your clip is in:** `#clipReady`, a note taped bottom left on laptops and at the top under the corner tags on phones; hidden during a turn.
- **Send in a clip:** `.send-invite` is the paper strip with a quiet tag under the start screen's ticket; it opens `#screen-submit`. On that screen `.rule-card.can` and `.rule-card.cannot` are the two taped cards with a list, and `.send-form` is the form card.
- **The wordmark:** `#crown-doodle` is one shared drawing of the crown; `.wordmark-crown` places it on the J, with its angle, place and size as CSS variables.
- **An illustrated step:** `.step` with `.step-pic`, as on How to play.
- **Tape strips:** `.washi.w-pink`, `.w-mint`, `.w-dots`.
- **The stage:** `.box`, the shoebox around any canvas or video. Copy the block from `screen-turn` or `screen-crown`.
- **Stage size:** each `*-wrap` is `(100dvh - budget) * 16 / 9 + 140px` wide, where the budget is the height of the heading and controls around it, so the main button stays on screen on a laptop. Budgets today: part 500, turn 360, reveal 460, crown 460.
- **Curtains:** `.drapes > .drape.l` and `.drape.r` close over a `.box` when it has `.closed`. Reveal and crowning only.
- **Between acts:** `.screen.leaving` and `.screen.arriving` are the fades from one screen to the next.
- **Framing hint:** `.framing-hint` on the turn stage, with `.late` when it can be clicked to start anyway.

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
- A bare common word as the class for a new style, such as `.lost`, `.won` or `.hidden`. Put a new feature's CSS on its element's id or on a prefixed class. A bare `.lost` for a notice once pulled every losing jester onto the winner at the crowning, because the crowning marks losing seats `.lost` too.
- A cartoon placeholder face; use a grey head and shoulders silhouette.
- A face picture or cutout leaves the laptop only when players choose it: live to the others in their online room (never saved), or in the results video they send. The room screen says so before anything is sent.
