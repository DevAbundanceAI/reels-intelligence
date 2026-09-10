# linkedin-engine — Claude Code framework

Turns content Ryan Frost has already produced across his repos into
LinkedIn posts and carousels on HIS OWN personal profile, staged for
human review in the "Ryan Frost LinkedIn Engine" Airtable base
(appdbuuWKHcTikOaF), then published by a Trigger.dev worker via the
LinkedIn API directly (no Make, no Vista Social).

## Hard rules

- **Nothing publishes without `Status = Approved`.** That is the single
  gate. `Claim Check` and `Ready` are labels for the reviewer, not gates.
- **This engine (`generate-posts.js`, `render_deck.py`, `stage.js`,
  `run.js`) never publishes.** Only `publish-now.js` (CLI) and
  `trigger/linkedin-publish-post.ts` (the deployed worker) call the
  LinkedIn API, and both refuse any row that is not `Approved`.
- **DMs and connection requests are never automated.** Out of scope,
  permanently. This engine only schedules feed posts.
- **No em or en dashes, ever, in generated copy.** Enforced in the
  generation prompt (`buildSystemPrompt()`) and in `validate.js`.
- **Totals only, never `$/mo`. The price is never stated, in any form.**
  Every number must trace to a `Source Library` row's `Canonical Numbers`
  (see `validate.js`'s canonical-dollar whitelist).
- **Only `Claim Safety = Safe` sources feed generation** while Ryan is
  offline (`loadSources()` in `shared.js` filters on this by default).
  `Needs Ryan OK` rows are held; `Confidential never` rows never even
  carry their real content into this base.
- **Design lives in `render_deck.py`'s slide-type functions.** Claude
  only ever writes copy and picks slide types (`generate-posts.js`); it
  never chooses colors, fonts, or layout. A new look means a new template
  function, iterated with Ryan, then frozen.
- **This batch runs with zero CTAs.** No links, no "DM me", no hashtags.
  Enforced in `validate.js`'s CTA lexicon and hashtag-count checks.

## Flow

```
seed-sources.js   seed/sources.json + seed/rules.json -> Source Library + Voice & Rules (idempotent upsert)
generate-posts.js one plan item -> queue/post-<slug>.json or queue/deck-<slug>.json (Claude, validated, one retry)
render_deck.py    (carousels only) deck JSON -> output/<slug>/*.jpg + <slug>.pdf + manifest.json
stage.js          queue file -> a Posts row (Preview + Carousel PDF attached, Sources linked)
run.js            orchestrates generate -> render -> stage per plan item
publish-now.js    CLI: publish one Approved row now, or every Due row (--record / --due)
auth.js           LinkedIn OAuth round trip; prints a fresh 60-day token + person URN
```

Live publishing runs on Trigger.dev (`trigger/linkedin-publish-watch.ts`
every 15 minutes -> `trigger/linkedin-publish-post.ts` per due row),
sharing `src/linkedin/api.js`'s `publishRecord()` with `publish-now.js`
so the CLI and the deployed worker take the exact same code path.

## Airtable base

**"Ryan Frost LinkedIn Engine"** — `appdbuuWKHcTikOaF`, main Workspace
(`wsp4q0q7IoExUgZGP`). Three tables: `Posts` (the calendar/review gate),
`Source Library` (provenance + claim-safety tiering), `Voice & Rules`
(the generation prompt's content, editable without a redeploy). Field
descriptions on every field carry the operating gotchas — read them in
Airtable before assuming this doc is complete.

## Environment

New keys live in `src/config.js`'s "LinkedIn Engine" block (not mixed
into the reels-pipeline's `REQUIRED` list, so a missing LinkedIn key
never blocks the unrelated scraping pipeline from starting). Full list
and setup order: `linkedin-engine`'s section of the implementation plan
at `/home/codespace/.claude/plans/or-ryan-we-have-giggly-honey.md`
(Part D, the pre-departure checklist).

## Notes for Claude Code

- `render_deck.py` imports `content-engine/render_slides.py` as a library
  and monkey-patches `base_slide` / `draw_dots` at module scope (Python
  resolves those names against the module's own `__dict__` at call time,
  so this correctly re-skins every existing slide-type function without
  copying them). Do not fork the file wholesale — extend it the same way
  if a new slide type is needed.
- `src/airtable/xbase.js` is the cross-base client (any baseId, not just
  `AIRTABLE_BASE_ID`). `src/airtable/client.js` stays untouched — it is
  still what the deployed reels-scraping tasks use.
- `src/linkedin/api.js` is the only file that talks to `api.linkedin.com`.
  Both the CLI and the Trigger.dev worker import it; keep it that way so
  a publishing bug only needs fixing once.
