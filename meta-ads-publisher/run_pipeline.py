#!/usr/bin/env python3
"""One-command pipeline runner: scan → QC → (optionally) build paused.

The safe default STOPS at the QC report. Creating objects on Meta requires the
explicit human gate: --build --yes. Even then, everything is created PAUSED -
activation only ever happens by hand in Ads Manager.

Usage:
  python run_pipeline.py --brand <brand-key>                    # scan + QC only
  python run_pipeline.py --brand <brand-key> --build-dry-run    # + account pre-flight
  python run_pipeline.py --brand <brand-key> --build --yes      # + build (paused)
"""

import argparse
import glob
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TOOLS = ROOT / "tools"


def run(script, *args):
    cmd = [sys.executable, str(TOOLS / script), *args]
    print(f"\n=== {script} {' '.join(args)} ===")
    result = subprocess.run(cmd)
    return result.returncode


def latest(pattern):
    files = sorted(glob.glob(str(ROOT / "output" / pattern)))
    return files[-1] if files else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--brand", required=True)
    parser.add_argument("--config", default=str(ROOT / "config" / "brands.json"))
    parser.add_argument("--build-dry-run", action="store_true",
                        help="after QC, verify the ad account is reachable")
    parser.add_argument("--build", action="store_true",
                        help="create objects on Meta (PAUSED); requires --yes")
    parser.add_argument("--yes", action="store_true",
                        help="human confirmation gate for --build")
    args = parser.parse_args()

    if run("drive_scan.py", "--brand", args.brand, "--config", args.config) != 0:
        sys.exit("Scan failed - stopping.")
    plan = latest(f"drive_scan_{args.brand}_*.json")
    if not plan:
        sys.exit("No scan output found - stopping.")

    qc_rc = run("qc_ads.py", "--plan", plan, "--config", args.config)
    qc = latest(f"qc_{args.brand}_*.json")
    if qc_rc != 0 or not qc:
        sys.exit("QC gate did not pass cleanly - stopping. Fix and rerun.")

    if args.build_dry_run:
        if run("build_meta.py", "--qc", qc, "--config", args.config, "--dry-run") != 0:
            sys.exit("Dry-run pre-flight failed - stopping.")

    if not args.build:
        print("\nStopped at the QC report (safe default). To create everything "
              "PAUSED on Meta, rerun with: --build --yes")
        return
    if not args.yes:
        sys.exit("\nREFUSING TO BUILD: --build requires the explicit --yes human "
                 "gate. A person, not an agent, should add it after reading the "
                 "QC report above.")

    rc = run("build_meta.py", "--qc", qc, "--config", args.config)
    if rc != 0:
        sys.exit(rc)
    print("\nDone. Open Ads Manager, verify every object, and activate by hand.")


if __name__ == "__main__":
    main()
