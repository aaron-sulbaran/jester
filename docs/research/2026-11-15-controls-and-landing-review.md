# Controls, landing and layout review (Nov 15, about 1 AM)

Aaron's ask: controls felt thin and added piecemeal (Home, restart, fast forward, add a player), the landing
was confusing (the two modes against the two clips), and margins, spacing and missing pieces needed a hard
look. Maybe a menu screen.

## How it was checked

- One full game with two simulated players on the live site (main at the time), every screen captured at
  1440 by 900, 1024 by 768 and 390 by 844, with the bottom edge of each screen's main control measured.
- The design review skill's rule check on the start screen at 390, 768 and 1440: every rule passes.
- Two independent reviewers, run separately and given the code, the screenshots, `docs/design/look-parts.md`,
  the hub's design flow page and a short list of the look's standards (no private vault material was sent):
  Codex (high reasoning) and Muse (muse-wonder-1.0). Neither saw the other's answer or this one.
- The design critique framework: first impression, usability, hierarchy, consistency, accessibility.

## Verdict

The look holds up everywhere; the problems were layout and flow, not style. The main action fell below the
fold on every laptop screen size that matters, the start screen showed the team's tools to visitors, and
two controls covered the picture. All of that is fixed in the pull request this note ships with.

## A menu screen: no

Codex, Muse and this review reached the same answer separately. Every control belongs beside the thing it
controls; a menu screen is one more screen between a judge and the game, and there are no general settings
to put in it yet. Instead the corners are fixed: Home (the tent) top left once a game starts, How to play
top right on the start screen. When the game's sounds get an on and off switch (`setSound` in `sfx.ts`,
asked for in the review of pull request 74), Sound joins How to play in that corner.

## Findings

| P | Where | What was wrong | Status |
| --- | --- | --- | --- |
| P1 | Start, 1440 by 900 and 1024 by 768 | Play was below the fold (bottom at 981 px on a 900 px screen; 949 on 768) | Fixed: 768 and 704 |
| P1 | Start, all | "The bank is empty. Add clips with the bank tool." and three testing links shown to visitors | Fixed: team only (dev server or `?dev=1`) |
| P1 | Start, all | Blind and Watch first were two paper cards just like the two clip cards | Fixed: one paper switch, the picked mode's line under it |
| P1 | Part, 1024 by 768 | The chips and Start fell off the bottom (820 px) | Fixed: 740 |
| P1 | Reveal and crowning, 1440 by 900 | Speed, skip and See the scores fell off the bottom | Fixed: 874 and 853 |
| P1 | Turn | The valance hung 16 px into the picture and covered heads (Lisa's QA) | Fixed: it ends where the picture starts |
| P1 | Turn | "Not ready? Start over" sat on the player's head | Fixed: on the box's top corner (phone: its bottom edge) |
| P1 | Handover, crowning, results | Cut-out names were read one letter at a time (Lisa's QA) | Fixed: hidden whole word inside each heading |
| P1 | Crowning | Home left without asking | Fixed: asks first, as mid-game |
| P1 | Cast, 390 | The name fields ran off the right edge | Fixed |
| P2 | Start and part, 390 | Sticky Play and Start bars covered a clip and the part chips | Fixed: removed |
| P2 | Results, 390 | The winner heading sat under the Home tent; jesters spilled over the names | Fixed (100 px top room from pull request 64; jesters sized to their column) |
| P2 | Reveal | "Speed:1x" lost its space | Fixed |
| P2 | Start | The start screen's mode buttons also caught clicks on the room's clip cards | Fixed |
| P2 | Reveal | "Skip to results" sets the speed to 16x and rewrites the speed label | Follow-up (Lisa's reveal controls) |
| P2 | Results, 1440 | Scores sit far from the names they belong to | Follow-up |
| P3 | How to play, 390 | Two and a half of four steps above the fold | Left as is |
| P3 | Turn | A thing's guide (the ball) is a small outline on a big stage | Follow-up for the guide work |

## Critique

- **First impression.** The wordmark and the Jester's note read first, which is right; then the switch,
  the two hidden clips and the yellow ticket, in the order they are used. Before, the bank tool note and
  the testing links were the last thing on the page and read as unfinished.
- **Usability.** One ticket per screen holds. Every screen's main control is now on screen at 1024 by 768
  and up without scrolling. Phones scroll, which is fine for a game played on a laptop.
- **Hierarchy.** Modes are a setting, clips are the choice, Play is the action: three weights now instead of
  four equal cards.
- **Consistency.** Corners carry navigation (Home left, How to play right); everything else sits under the
  stage it controls. Stage sizes come from one rule: the screen height minus what the screen puts around it.
- **Accessibility.** Names are read as words; the switch keeps each mode's line for screen readers; tap
  targets stay at 44 px or more; the leave check now covers the crowning.
- **What works.** The shoebox stage, the tape headings, the Jester's notes, the handover, the drum roll and
  the crowning in the spotlight: all three reviews said leave them alone.
