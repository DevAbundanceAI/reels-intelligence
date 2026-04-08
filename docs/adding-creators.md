# Adding Creators

Edit `config/targets.json`. Each creator object:

```json
{
  "username": "alexhormozi",       // Instagram handle — no @
  "displayName": "Alex Hormozi",   // Human name for Airtable
  "niche": "Business / Sales",     // Free text — used for grouping
  "active": true,                  // false = skip on every run
  "reelsLimit": 20                 // How many reels to scrape per run
}
```

## Tips
- Set `reelsLimit: 5` for your first run on a new creator to test quickly
- Set `active: false` to pause without deleting the creator
- `reelsLimit` is overridden by `--limit` flag on CLI
- Dedup runs automatically — re-running a creator won't duplicate records
