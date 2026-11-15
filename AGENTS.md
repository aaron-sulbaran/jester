# Jester: agent rules

`<HUB>` below is your own clone of the team hub (github.com/aaron-sulbaran/hack-princeton-hub), usually beside this repo, for example `~/hack-princeton/hub`.

```text
Team hub rule (HackPrinceton, Nov 13 to 15, hacking ends Sun 8:30 AM Eastern). Our agents coordinate only through the hub repo at <HUB> (github.com/aaron-sulbaran/hack-princeton-hub). Its AGENTS.md is the contract. In every session, in any repo:
1. Start with `<HUB>/hub sync`, then `<HUB>/hub status`. Sync about every 15 minutes.
2. Before editing in the project repo, pulse the files you will touch: `<HUB>/hub pulse "<what and why>"`. It prints any overlap with a teammate; read `<HUB>/hub who`, then go ahead.
3. Post one line notes with a link as you go: `<HUB>/hub note "<what changed>" --ref <t-id>`. Push your branch early; merge your own PR when checks are green; pulse again.
4. Commit only as your person, never as a bot or a teammate; run `<HUB>/hub doctor` in each clone.
5. A lesson worth keeping goes in a small kb page: `<HUB>/hub learn kb/<slug>.md "<what changed>"`.
6. Once the project repo exists (its URL is in <HUB>/kb/project-repo.md), clone it beside the hub and run `node <HUB>/scripts/install-hooks.mjs <that clone>`.
```

## Design changes: one look

Approved by Aaron on Nov 14. It binds Aaron's sessions; for everyone else it is a request, and the hub rule "merge without waiting" still holds.

- **What counts:** anything a player, a judge or a reviewer sees: new screens or pages, on-screen wording, colours, type, icons, motion, layout, and the Devpost pictures.
- **Feature work keeps to logic.** Write plain markup with stable ids and reuse the parts that exist. The full list, with the colour and font tokens and what never to do, is `docs/design/look-parts.md`. Add no new colours, fonts or icons.
- **Something new to see?** Send a short design request: which screen, what it must show and do, which element ids the logic needs, and any sketch. Aaron's sessions send it to the lead session, which relays it to the frontend agent. Others can post `<HUB>/hub ask "Design request: <what>" --for aaron`.
- **Nothing waits.** Keep building on plain markup; the markup and styles in the scrapbook theatre look follow.
- **Review.** A pull request from one of Aaron's sessions that touches `app/index.html`, `app/src/style.css` or `app/src/ui/` gets the frontend agent's design review before it merges. After anyone else's merge, the frontend agent sweeps main and fixes what drifted.

The full page is `kb/jester-design-flow` on the hub.
