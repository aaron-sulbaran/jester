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
- **Icons:** each control's picture is a `<symbol id="ico-…">` in the sprite inside `svg.defs` at the top of `app/index.html`, drawn in the Home tent's pen: a 4 px ink outline on a 48 grid, round joins, flat token fills. It goes before the words and never replaces them: `<svg class="ico" aria-hidden="true"><use href="#ico-back" /></svg>`. On a `.btn-quiet` the icon takes the punched hole's place (style.css does it); a tag without an icon keeps its hole. One meaning per picture: `tent` the start screen, `back` one step back, `again` do it again, `watch` watch it, `podium` the results, `speed`, `play`, `clapper` a new clip, `save`, `puppet` the computer plays, `cross` no or close, `check` yes, `player-add`, `player-less`, `howto`, `sound-on`, `sound-off`, `search`, `online`, `join` (a key for a room code), `copy`, `send`, `settings` (three sliders). A control that needs a new meaning gets a new symbol in the same pen, never a stock icon or emoji.
- **Top bar:** `.tab-btn` inside `#gameNav`. Home is the tent, top left in the game. `.side-nav` is fixed top right on every screen: it holds the Sound tag (`#soundToggle`, pressed when sound is on) and, on the start screen only, How to play (`#howtoLink`) and Settings (`#settingsOpen`).

## Pictures and cards

- **A photo print:** `.print` (white border, hard shadow).
- **A clip card:** `.clip` with `.clip-pic`, `.clip-name`, `.clip-credit`, `.clip-hint`, `.clip-star`, `.clip-q`.
- **The library (start screen):** `#bank` is a grid of small taped `.clip` photos that scrolls up and down. On a laptop `fitRows()` in `ui/game.ts` cuts it to whole rows and sets `#screen-start[data-library="fitted"]`; a phone keeps one sideways row. `#surpriseCard` is Surprise me, its own card, first and picked by default, with `#startOr` ("or") before the library. `.library-head` holds `#libraryTitle`, `#libraryCount`, `#libraryMore` ("Show bigger clips too") and the search (`label.field.library-find` with `#clipSearch`). `#libraryNone` is the "no clip" line. Blind cards show their performers as silhouettes on the card's tape colour.
- **The start screen's rows:** `.masthead` (wordmark, title note, `.start-how`), then the setup `#startMode`: `#countRow` ("How many are playing?", `[data-players]` chips), `#modeRow` ("Blind or Normal?") and, for 2 or more, `#howPick` ("How?": take turns, Duel, each on your own device). Each is a `.start-q` with `.start-ask`, `.start-pick` and its line in `.start-says` directly under its switch. Then the library, then `#startFoot`: the Play ticket in `#startActions` and two `.start-door` cards (`#playOnline` with `ico-online`, `#submitOpen` with `ico-send`).
- **Start screen motion:** `.home-drift > .drift-prop` are the floating stickers beside the title (laptop widths only). `.royal` is the jester jigging for a paper queen (`.royal-floor`, `.royal-throne` with `.royal-brow`, `.royal-jester`; laptop and tablet only). Both stop under `prefers-reduced-motion`, `body.calm` and `html[data-motion="calm"]`, and never show during a turn.
- **Settings:** `#screen-settings`, opened from `#settingsOpen` in `.side-nav`. `.set-grid` of `.set-card` (washi, an `h3` with its `.ico`, `.aside`). `.set-saved` is "What Jester saves", full width and first. Controls: `.set-row` with `.set-switch` (paper on/off), `.set-range` or `.set-select`. `#setRules` is copied from the Send in a clip screen's `#sendRules`, so the two never differ. The store is `app/src/settings.ts` (`#setSound`, `#setVolume`, `#setMotion`, `#setVoice`, `#setDev`).
- **The online room:** everything is under `.room-` classes and `#room…` ids: the code as letter stickers (`.room-code-card`), the QR on a taped print (`.room-qr`), each player as their jester with a name tag (`.room-seat`), the clip cards (`.room-pick`) and the chat on a notebook page (`.room-chat`). Logic: `app/src/ui/room.ts` (Lisa's lane).
- **Your clip is in:** `#clipReady`, a note taped bottom left on laptops and at the top under the corner tags on phones; hidden during a turn.
- **Send in a clip:** `.send-card` (`#submitOpen`) is a paper card in the Play row with `.send-card-name` and `.send-card-text`; it opens `#screen-submit`. The old `.send-invite` strip is gone.
- **The Send in a clip screen:** `#sendSteps` is a strip of four numbered steps, built like How to play's `.step`. Each picture is a desk scene made from `.send-step-card` (a clip card with the "?"), `.send-step-tag` (a paper tag with the name in pen), `.send-step-stamp` (the red "Let in" stamp) and `.send-step-jester` (the jester's win pose). `.send-form` is the one form card: `#submitTitle` ("Name your clip") and `#submitCredit` ("Your name (optional)", Anonymous as the placeholder) on the left; what not to send (`.send-dont`), the Anthropic line and the ticket on the right. Every rule for this screen sits under `#screen-submit`, `#sendSteps` or `#submitForm`; `.send-card` belongs to the start screen only.
- **The wordmark:** `#jester-hat` is one shared drawing of the jester's two-point hat; `.wordmark-hat` places it on the J, tuned by `--hat-x`, `--hat-y`, `--hat-w` and `--hat-r`. The letters' white edge is the `#die-cut-round` filter. The same hat is the stamp on every yellow ticket's stub and the favicon. The crown (`#crown-doodle`, `.wordmark-crown`) is gone.
- **An illustrated step:** `.step` with `.step-pic`, as on How to play.
- **Tape strips:** `.washi.w-pink`, `.w-mint`, `.w-dots`.
- **The stage:** `.box`, the shoebox around any canvas or video. Copy the block from `screen-turn` or `screen-crown`.
- **Stage size:** each `*-wrap` is `(100dvh - budget) * 16 / 9 + 140px` wide, where the budget is the height of the heading and controls around it, so the main button stays on screen on a laptop. Budgets today: part 500, turn 360, reveal 460, crown 460.
- **Curtains:** `.drapes > .drape.l` and `.drape.r` close over a `.box` when it has `.closed`. Reveal and crowning only.
- **Between acts:** `.screen.leaving` and `.screen.arriving` are the fades from one screen to the next.
- **Where to stand:** `#fitFrame` (`.fit-frame`) is the taped frame on the mirror view at the subject's place and size. `data-phase="framing"` is full strength while the player lines up, `data-phase="turn"` is faint during the turn, and `data-fit="good"` marks a good fit. Its logic is `app/src/fitFrame.ts`.
- **Framing hint:** `.framing-hint` on the turn stage, with `.late` when it can be tapped to start anyway ("Can't fit? Tap here to start.").

## Forms

- `label.field > span + input`, with an optional `small`.
- `label.consent > input[type=checkbox] + span`.
- `.who`: a player name tag. On the cast screen its dot is `button.who-dot` (44 px), which moves the player to the next jester colour nobody else is wearing.

## Motion and characters

- **Loading:** any `<progress>` becomes the running jester bar through `jesterBars()`; `.jbar` is the result. Never style either by hand.
- **Are you sure:** `<dialog class="leave">`, the paper dialog.
- **A player's face on the 3D jester:** `new FaceJester(face, variantFor(i))` from `ui/faceJester.ts`. Animations: idle, dance, win, lose.
- **The host puppet:** `.puppet > .stick + .jester.jester-dance` (or `.jester-win`). The drum roll: `.drum`.

## Tokens (`:root` in `style.css`)

- **Colours:** `--kraft` (the desk), `--photo`, `--card`, `--wood`, `--ink`, `--pen` (the Jester's voice), `--stamp` (accent and errors), `--ticket` (main action), `--gold`, and `--p1` to `--p4` (player colours, matched to `variantFor`).
- **Type:** `--hand` (Gaegu, handwriting), `--type` (Special Elite, typewriter), `--sticker` (Titan One, big words).
- **Depth and motion:** `--shade`, `--lift`, `--ease`, `--grain`, `--gutter`.

## Spacing

- **Spacing:** one scale, 8, 16, 24 and 32 px. A section break is a full step; decorations (tape, stars, shadows) never touch the next control. Measure gaps, do not eyeball them (taste ledger C49).

## Never

- Colours, fonts, icons, gradients or shadows outside the tokens.
- Em dashes or emoji on screen. All caps.
- Hotlinked fonts or images: everything is bundled in `app/public`.
- A glossy app look: rounded cards, glass or blur. Things are paper, tape, stamps and tickets.
- A bare common word as the class for a new style, such as `.lost`, `.won` or `.hidden`. Put a new feature's CSS on its element's id or on a prefixed class. A bare `.lost` for a notice once pulled every losing jester onto the winner at the crowning, because the crowning marks losing seats `.lost` too.
- A cartoon placeholder face; use a grey head and shoulders silhouette.
- A face picture or cutout leaves the laptop only when players choose it: live to the others in their online room (never saved), or in the results video they send. The room screen says so before anything is sent.
