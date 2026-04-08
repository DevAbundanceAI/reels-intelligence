# Airtable Schema Setup

Create these 3 tables in your Airtable base. Field names must match exactly (case-sensitive).

---

## Table 1: Reels

| Field Name         | Field Type          | Notes |
|--------------------|---------------------|-------|
| Reel ID            | Single line text    | Primary unique ID — used for dedup |
| URL                | URL                 | Link to Instagram reel |
| Username           | Single line text    | Creator's IG handle |
| Creator            | Link to Creators    | Linked record |
| Caption            | Long text           | Full caption text |
| Transcript         | Long text           | Spoken transcript (from Apify) |
| Hashtags           | Long text           | Comma-separated |
| Hook               | Single line text    | Opening line (from Claude) |
| Audio              | Single line text    | Song/audio name |
| Views              | Number              | Integer |
| Likes              | Number              | Integer |
| Comments           | Number              | Integer |
| Shares             | Number              | Integer |
| Duration (s)       | Number              | Seconds |
| Engagement Score   | Number              | Decimal — e.g. 4.2350 |
| Like Ratio %       | Number              | Decimal |
| Comment Ratio %    | Number              | Decimal |
| Engagement Tier    | Single select       | Options: HIGH, MID, LOW |
| Main Topic         | Single line text    | From Claude |
| Topics             | Long text           | Comma-separated tags |
| Content Type       | Single select       | Educational, Story, Motivational, How-to, Rant, Case study, List, Q&A, Other |
| Key Points         | Long text           | Bullet points from Claude |
| Target Audience    | Single line text    | From Claude |
| Emotional Tone     | Single select       | Inspiring, Educational, Entertaining, Controversial, Vulnerable, Direct, Humorous |
| Hook Type          | Single select       | Contrarian, Question, Curiosity Gap, Pattern Interrupt, Confession, Direct Address, Statistic, Analogy, Other |
| Hook Category      | Single select       | Problem-Based, Belief-Shifting, Identity-Shifting, Fear-Based, Desire-Based, Clarity-Based |
| CTA Type           | Single select       | Comment, Link, Apply, Join, DM, Subscribe, None, Other |
| CTA Placement      | Single select       | Early, Mid, End, Multiple, None |
| AI Analyzed        | Checkbox            | **Token guard** — true only after Claude completes successfully |
| Analyzed At        | Date                | Date Claude analysis ran |
| Analysis Model     | Single line text    | e.g. claude-opus-4-5 — audit trail for model changes |
| Published At       | Date                | Date only |
| Scraped At         | Date                | Date only |

---

## Table 2: Creators

| Field Name    | Field Type        | Notes |
|---------------|-------------------|-------|
| Username      | Single line text  | Primary — unique IG handle |
| Display Name  | Single line text  | Human-readable name |
| Niche         | Single line text  | e.g. "Business / Sales" |
| Active        | Checkbox          | Uncheck to pause scraping |
| Last Scraped  | Date              | Auto-set on each run |
| Total Reels   | Count             | Count of linked Reels records |

---

## Table 3: Runs

| Field Name     | Field Type      | Notes |
|----------------|-----------------|-------|
| Run At         | Date            | Date of run |
| Creators Run   | Number          | How many creators processed |
| Reels Fetched  | Number          | Total reels scraped |
| Reels New      | Number          | New reels added (after dedup) |
| Errors         | Long text       | Error messages if any |
| Status         | Single select   | Options: Success, Partial, Failed |

---

## Useful Airtable Views to Set Up

### Reels table
- **Top Performers** — filter: `Engagement Tier = HIGH`, sort: `Engagement Score DESC`
- **By Creator** — group by `Username`, sort by `Published At DESC`
- **By Topic** — group by `Main Topic`
- **This Week** — filter: `Published At >= DATEADD(TODAY(), -7, 'days')`
- **Unanalyzed Queue** — filter: `AI Analyzed = false` — shows reels scraped but not yet analyzed (useful for debugging or manual re-runs)

### Single select options to pre-create
Create these in Airtable before first run so `typecast: true` maps correctly:

**Engagement Tier**: HIGH, MID, LOW
**Content Type**: Educational, Story, Motivational, How-to, Rant, Case study, List, Q&A, Other
**Emotional Tone**: Inspiring, Educational, Entertaining, Controversial, Vulnerable, Direct, Humorous
**Hook Type**: Contrarian, Question, Curiosity Gap, Pattern Interrupt, Confession, Direct Address, Statistic, Analogy, Other
**Hook Category**: Problem-Based, Belief-Shifting, Identity-Shifting, Fear-Based, Desire-Based, Clarity-Based
**CTA Type**: Comment, Link, Apply, Join, DM, Subscribe, None, Other
**CTA Placement**: Early, Mid, End, Multiple, None
**Status** (Runs table): Success, Partial, Failed
