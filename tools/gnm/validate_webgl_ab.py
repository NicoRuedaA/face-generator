#!/usr/bin/env python3
"""Validate committed GNM SVG/WebGL2 comparison evidence without Playwright."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


SCHEMA = "sports-face-gnm-webgl-ab/v1"
SVG_RENDERER = "sports/morph-gnm-v1"
WEBGL_RENDERER = "sports/morph-webgl-v1"
SEEDS = (0, 1, 42, 12345, 424242, 8675309, 2147483647, 4294967295)
ALLOWED_WEBGL = {"rendered", "fallback", "unavailable"}
MIN_CANVAS_EDGE = 1
MAX_RENDERED_OCCUPANCY = 0.98
MIN_RENDERED_OCCUPANCY = 0.01


def fail(message: str) -> None:
    raise ValueError(message)


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def validate(path: Path) -> dict:
    document = json.loads(path.read_text(encoding="utf-8"))
    require(document.get("schema") == SCHEMA, "unexpected comparison schema")
    require(document.get("comparison", {}).get("reference") == SVG_RENDERER, "SVG reference is missing")
    require(document.get("comparison", {}).get("candidate") == WEBGL_RENDERER, "WebGL candidate is missing")
    fixed = document.get("fixedInputs", {})
    require(tuple(fixed.get("seeds", ())) == SEEDS, "fixed seed list is not stable")
    require(fixed.get("age") == 22 and fixed.get("presentation") == "neutral", "fixed profile inputs changed")
    require(fixed.get("kit") == {"primary": "#b91c1c", "secondary": "#f8fafc"}, "fixed kit inputs changed")
    cases = document.get("cases")
    require(isinstance(cases, list) and len(cases) == len(SEEDS), "evidence must contain exactly 8 cases")
    expected_ids = [f"seed-{seed:010d}" for seed in SEEDS]
    actual_ids = [case.get("profile", {}).get("id") for case in cases]
    require(actual_ids == expected_ids, "profile IDs or order are not stable")
    for index, case in enumerate(cases):
        profile = case.get("profile", {})
        require(profile.get("seed") == SEEDS[index], f"case {index + 1}: seed mismatch")
        require(profile.get("age") == 22 and profile.get("presentation") == "neutral", f"case {index + 1}: profile inputs mismatch")
        require(profile.get("kit") == {"primary": "#b91c1c", "secondary": "#f8fafc"}, f"case {index + 1}: kit inputs mismatch")
        require(isinstance(profile.get("faceCode"), str) and profile["faceCode"], f"case {index + 1}: missing FaceDNA code")
        captures = case.get("captures", {})
        svg = captures.get("svg", {})
        webgl = captures.get("webgl", {})
        require(svg.get("attempted") is True and svg.get("renderer") == SVG_RENDERER, f"case {index + 1}: SVG was not attempted")
        require(svg.get("status") == "rendered", f"case {index + 1}: SVG reference did not render")
        require(webgl.get("attempted") is True and webgl.get("renderer") == WEBGL_RENDERER, f"case {index + 1}: WebGL was not attempted")
        require(webgl.get("status") in ALLOWED_WEBGL, f"case {index + 1}: invalid WebGL status")
        require(svg.get("faceCode") == profile["faceCode"], f"case {index + 1}: SVG FaceDNA differs from profile")
        require(webgl.get("faceCode") == profile["faceCode"], f"case {index + 1}: WebGL FaceDNA differs from profile")
        for label, capture in (("SVG", svg), ("WebGL", webgl)):
            require(capture.get("consoleErrors") == [], f"case {index + 1}: {label} console errors present")
            require(capture.get("pageErrors") == [], f"case {index + 1}: {label} page errors present")
            require(capture.get("requestFailures") == [], f"case {index + 1}: {label} request failures present")
            if capture.get("status") != "unavailable":
                require(capture.get("file"), f"case {index + 1}: {label} screenshot missing")
                metrics = capture.get("imageMetrics")
                require(isinstance(metrics, dict), f"case {index + 1}: {label} image metrics missing")
                width = metrics.get("width")
                height = metrics.get("height")
                require(isinstance(width, int) and isinstance(height, int) and width >= MIN_CANVAS_EDGE and height >= MIN_CANVAS_EDGE, f"case {index + 1}: {label} image dimensions invalid")
                occupancy = metrics.get("occupancy")
                require(isinstance(occupancy, (int, float)) and MIN_RENDERED_OCCUPANCY <= occupancy <= MAX_RENDERED_OCCUPANCY, f"case {index + 1}: {label} occupancy outside bounded diagnostic range")
                box = metrics.get("boundingBox")
                require(isinstance(box, list) and len(box) == 4 and 0 <= box[0] <= box[2] < width and 0 <= box[1] <= box[3] < height, f"case {index + 1}: {label} bounding box invalid")
            if capture.get("status") == "rendered" and label == "WebGL":
                browser_metrics = capture.get("canvasMetrics")
                require(isinstance(browser_metrics, dict) and browser_metrics.get("probe") in {"readPixels", "readPixels-empty"}, f"case {index + 1}: WebGL readPixels probe missing")
                require(browser_metrics.get("glError") == 0, f"case {index + 1}: WebGL readPixels reported GL error")
                diagnostics = browser_metrics.get("diagnostics")
                require(isinstance(diagnostics, dict) and diagnostics.get("depthTest") is True, f"case {index + 1}: WebGL depth diagnostic missing")
                require(diagnostics.get("culling", {}).get("enabled") is False, f"case {index + 1}: WebGL culling diagnostic changed unexpectedly")
                require(isinstance(diagnostics.get("maxWeight"), (int, float)) and diagnostics["maxWeight"] <= 0.75 + 1e-6, f"case {index + 1}: WebGL weight bound exceeded")
    return document


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    try:
        document = validate(args.path)
    except (OSError, ValueError, json.JSONDecodeError, TypeError) as error:
        print(f"FAIL {args.path}: {error}", file=sys.stderr)
        return 1
    webgl_statuses = [case["captures"]["webgl"]["status"] for case in document["cases"]]
    print(f"PASS {args.path}: 8 cases, SVG rendered 8/8, WebGL statuses={{{', '.join(sorted(set(webgl_statuses)))}}}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
