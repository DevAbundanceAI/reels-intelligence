#!/usr/bin/env python3
"""Stage 1 - Drive scanner.

Walks a brand's Google Drive intake folder (see docs/META-ADS-PIPELINE.md for
the folder contract), downloads creatives locally, parses copy sidecars, and
writes a structured campaign plan JSON.

This tool is read-only against Drive and makes no Meta API calls.

Usage:
  python tools/drive_scan.py --brand <brand-key> [--config config/brands.json]
  python tools/drive_scan.py --list-brand-folders
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

DRIVE_API = "https://www.googleapis.com/drive/v3"
SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
GOOGLE_NATIVE_MIME_PREFIX = "application/vnd.google-apps"
FOLDER_MIME = "application/vnd.google-apps.folder"

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v"}
CREATIVE_EXTS = IMAGE_EXTS | VIDEO_EXTS
SIDECAR_EXTS = {".json", ".txt"}

ROOT = Path(__file__).resolve().parent.parent


def load_env(path):
    """Minimal .env loader; never overrides variables already in the environment."""
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


def get_access_token():
    """Service-account key first; raw OAuth bearer token as fallback."""
    key_path = os.environ.get("GOOGLE_SERVICE_ACCOUNT_KEY") or os.environ.get(
        "GOOGLE_APPLICATION_CREDENTIALS"
    )
    if key_path and Path(key_path).exists():
        try:
            import google.auth.transport.requests
            from google.oauth2 import service_account
        except ImportError:
            sys.exit("google-auth is not installed. Run: pip install google-auth")
        creds = service_account.Credentials.from_service_account_file(
            key_path, scopes=SCOPES
        )
        creds.refresh(google.auth.transport.requests.Request())
        return creds.token
    token = os.environ.get("GOOGLE_OAUTH_TOKEN")
    if token:
        return token
    sys.exit(
        "No Google credentials. Set GOOGLE_SERVICE_ACCOUNT_KEY to a service-account "
        "key file path (drive.readonly scope), or GOOGLE_OAUTH_TOKEN to a bearer token."
    )


class Drive:
    def __init__(self, token):
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Bearer {token}"

    def _get(self, url, **kwargs):
        for attempt in range(5):
            resp = self.session.get(url, timeout=120, **kwargs)
            if resp.status_code in (429, 500, 502, 503):
                time.sleep(2**attempt)
                continue
            if resp.status_code == 403 and "rateLimitExceeded" in resp.text:
                time.sleep(2**attempt)
                continue
            resp.raise_for_status()
            return resp
        resp.raise_for_status()

    def list_children(self, folder_id):
        files, page_token = [], None
        while True:
            params = {
                "q": f"'{folder_id}' in parents and trashed = false",
                "fields": "nextPageToken, files(id, name, mimeType, modifiedTime, size)",
                "pageSize": 1000,
                "supportsAllDrives": "true",
                "includeItemsFromAllDrives": "true",
            }
            if page_token:
                params["pageToken"] = page_token
            data = self._get(f"{DRIVE_API}/files", params=params).json()
            files.extend(data.get("files", []))
            page_token = data.get("nextPageToken")
            if not page_token:
                return files

    def list_shared_folders(self):
        """Every folder visible to these credentials - used for bootstrap."""
        files, page_token = [], None
        while True:
            params = {
                "q": f"mimeType = '{FOLDER_MIME}' and trashed = false",
                "fields": "nextPageToken, files(id, name, modifiedTime)",
                "pageSize": 1000,
                "supportsAllDrives": "true",
                "includeItemsFromAllDrives": "true",
            }
            if page_token:
                params["pageToken"] = page_token
            data = self._get(f"{DRIVE_API}/files", params=params).json()
            files.extend(data.get("files", []))
            page_token = data.get("nextPageToken")
            if not page_token:
                return files

    def download(self, file_id, dest):
        resp = self._get(
            f"{DRIVE_API}/files/{file_id}",
            params={"alt": "media", "supportsAllDrives": "true"},
            stream=True,
        )
        dest.parent.mkdir(parents=True, exist_ok=True)
        with open(dest, "wb") as fh:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                fh.write(chunk)
        return dest

    def read_text(self, file_id):
        return self._get(
            f"{DRIVE_API}/files/{file_id}",
            params={"alt": "media", "supportsAllDrives": "true"},
        ).text


def is_folder(f):
    return f["mimeType"] == FOLDER_MIME


def is_native_google_file(f):
    return f["mimeType"].startswith(GOOGLE_NATIVE_MIME_PREFIX) and not is_folder(f)


def ext_of(name):
    return Path(name).suffix.lower()


def stem_of(name):
    return Path(name).stem


def safe_name(name):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name)


def parse_json_sidecar(drive, f, warnings, context):
    try:
        return json.loads(drive.read_text(f["id"]))
    except json.JSONDecodeError as exc:
        warnings.append(f"{context}: invalid JSON in '{f['name']}' ({exc})")
        return None


def scan_ad_set(drive, adset_folder, download_dir, warnings, context):
    children = drive.list_children(adset_folder["id"])
    adset = {
        "name": adset_folder["name"],
        "targeting_override": None,
        "ads": [],
    }

    files = [f for f in children if not is_folder(f)]
    for f in files:
        if is_native_google_file(f):
            warnings.append(
                f"{context}: '{f['name']}' is a native Google Doc/Sheet - unsupported "
                "on purpose; export it as .txt or .json"
            )

    by_stem = {}
    for f in files:
        by_stem.setdefault(stem_of(f["name"]), []).append(f)

    for f in files:
        if f["name"] == "_adset.json":
            adset["targeting_override"] = parse_json_sidecar(drive, f, warnings, context)
            continue
        ext = ext_of(f["name"])
        if ext not in CREATIVE_EXTS:
            continue

        ad = {
            "name": stem_of(f["name"]),
            "creative_file": None,
            "creative_type": "image" if ext in IMAGE_EXTS else "video",
            "copy": {},
        }

        dest = download_dir / safe_name(adset_folder["name"]) / safe_name(f["name"])
        print(f"    downloading {f['name']} ...")
        drive.download(f["id"], dest)
        ad["creative_file"] = str(dest)
        ad["creative_bytes"] = dest.stat().st_size

        sidecars = [
            s
            for s in by_stem.get(stem_of(f["name"]), [])
            if ext_of(s["name"]) in SIDECAR_EXTS and not is_native_google_file(s)
        ]
        json_side = next((s for s in sidecars if ext_of(s["name"]) == ".json"), None)
        txt_side = next((s for s in sidecars if ext_of(s["name"]) == ".txt"), None)
        if json_side:
            data = parse_json_sidecar(drive, json_side, warnings, context)
            if isinstance(data, dict):
                ad["copy"] = data
        elif txt_side:
            ad["copy"] = {"primary_text": drive.read_text(txt_side["id"]).strip()}
        else:
            warnings.append(
                f"{context}: creative '{f['name']}' has no copy sidecar "
                f"({stem_of(f['name'])}.json or .txt)"
            )

        adset["ads"].append(ad)

    if not adset["ads"]:
        warnings.append(f"{context}: ad set folder contains no creative files")
    return adset


def scan_campaign(drive, campaign_folder, download_dir, warnings):
    context = f"campaign '{campaign_folder['name']}'"
    children = drive.list_children(campaign_folder["id"])
    campaign = {
        "name": campaign_folder["name"],
        "settings": None,
        "batch": None,
        "ad_sets": [],
    }

    for f in children:
        if not is_folder(f) and f["name"] == "_campaign.json":
            campaign["settings"] = parse_json_sidecar(drive, f, warnings, context)

    batches = [f for f in children if is_folder(f)]
    if not batches:
        warnings.append(f"{context}: no batch folders - skipped")
        return campaign
    batches.sort(key=lambda f: f.get("modifiedTime", ""), reverse=True)
    if len(batches) > 1:
        others = ", ".join(f["name"] for f in batches[1:])
        warnings.append(
            f"{context}: multiple batch folders; using most recently modified "
            f"'{batches[0]['name']}' (skipped: {others})"
        )
    batch = batches[0]
    campaign["batch"] = batch["name"]

    adset_folders = [f for f in drive.list_children(batch["id"]) if is_folder(f)]
    if not adset_folders:
        warnings.append(f"{context}: batch '{batch['name']}' has no ad set folders")
    for folder in adset_folders:
        ctx = f"{context} / ad set '{folder['name']}'"
        print(f"  ad set: {folder['name']}")
        campaign["ad_sets"].append(
            scan_ad_set(
                drive,
                folder,
                download_dir / safe_name(campaign_folder["name"]) / safe_name(batch["name"]),
                warnings,
                ctx,
            )
        )
    return campaign


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--brand", help="brand key in the config file")
    parser.add_argument("--config", default=str(ROOT / "config" / "brands.json"))
    parser.add_argument("--output-dir", default=str(ROOT / "output"))
    parser.add_argument("--download-dir", default=str(ROOT / "downloads"))
    parser.add_argument(
        "--list-brand-folders",
        action="store_true",
        help="print every folder shared with these credentials, then exit",
    )
    args = parser.parse_args()

    load_env(ROOT / ".env")
    load_env(ROOT.parent / ".env")
    drive = Drive(get_access_token())

    if args.list_brand_folders:
        folders = drive.list_shared_folders()
        if not folders:
            print("No folders visible. Share each brand root folder with the "
                  "service account's email as Viewer.")
            return
        print(f"{'FOLDER ID':<40} NAME")
        for f in sorted(folders, key=lambda x: x["name"].lower()):
            print(f"{f['id']:<40} {f['name']}")
        return

    if not args.brand:
        parser.error("--brand is required (or use --list-brand-folders)")

    config_path = Path(args.config)
    if not config_path.exists():
        sys.exit(f"Config not found: {config_path}")
    config = json.loads(config_path.read_text())
    brand = config.get("brands", {}).get(args.brand)
    if not brand:
        known = ", ".join(config.get("brands", {})) or "(none)"
        sys.exit(f"Unknown brand '{args.brand}'. Known brands: {known}")
    root_id = brand.get("drive_root_folder_id")
    if not root_id:
        sys.exit(
            f"Brand '{args.brand}' has no drive_root_folder_id. "
            "Run --list-brand-folders and paste the ID into the config."
        )

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    download_dir = Path(args.download_dir) / args.brand / timestamp
    warnings = []

    campaign_folders = [f for f in drive.list_children(root_id) if is_folder(f)]
    if not campaign_folders:
        warnings.append("brand root folder contains no campaign folders")

    campaigns = []
    for folder in campaign_folders:
        print(f"campaign: {folder['name']}")
        campaigns.append(scan_campaign(drive, folder, download_dir, warnings))

    plan = {
        "brand": args.brand,
        "scanned_at": datetime.now(timezone.utc).isoformat(),
        "drive_root_folder_id": root_id,
        "campaigns": campaigns,
        "warnings": warnings,
    }

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"drive_scan_{args.brand}_{timestamp}.json"
    out_path.write_text(json.dumps(plan, indent=2))

    n_ads = sum(len(a["ads"]) for c in campaigns for a in c["ad_sets"])
    print(f"\nScan complete: {len(campaigns)} campaign(s), {n_ads} ad(s).")
    if warnings:
        print(f"\n{len(warnings)} WARNING(S):")
        for w in warnings:
            print(f"  - {w}")
    print(f"\nPlan written to: {out_path}")


if __name__ == "__main__":
    main()
