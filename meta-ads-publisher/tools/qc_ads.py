#!/usr/bin/env python3
"""Stage 2 - QC.

Pure local checks against a scan plan produced by drive_scan.py. No API calls.
Every ad gets PASS/FAIL with issues tagged FAIL / WARN / INFO.

Usage:
  python tools/qc_ads.py --plan output/drive_scan_<brand>_<ts>.json
                         [--config config/brands.json]
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# HARD BLOCK LIST - previously banned ad accounts.
# Deliberately hardcoded in this tool (and again in build_meta.py), NOT in
# config: editing the config file alone can never un-block an account.
# ---------------------------------------------------------------------------
BLOCKED_ACCOUNTS = frozenset({
    # "act_1234567890",
})

MAX_IMAGE_BYTES = 30 * 1024 * 1024
MIN_IMAGE_DIMENSION = 600
MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024
RECOMMENDED_MAX_VIDEO_SECONDS = 60

# Meta's standard placement ratios, with tolerance.
STANDARD_RATIOS = {
    "1:1": 1.0,
    "4:5": 0.8,
    "9:16": 9 / 16,
    "16:9": 16 / 9,
    "1.91:1": 1.91,
}
RATIO_TOLERANCE = 0.03

# ---------------------------------------------------------------------------
# Compliance keyword banks.
# Built from real rejection/ban history in the health vertical. Extend these
# from your own vertical's rejections - the rules that matter are the ones
# that have actually burned you.
# ---------------------------------------------------------------------------
HEALTH_FAIL_PATTERNS = [
    (r"\b(lose|lost|drop(?:ped)?|shed)\s+\d+\s*(lbs?|pounds?|kilos?|kg)\b",
     "numeric weight-loss outcome claim"),
    (r"\b\d+\s*(lbs?|pounds?|kg)\s+in\s+\d+\s*(days?|weeks?|months?)\b",
     "numeric outcome claim with timeframe"),
    (r"\bguarantee[ds]?\b", "guarantee language"),
    (r"\bbefore\s*(and|&|/)?\s*after\b", "before/after phrasing"),
    (r"\bcure[sd]?\b", "cure claim"),
    (r"\bfda[\s-]*approved\b", "FDA-approved claim"),
    (r"\b(ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide|retatrutide"
     r"|phentermine|testosterone)\b",
     "prescription drug name"),
    (r"\b(obese|fat\s+(body|belly|arms|thighs)|hate\s+your\s+body"
     r"|embarrass(?:ing|ed)?\s+(body|weight)|ashamed\s+of)\b",
     "personal-attribute / shame language"),
]

TONE_WARN_PATTERNS = [
    (r"\b(melt|torch|blast|destroy)\b[^.!?\n]{0,40}\bfat\b", "aggressive fat-loss phrasing"),
    (r"\b(miracle|magic|breakthrough)\b", "miracle-cure tone"),
    (r"\binstant(ly)?\b", "instant-results tone"),
    (r"\bclinically\s+proven\b", "clinical claim - needs substantiation on file"),
    (r"\b(you\s+need\s+to|stop\s+being)\b", "personal-attribute adjacent phrasing"),
    (r"\b(no\s+diet|no\s+exercise|without\s+(dieting|working\s+out))\b",
     "effortless-results phrasing"),
]

COMPLIANCE_PROFILES = {
    # Health brands: the FAIL bank hard-fails, tone bank warns.
    "health_strict": {"fail": HEALTH_FAIL_PATTERNS, "warn": TONE_WARN_PATTERNS},
    # Lower-risk brands: everything is a soft tone WARN.
    "standard": {"fail": [], "warn": HEALTH_FAIL_PATTERNS + TONE_WARN_PATTERNS},
}

VALID_CTAS = {
    "LEARN_MORE", "SHOP_NOW", "SIGN_UP", "BOOK_TRAVEL", "GET_OFFER", "GET_QUOTE",
    "CONTACT_US", "APPLY_NOW", "SUBSCRIBE", "DOWNLOAD", "WATCH_MORE", "ORDER_NOW",
}


def issue(level, message):
    return {"level": level, "message": message}


def check_image(path, issues):
    size = path.stat().st_size
    if size > MAX_IMAGE_BYTES:
        issues.append(issue("FAIL", f"image is {size / 1e6:.1f}MB (max 30MB)"))
    try:
        from PIL import Image
    except ImportError:
        issues.append(issue("INFO", "Pillow not installed - dimensions not probed"))
        return
    try:
        with Image.open(path) as img:
            width, height = img.size
    except Exception as exc:
        issues.append(issue("FAIL", f"image could not be opened: {exc}"))
        return
    if min(width, height) < MIN_IMAGE_DIMENSION:
        issues.append(issue("FAIL", f"image is {width}x{height} (min side 600px)"))
    check_ratio(width, height, issues)


def check_video(path, issues):
    size = path.stat().st_size
    if size > MAX_VIDEO_BYTES:
        issues.append(issue("FAIL", f"video is {size / 1e9:.2f}GB (max 4GB)"))
    try:
        from moviepy.editor import VideoFileClip
    except ImportError:
        try:
            from moviepy import VideoFileClip  # moviepy >= 2.0
        except ImportError:
            issues.append(issue("INFO", "moviepy not installed - duration/ratio not probed"))
            return
    try:
        with VideoFileClip(str(path)) as clip:
            duration = clip.duration
            width, height = clip.size
    except Exception as exc:
        issues.append(issue("FAIL", f"video could not be opened: {exc}"))
        return
    if duration and duration > RECOMMENDED_MAX_VIDEO_SECONDS:
        issues.append(issue("WARN", f"video is {duration:.0f}s (≤60s recommended)"))
    check_ratio(width, height, issues)


def check_ratio(width, height, issues):
    if not width or not height:
        return
    ratio = width / height
    for label, target in STANDARD_RATIOS.items():
        if abs(ratio - target) / target <= RATIO_TOLERANCE:
            issues.append(issue("INFO", f"aspect ratio {width}x{height} ≈ {label}"))
            return
    issues.append(issue(
        "WARN",
        f"aspect ratio {width}x{height} ({ratio:.2f}) matches no standard Meta "
        "ratio (1:1, 4:5, 9:16, 16:9, 1.91:1) - may be cropped in placements",
    ))


def check_compliance(text, profile, issues):
    banks = COMPLIANCE_PROFILES.get(profile, COMPLIANCE_PROFILES["standard"])
    lowered = text.lower()
    for pattern, label in banks["fail"]:
        match = re.search(pattern, lowered)
        if match:
            issues.append(issue("FAIL", f"compliance: {label} ('{match.group(0)}')"))
    for pattern, label in banks["warn"]:
        match = re.search(pattern, lowered)
        if match:
            issues.append(issue("WARN", f"compliance: {label} ('{match.group(0)}')"))


def resolve_landing_page(ad, adset, campaign, brand):
    for source in (
        ad.get("copy") or {},
        adset.get("targeting_override") or {},
        campaign.get("settings") or {},
    ):
        link = source.get("link") or source.get("landing_page")
        if link:
            return link
    return brand.get("default_landing_page")


def qc_ad(ad, adset, campaign, brand):
    issues = []
    copy = ad.get("copy") or {}

    creative = ad.get("creative_file")
    if not creative or not Path(creative).exists():
        issues.append(issue("FAIL", "creative file missing on disk - rerun the scanner"))
    elif ad.get("creative_type") == "image":
        check_image(Path(creative), issues)
    else:
        check_video(Path(creative), issues)

    if not (copy.get("primary_text") or "").strip():
        issues.append(issue("FAIL", "no primary text (missing or empty copy sidecar)"))

    link = resolve_landing_page(ad, adset, campaign, brand)
    if not link:
        issues.append(issue(
            "FAIL",
            "no landing page resolvable (ad sidecar → _adset.json → _campaign.json "
            "→ brand default_landing_page all empty)",
        ))
    elif not re.match(r"^https?://", link):
        issues.append(issue("FAIL", f"landing page is not a valid URL: '{link}'"))

    cta = copy.get("cta")
    if cta and cta.upper() not in VALID_CTAS:
        issues.append(issue("WARN", f"unrecognized CTA '{cta}' - builder defaults to LEARN_MORE"))

    text_blob = " ".join(
        str(copy.get(field) or "")
        for field in ("primary_text", "headline", "description")
    )
    if text_blob.strip():
        check_compliance(
            text_blob, brand.get("compliance_profile", "standard"), issues
        )

    verdict = "FAIL" if any(i["level"] == "FAIL" for i in issues) else "PASS"
    return {
        "ad": ad["name"],
        "ad_set": adset["name"],
        "campaign": campaign["name"],
        "verdict": verdict,
        "resolved_link": link,
        "issues": issues,
    }


def qc_adset_structure(adset, results):
    n = len(adset.get("ads", []))
    if not 2 <= n <= 4:
        for r in results:
            if r["ad_set"] == adset["name"]:
                r["issues"].append(issue(
                    "WARN", f"ad set has {n} ad(s); 2-4 recommended for delivery"
                ))


def qc_targeting(adset, brand, results):
    merged = dict(brand.get("default_targeting") or {})
    merged.update(adset.get("targeting_override") or {})
    age_min = merged.get("age_min", 18)
    if age_min < 18:
        for r in results:
            if r["ad_set"] == adset["name"]:
                r["issues"].append(issue("FAIL", f"targeting age_min={age_min} (must be ≥ 18)"))
                r["verdict"] = "FAIL"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", required=True, help="scan JSON from drive_scan.py")
    parser.add_argument("--config", default=str(ROOT / "config" / "brands.json"))
    parser.add_argument("--output-dir", default=str(ROOT / "output"))
    args = parser.parse_args()

    plan = json.loads(Path(args.plan).read_text())
    config = json.loads(Path(args.config).read_text())
    brand_key = plan["brand"]
    brand = config.get("brands", {}).get(brand_key)
    if not brand:
        sys.exit(f"Brand '{brand_key}' not in config")

    account_id = brand.get("meta_ad_account_id", "")
    account_blocked = account_id in BLOCKED_ACCOUNTS

    results = []
    for campaign in plan["campaigns"]:
        for adset in campaign["ad_sets"]:
            adset_results = [qc_ad(ad, adset, campaign, brand) for ad in adset["ads"]]
            qc_adset_structure(adset, adset_results)
            qc_targeting(adset, brand, adset_results)
            results.extend(adset_results)

    passed = [r for r in results if r["verdict"] == "PASS"]
    failed = [r for r in results if r["verdict"] == "FAIL"]
    if account_blocked:
        gate = "BLOCKED"
    elif not failed and results:
        gate = "PASS"
    elif passed:
        gate = "PARTIAL"
    else:
        gate = "PARTIAL" if results else "PASS"

    report = {
        "brand": brand_key,
        "plan_file": str(args.plan),
        "qc_at": datetime.now(timezone.utc).isoformat(),
        "account_gate": gate,
        "account_blocked": account_blocked,
        "totals": {"ads": len(results), "pass": len(passed), "fail": len(failed)},
        "scan_warnings": plan.get("warnings", []),
        "results": results,
        "disclaimer": (
            "Keyword matching catches known-bad patterns; it does not replace "
            "human judgment or guarantee Meta's own review approves the ad."
        ),
    }

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    out_path = out_dir / f"qc_{brand_key}_{stamp}.json"
    out_path.write_text(json.dumps(report, indent=2))

    print(f"QC REPORT - brand: {brand_key}")
    print(f"Account gate: {gate}" + ("  ** ACCOUNT IS HARD-BLOCKED **" if account_blocked else ""))
    print(f"Ads: {len(results)}  PASS: {len(passed)}  FAIL: {len(failed)}\n")
    for r in results:
        print(f"[{r['verdict']}] {r['campaign']} / {r['ad_set']} / {r['ad']}")
        for i in r["issues"]:
            print(f"    {i['level']}: {i['message']}")
    if plan.get("warnings"):
        print(f"\nScan warnings carried forward ({len(plan['warnings'])}):")
        for w in plan["warnings"]:
            print(f"  - {w}")
    print(f"\nReport written to: {out_path}")

    if account_blocked:
        sys.exit(2)


if __name__ == "__main__":
    main()
