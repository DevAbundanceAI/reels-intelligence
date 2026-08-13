#!/usr/bin/env python3
"""Stage 3 - Builder.

Creates campaigns, ad sets, and ads on Meta from a QC report - every object
PAUSED. Raw HTTP against graph.facebook.com; no SDK.

THIS TOOL CANNOT ACTIVATE ADS. There is no code path that sets status=ACTIVE.
Activation is a human-only action taken in Ads Manager.

Usage:
  python tools/build_meta.py --qc output/qc_<brand>_<ts>.json [--config ...]
  python tools/build_meta.py --qc ... --dry-run     # pre-flight: account reachable?
"""

import argparse
import json
import mimetypes
import os
import shutil
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent

API_VERSION = "v21.0"
GRAPH = f"https://graph.facebook.com/{API_VERSION}"

# The ONLY status this tool ever writes. Do not add ACTIVE - the entire safety
# model of this pipeline depends on activation being impossible here.
STATUS_PAUSED = "PAUSED"

# Hardcoded on purpose (mirrored in qc_ads.py): a config edit can never
# un-block a previously banned account.
BLOCKED_ACCOUNTS = frozenset({
    # "act_1234567890",
})

RETRYABLE_ERROR_CODES = {4, 17, 32, 613, 429}
RATE_LIMIT_SLEEP_SECONDS = 90
MAX_RETRIES = 5

FATAL_ERROR_CODES = {
    190: "access token expired or invalid - regenerate the System User token",
    80004: "app-level request quota exhausted - stop and retry later",
}

# Legacy objective names normalized to ODAX.
ODAX_MAP = {
    "LEAD_GENERATION": "OUTCOME_LEADS",
    "CONVERSIONS": "OUTCOME_SALES",
    "LINK_CLICKS": "OUTCOME_TRAFFIC",
    "TRAFFIC": "OUTCOME_TRAFFIC",
    "BRAND_AWARENESS": "OUTCOME_AWARENESS",
    "REACH": "OUTCOME_AWARENESS",
    "VIDEO_VIEWS": "OUTCOME_ENGAGEMENT",
    "POST_ENGAGEMENT": "OUTCOME_ENGAGEMENT",
    "APP_INSTALLS": "OUTCOME_APP_PROMOTION",
}
ODAX_OBJECTIVES = {
    "OUTCOME_LEADS", "OUTCOME_SALES", "OUTCOME_TRAFFIC",
    "OUTCOME_AWARENESS", "OUTCOME_ENGAGEMENT", "OUTCOME_APP_PROMOTION",
}

MAGIC_BYTES = [
    (b"\x89PNG\r\n\x1a\n", ".png", "image/png"),
    (b"\xff\xd8\xff", ".jpg", "image/jpeg"),
    (b"GIF87a", ".gif", "image/gif"),
    (b"GIF89a", ".gif", "image/gif"),
]

VALID_CTAS = {
    "LEARN_MORE", "SHOP_NOW", "SIGN_UP", "BOOK_TRAVEL", "GET_OFFER", "GET_QUOTE",
    "CONTACT_US", "APPLY_NOW", "SUBSCRIBE", "DOWNLOAD", "WATCH_MORE", "ORDER_NOW",
}

VIDEO_READY_TIMEOUT_SECONDS = 600
VIDEO_POLL_INTERVAL_SECONDS = 10


def load_env(path):
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = value


class MetaAPIError(Exception):
    def __init__(self, code, subcode, message):
        self.code, self.subcode = code, subcode
        super().__init__(message)


class MetaClient:
    def __init__(self, token):
        self.token = token
        self.session = requests.Session()

    def call(self, method, path, params=None, files=None):
        params = dict(params or {})
        params["access_token"] = self.token
        url = f"{GRAPH}/{path.lstrip('/')}"
        for attempt in range(MAX_RETRIES + 1):
            if method == "GET":
                resp = self.session.get(url, params=params, timeout=300)
            else:
                resp = self.session.post(url, data=params, files=files, timeout=600)
            try:
                body = resp.json()
            except ValueError:
                body = {"error": {"message": resp.text[:500], "code": resp.status_code}}
            if resp.ok and "error" not in body:
                return body
            err = body.get("error", {})
            code = err.get("code")
            if code in FATAL_ERROR_CODES:
                sys.exit(f"FATAL Meta error {code}: {FATAL_ERROR_CODES[code]}\n"
                         f"  {err.get('message')}")
            if (code in RETRYABLE_ERROR_CODES or resp.status_code == 429) and attempt < MAX_RETRIES:
                print(f"  rate limited (code {code}); sleeping "
                      f"{RATE_LIMIT_SLEEP_SECONDS}s (attempt {attempt + 1}/{MAX_RETRIES}) ...")
                time.sleep(RATE_LIMIT_SLEEP_SECONDS)
                continue
            raise MetaAPIError(code, err.get("error_subcode"),
                               f"{method} /{path}: {err.get('message')} "
                               f"(code {code}, subcode {err.get('error_subcode')})")
        raise MetaAPIError(None, None, f"{method} /{path}: retries exhausted")

    def get_all(self, path, params):
        """Paged GET."""
        rows, after = [], None
        while True:
            page_params = dict(params)
            if after:
                page_params["after"] = after
            body = self.call("GET", path, page_params)
            rows.extend(body.get("data", []))
            after = body.get("paging", {}).get("cursors", {}).get("after")
            if not after or not body.get("paging", {}).get("next"):
                return rows


def sniff_and_fix_extension(path):
    """Meta rejects images whose extension contradicts their bytes.

    Returns a path whose extension matches the sniffed type (a temp copy if a
    fix was needed) plus the mimetype.
    """
    path = Path(path)
    with open(path, "rb") as fh:
        head = fh.read(16)
    for magic, ext, mime in MAGIC_BYTES:
        if head.startswith(magic):
            if path.suffix.lower() in (ext, ".jpeg" if ext == ".jpg" else ext):
                return path, mime
            fixed = Path(tempfile.gettempdir()) / (path.stem + ext)
            shutil.copyfile(path, fixed)
            print(f"  fixed extension: {path.name} is really {ext} - uploading as {fixed.name}")
            return fixed, mime
    return path, mimetypes.guess_type(str(path))[0] or "application/octet-stream"


def normalize_objective(objective):
    objective = (objective or "OUTCOME_LEADS").upper()
    objective = ODAX_MAP.get(objective, objective)
    if objective not in ODAX_OBJECTIVES:
        sys.exit(f"Unknown objective '{objective}'. Valid: {sorted(ODAX_OBJECTIVES)}")
    return objective


def find_by_name(rows, name):
    return next((r for r in rows if r.get("name") == name), None)


class Builder:
    def __init__(self, client, brand, account_id):
        self.client = client
        self.brand = brand
        self.account = account_id
        self.created = []       # (kind, id, name) for read-back
        self.reused = []

    # -- idempotent ensure_* helpers ---------------------------------------

    def ensure_campaign(self, name, objective, daily_budget_cents):
        existing = self.client.get_all(
            f"{self.account}/campaigns", {"fields": "id,name,status", "limit": 200})
        hit = find_by_name(existing, name)
        if hit:
            print(f"  campaign exists, reusing: {name} ({hit['id']})")
            self.reused.append(("campaign", hit["id"], name))
            return hit["id"]
        body = self.client.call("POST", f"{self.account}/campaigns", {
            "name": name,
            "objective": objective,
            "status": STATUS_PAUSED,
            "special_ad_categories": json.dumps(
                self.brand.get("special_ad_categories", [])),
        })
        self.created.append(("campaign", body["id"], name))
        print(f"  created campaign PAUSED: {name} ({body['id']})")
        return body["id"]

    def ensure_adset(self, name, campaign_id, targeting, daily_budget_cents, link):
        existing = self.client.get_all(
            f"{self.account}/adsets",
            {"fields": "id,name,status,campaign_id", "limit": 200})
        hit = next((r for r in existing
                    if r.get("name") == name and r.get("campaign_id") == campaign_id), None)
        if hit:
            print(f"  ad set exists, reusing: {name} ({hit['id']})")
            self.reused.append(("adset", hit["id"], name))
            return hit["id"]
        promoted_object = {"page_id": self.brand["meta_page_id"]}
        if self.brand.get("pixel_id"):
            promoted_object.update({
                "pixel_id": self.brand["pixel_id"],
                "custom_event_type": "LEAD",
            })
        params = {
            "name": name,
            "campaign_id": campaign_id,
            "status": STATUS_PAUSED,
            "daily_budget": daily_budget_cents,
            "billing_event": "IMPRESSIONS",
            "optimization_goal": self.brand.get(
                "optimization_goal",
                "OFFSITE_CONVERSIONS" if self.brand.get("pixel_id") else "LINK_CLICKS"),
            "bid_strategy": "LOWEST_COST_WITHOUT_CAP",
            "targeting": json.dumps(targeting),
            "promoted_object": json.dumps(promoted_object),
        }
        # EU DSA transparency fields.
        if self.brand.get("dsa_beneficiary"):
            params["dsa_beneficiary"] = self.brand["dsa_beneficiary"]
            params["dsa_payor"] = self.brand.get(
                "dsa_payor", self.brand["dsa_beneficiary"])
        body = self.client.call("POST", f"{self.account}/adsets", params)
        self.created.append(("adset", body["id"], name))
        print(f"  created ad set PAUSED: {name} ({body['id']})")
        return body["id"]

    # -- creative upload ----------------------------------------------------

    def upload_image(self, path):
        path, mime = sniff_and_fix_extension(path)
        with open(path, "rb") as fh:
            body = self.client.call(
                "POST", f"{self.account}/adimages",
                files={"file": (path.name, fh, mime)})
        images = body.get("images", {})
        first = next(iter(images.values()), {})
        image_hash = first.get("hash")
        if not image_hash:
            raise MetaAPIError(None, None, f"adimages returned no hash for {path.name}")
        return image_hash

    def upload_video(self, path):
        path = Path(path)
        with open(path, "rb") as fh:
            body = self.client.call(
                "POST", f"{self.account}/advideos",
                files={"source": (path.name, fh, "video/mp4")})
        video_id = body["id"]
        print(f"  video uploaded ({video_id}); waiting for processing ...")
        deadline = time.time() + VIDEO_READY_TIMEOUT_SECONDS
        while time.time() < deadline:
            status = self.client.call("GET", video_id, {"fields": "status"})
            state = status.get("status", {}).get("video_status")
            if state == "ready":
                break
            if state == "error":
                raise MetaAPIError(None, None, f"video {video_id} failed processing")
            time.sleep(VIDEO_POLL_INTERVAL_SECONDS)
        else:
            raise MetaAPIError(None, None, f"video {video_id} not ready after "
                               f"{VIDEO_READY_TIMEOUT_SECONDS}s")
        thumbs = self.client.call("GET", f"{video_id}/thumbnails", {}).get("data", [])
        preferred = next((t for t in thumbs if t.get("is_preferred")), thumbs[0] if thumbs else None)
        return video_id, (preferred or {}).get("uri")

    def create_creative(self, ad, link):
        copy = ad.get("copy") or {}
        cta_type = (copy.get("cta") or "LEARN_MORE").upper()
        if cta_type not in VALID_CTAS:
            cta_type = "LEARN_MORE"
        cta = {"type": cta_type, "value": {"link": link}}
        story = {"page_id": self.brand["meta_page_id"]}
        if self.brand.get("instagram_account_id"):
            story["instagram_actor_id"] = self.brand["instagram_account_id"]

        if ad["creative_type"] == "image":
            image_hash = self.upload_image(ad["creative_file"])
            story["link_data"] = {
                "link": link,
                "message": copy.get("primary_text", ""),
                "name": copy.get("headline", ""),
                "description": copy.get("description", ""),
                "image_hash": image_hash,
                "call_to_action": cta,
            }
        else:
            video_id, thumbnail = self.upload_video(ad["creative_file"])
            video_data = {
                "video_id": video_id,
                "message": copy.get("primary_text", ""),
                "title": copy.get("headline", ""),
                "link_description": copy.get("description", ""),
                "call_to_action": cta,
            }
            if thumbnail:
                video_data["image_url"] = thumbnail
            story["video_data"] = video_data

        body = self.client.call("POST", f"{self.account}/adcreatives", {
            "name": f"{ad['name']} creative",
            "object_story_spec": json.dumps(story),
        })
        return body["id"]

    def ensure_ad(self, name, adset_id, creative_id):
        existing = self.client.get_all(
            f"{self.account}/ads", {"fields": "id,name,status,adset_id", "limit": 200})
        hit = next((r for r in existing
                    if r.get("name") == name and r.get("adset_id") == adset_id), None)
        if hit:
            print(f"  ad exists, reusing: {name} ({hit['id']})")
            self.reused.append(("ad", hit["id"], name))
            return hit["id"]
        body = self.client.call("POST", f"{self.account}/ads", {
            "name": name,
            "adset_id": adset_id,
            "creative": json.dumps({"creative_id": creative_id}),
            "status": STATUS_PAUSED,
        })
        self.created.append(("ad", body["id"], name))
        print(f"  created ad PAUSED: {name} ({body['id']})")
        return body["id"]

    # -- read-back verification ----------------------------------------------

    def verify_all_paused(self):
        """Never trust the create response alone: GET every object we touched
        and confirm it really exists and is PAUSED."""
        problems = []
        for kind, obj_id, name in self.created + self.reused:
            try:
                body = self.client.call(
                    "GET", obj_id, {"fields": "id,name,status,effective_status"})
            except MetaAPIError as exc:
                problems.append(f"{kind} '{name}' ({obj_id}): read-back failed - {exc}")
                continue
            if body.get("status") != STATUS_PAUSED:
                problems.append(
                    f"{kind} '{name}' ({obj_id}): status is "
                    f"'{body.get('status')}', expected PAUSED")
        return problems


def merge_targeting(brand, adset):
    merged = dict(brand.get("default_targeting") or {})
    override = adset.get("targeting_override") or {}
    merged.update({k: v for k, v in override.items()
                   if k not in ("link", "landing_page")})
    merged.setdefault("age_min", 18)
    merged["age_min"] = max(18, int(merged["age_min"]))
    return merged


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--qc", required=True, help="QC report JSON from qc_ads.py")
    parser.add_argument("--config", default=str(ROOT / "config" / "brands.json"))
    parser.add_argument("--output-dir", default=str(ROOT / "output"))
    parser.add_argument("--dry-run", action="store_true",
                        help="only verify the ad account is reachable, then exit")
    args = parser.parse_args()

    load_env(ROOT / ".env")
    load_env(ROOT.parent / ".env")

    qc = json.loads(Path(args.qc).read_text())
    config = json.loads(Path(args.config).read_text())
    brand_key = qc["brand"]
    brand = config.get("brands", {}).get(brand_key)
    if not brand:
        sys.exit(f"Brand '{brand_key}' not in config")

    account = brand.get("meta_ad_account_id", "")
    if not account:
        sys.exit(f"REFUSING TO BUILD: brand '{brand_key}' has no meta_ad_account_id")
    if account in BLOCKED_ACCOUNTS:
        sys.exit(f"REFUSING TO BUILD: account {account} is hard-blocked in this tool")
    if not brand.get("meta_page_id"):
        sys.exit(f"REFUSING TO BUILD: brand '{brand_key}' has no meta_page_id")
    if qc.get("account_gate") == "BLOCKED":
        sys.exit("REFUSING TO BUILD: QC report gate is BLOCKED")

    token_env = brand.get("token_env", "META_ACCESS_TOKEN")
    token = os.environ.get(token_env)
    if not token:
        sys.exit(f"No token: set {token_env} in .env")

    client = MetaClient(token)

    if args.dry_run:
        body = client.call("GET", account, {"fields": "id,name,account_status"})
        print(f"DRY RUN OK - account reachable: {body.get('name')} "
              f"({body.get('id')}), account_status={body.get('account_status')}")
        return

    plan = json.loads(Path(qc["plan_file"]).read_text())
    passing = {(r["campaign"], r["ad_set"], r["ad"]): r
               for r in qc["results"] if r["verdict"] == "PASS"}
    skipped = [r for r in qc["results"] if r["verdict"] != "PASS"]
    if skipped:
        print(f"Skipping {len(skipped)} ad(s) that did not PASS QC:")
        for r in skipped:
            print(f"  - {r['campaign']} / {r['ad_set']} / {r['ad']}")
    if not passing:
        sys.exit("Nothing to build: no ads passed QC.")

    builder = Builder(client, brand, account)
    built, errors = [], []

    for campaign in plan["campaigns"]:
        wanted_sets = [a for a in campaign["ad_sets"]
                       if any((campaign["name"], a["name"], ad["name"]) in passing
                              for ad in a["ads"])]
        if not wanted_sets:
            continue
        settings = campaign.get("settings") or {}
        objective = normalize_objective(
            settings.get("objective") or brand.get("default_objective"))
        budget = int(settings.get("daily_budget")
                     or brand.get("default_daily_budget", 2000))
        print(f"\ncampaign: {campaign['name']} ({objective}, {budget}c/day)")
        try:
            campaign_id = builder.ensure_campaign(campaign["name"], objective, budget)
        except MetaAPIError as exc:
            errors.append(str(exc))
            continue
        for adset in wanted_sets:
            targeting = merge_targeting(brand, adset)
            wanted_ads = [ad for ad in adset["ads"]
                          if (campaign["name"], adset["name"], ad["name"]) in passing]
            link = passing[(campaign["name"], adset["name"], wanted_ads[0]["name"])
                           ]["resolved_link"]
            try:
                adset_id = builder.ensure_adset(
                    adset["name"], campaign_id, targeting, budget, link)
            except MetaAPIError as exc:
                errors.append(str(exc))
                continue
            for ad in wanted_ads:
                ad_link = passing[(campaign["name"], adset["name"], ad["name"])
                                  ]["resolved_link"]
                try:
                    creative_id = builder.create_creative(ad, ad_link)
                    ad_id = builder.ensure_ad(ad["name"], adset_id, creative_id)
                    built.append({"campaign": campaign["name"],
                                  "ad_set": adset["name"],
                                  "ad": ad["name"], "ad_id": ad_id})
                except MetaAPIError as exc:
                    errors.append(str(exc))

    print("\nRead-back verification ...")
    problems = builder.verify_all_paused()

    report = {
        "brand": brand_key,
        "built_at": datetime.now(timezone.utc).isoformat(),
        "account": account,
        "created": [{"kind": k, "id": i, "name": n} for k, i, n in builder.created],
        "reused": [{"kind": k, "id": i, "name": n} for k, i, n in builder.reused],
        "ads_built": built,
        "errors": errors,
        "readback_problems": problems,
        "result": "FAILED" if (problems or errors) else "OK",
    }
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    out_path = out_dir / f"build_{brand_key}_{stamp}.json"
    out_path.write_text(json.dumps(report, indent=2))

    print(f"\nBuild report: {out_path}")
    print(f"Created: {len(builder.created)}  Reused: {len(builder.reused)}  "
          f"Errors: {len(errors)}")
    if problems:
        print("\nREAD-BACK PROBLEMS - the build is reported as FAILED:")
        for p in problems:
            print(f"  ! {p}")
        sys.exit(1)
    if errors:
        print("\nERRORS during build (rerun is safe - idempotent by name):")
        for e in errors:
            print(f"  ! {e}")
        sys.exit(1)
    print("\nAll objects verified PAUSED. Review in Ads Manager and activate by hand.")


if __name__ == "__main__":
    main()
