#!/usr/bin/env python3
"""Screenshot capture for before/after and build-from-scratch B-roll videos.
Real product, real screenshots — no synthetic/AI-generated imagery, since the
whole point is proof."""
from playwright.sync_api import sync_playwright
from pathlib import Path
import time

OUT = Path(__file__).parent / "shots"
OUT.mkdir(exist_ok=True)

SHOTS = [
    # --- ON-SITE Rentals: BEFORE (legacy WordPress, local static mirror) ---
    ("onsite-before-home", "file:///workspaces/codespaces-blank/on-site-rentals/client-assets/legacy-wordpress/site/on-site-rentals.com/index.html", 1440, 900, 2.5),
    ("onsite-before-rentals", "file:///workspaces/codespaces-blank/on-site-rentals/client-assets/legacy-wordpress/site/on-site-rentals.com/rentals/index.html", 1440, 900, 2.5),

    # --- ON-SITE Rentals: AFTER (live Astro storefront) ---
    ("onsite-after-home", "https://on-site-rentals.pages.dev/", 1440, 900, 2.5),
    ("onsite-after-rentals", "https://on-site-rentals.pages.dev/rentals/", 1440, 900, 2.5),
    ("onsite-after-quote", "https://on-site-rentals.pages.dev/quote", 1440, 900, 2.5),

    # --- SSA KPI dashboard: SAFE (aggregate) pages only — NEVER /closes or /appointments (real customer PII) ---
    ("ssa-overview", "https://ssa-kpi-warehouse.developer-8c7.workers.dev/", 1440, 900, 3.5),
    ("ssa-kpis", "https://ssa-kpi-warehouse.developer-8c7.workers.dev/kpis", 1440, 900, 3.5),
    ("ssa-monthly", "https://ssa-kpi-warehouse.developer-8c7.workers.dev/monthly", 1440, 900, 3.5),
    ("ssa-funnel", "https://ssa-kpi-warehouse.developer-8c7.workers.dev/funnel", 1440, 900, 3.5),
]

with sync_playwright() as p:
    browser = p.chromium.launch()
    for name, url, w, h, wait in SHOTS:
        page = browser.new_page(viewport={"width": w, "height": h})
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=25000)
            time.sleep(wait)
            out_path = OUT / f"{name}.png"
            page.screenshot(path=str(out_path))
            print(f"OK   {name}  <-  {url}")
        except Exception as e:
            print(f"FAIL {name}  <-  {url}  :: {e}")
        finally:
            page.close()
    browser.close()
