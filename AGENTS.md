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
