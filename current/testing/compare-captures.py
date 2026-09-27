#!/usr/bin/env python3
"""Compare two captured renderer screenshots for the isolated visual check.

Usage: compare-captures.py <baseline.png> <candidate.png>

Prints a JSON summary (sizes, identical, differing-pixel ratio, diff bounding
box) and exits non-zero when sizes differ or the differing-pixel ratio exceeds
--threshold (default 0.15). It changes no thresholds silently: the threshold is
explicit on the command line.
"""
from __future__ import annotations

import argparse
import json
import sys

from PIL import Image, ImageChops


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline")
    parser.add_argument("candidate")
    parser.add_argument("--threshold", type=float, default=0.15,
                        help="maximum differing-pixel ratio (0..1) before failing")
    args = parser.parse_args()

    baseline = Image.open(args.baseline).convert("RGB")
    candidate = Image.open(args.candidate).convert("RGB")
    report: dict = {
        "baseline": args.baseline, "candidate": args.candidate,
        "baseline_size": baseline.size, "candidate_size": candidate.size,
        "threshold": args.threshold,
    }
    if baseline.size != candidate.size:
        report["ok"] = False
        report["reason"] = "size mismatch"
        print(json.dumps(report, indent=2))
        return 1

    diff = ImageChops.difference(baseline, candidate)
    bbox = diff.getbbox()
    total = baseline.size[0] * baseline.size[1]
    if bbox is None:
        ratio = 0.0
    else:
        ratio = sum(diff.convert("L").histogram()[8:]) / total
    report.update({
        "identical": bbox is None,
        "diff_bbox": bbox,
        "differing_ratio": round(ratio, 5),
        "ok": ratio <= args.threshold,
    })
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
