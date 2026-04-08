# Research Agent — Claude Code + Airtable MCP

## Purpose
This agent runs inside an interactive Claude Code session.
It uses the Airtable MCP to query stored reel data and Claude API to generate insights.

Claude Code + Airtable MCP together replace the need to write query code for research.
You can ask natural language questions about your data and Claude Code handles it.

## MCP Tools Used in This Agent

| Tool | Used for |
|---|---|
| `list_records_for_table` | Fetch reels, filter by creator/tier/date |
| `get_table_schema` | Verify field names before querying |
| `list_tables_for_base` | Confirm tables exist |

All reads. This agent never writes to Reels or Creators tables.

## Research Modes

### --mode gap (Content Gap Analysis)
What: Topics competitors post about that the creator has never covered.

Claude Code workflow:
1. MCP → fetch creator's topics from Reels table (AI Analyzed = true)
2. MCP → fetch all competitor topics from Reels table
3. Aggregate topic frequency + avg engagement for both sides
4. Claude API → identify hardGaps, weakSpots, opportunities, strengthsToDoubleDown
5. Save markdown report to reports/gap-{creator}-{date}.md

Output per gap:
- Topic name
- How many competitor reels cover it
- Which creators cover it
- Avg competitor engagement score
- Specific content opportunity with hook suggestion

### --mode trending (Trending Topics)
What: Topics gaining momentum in the last N days vs prior N days.

Claude Code workflow:
1. MCP → fetch reels from last N days (recent window)
2. MCP → fetch reels from N to 2N days ago (older window)
3. Build topic index for both: frequency, avg engagement, HIGH rate
4. Label each: rising / emerging (new) / declining / stable
5. Claude API → explain why each is trending and what fresh angle exists
6. Save to reports/trending-{date}.md

### --mode hooks (Hook Pattern Analysis)
What: Which hook structures produce HIGH engagement vs LOW.

Claude Code workflow:
1. MCP → fetch all reels with Hook field populated (AI Analyzed = true)
2. Split into HIGH tier bucket and LOW tier bucket
3. Claude API → winning patterns, avoid patterns, top opening phrases,
   hook type performance table, 5 fill-in-the-blank hook formulas
4. Save to reports/hooks-{creator}-{date}.md

### --mode compare (Competitor Comparison)
What: Head-to-head breakdown of two creators.

Claude Code workflow:
1. MCP → fetch all analyzed reels for Creator A
2. MCP → fetch all analyzed reels for Creator B
3. Compute locally: avg engagement, tier breakdown, top topics, content type mix
4. Claude API → engagement winner, topic overlap, each creator's edge,
   4 concrete recommendations for A, single best thing to steal from B
5. Save to reports/compare-{a}-vs-{b}-{date}.md

### --mode deep (Poppy Deep Analysis Protocol)
What: Full 5-prompt sequential deconstruction of one creator.

Claude Code workflow:
1. MCP → fetch all analyzed reels for creator
2. Run 5 sequential Claude API calls:
   - Prompt A: Hook analysis (type, category, patterns)
   - Prompt B: Title/caption analysis (structure, power words, templates)
   - Prompt C: Structure analysis (arc, CTA pattern, framework naming)
   - Prompt D: Engagement correlation (what combos produce HIGH)
   - Prompt E: Synthesis (formula, philosophy, templates, red flags)
3. Save to reports/deep-{creator}-{date}.md

Best with 20+ reels in Airtable for the creator.
Uses 5 Claude API calls — run on-demand only, not in daily scrape.

### --mode all
Runs: gap + trending + hooks + deep in sequence for one creator.

## Example Claude Code Prompts for Ad-Hoc Research

These go directly in Claude Code — no CLI needed:

```
Use the Airtable MCP to show me the top 10 reels by engagement score
for alexhormozi in the last 30 days. List the hook, topic, and score for each.
```

```
Use the Airtable MCP to find all HIGH tier reels that use a Contrarian hook type.
How many are there? Which creators use it most?
```

```
Use the Airtable MCP to count how many reels we have per creator
and when each was last scraped.
```

```
Run the gap analysis for alexhormozi and then summarize the top 3 opportunities
in plain language I can use for a content brief.
```

## Report Format
All reports are markdown saved to reports/.
Never overwrite — append -v2, -v3 if same date exists.

Structure:
- Header: creator, date, data window, reels analyzed
- Key findings by section
- Actionable recommendations
- Raw JSON at bottom (for Claude Code to re-read if needed)

## Notes for Claude Code
- Always use Airtable MCP for data reads — never write SQL or custom queries
- Always check AI Analyzed = true when filtering — unanalyzed reels have empty fields
- Batch Claude API calls where possible — one call per mode, not per reel
- If MCP returns 0 records: tell the user to run the scraper first for that creator
- Research is READ-ONLY — if you find yourself about to write to Reels table, stop
- Use claude-opus-4-5 for all research analysis — quality matters here
