#!/usr/bin/env python3
"""Capture a bounded, deterministic SVG/WebGL2 GNM visual comparison."""

from __future__ import annotations

import argparse
import collections
import html
import json
import struct
import sys
import time
import zlib
from pathlib import Path
from typing import Any

from playwright.sync_api import Page, TimeoutError as PlaywrightTimeoutError, sync_playwright


SCHEMA = "sports-face-gnm-webgl-ab/v1"
SVG_RENDERER = "sports/morph-gnm-v1"
WEBGL_RENDERER = "sports/morph-webgl-v1"
OFFICIAL_WEBGL_RENDERER = "sports/morph-webgl-official-v1"
AGE = 22
PRESENTATION = "neutral"
EXPRESSION_MODE = "neutral"
KIT = {"primary": "#b91c1c", "secondary": "#f8fafc"}
VIEWPORT = {"width": 1024, "height": 1024}
DEVICE_SCALE_FACTOR = 1
CANVAS_SIZE = 768
SEEDS = (0, 1, 42, 12345, 424242, 8675309, 2147483647, 4294967295)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", default="/tmp/sports-face-gnm-webgl-ab", help="Evidence output directory")
    parser.add_argument("--url", help="Running modular app URL; defaults to the selected port")
    parser.add_argument("--port", type=int, default=8080, help="Default app server port when --url is omitted")
    parser.add_argument("--browser", default="/usr/bin/chromium", help="Chromium executable")
    parser.add_argument("--timeout-ms", type=int, default=15000, help="Per-page readiness timeout")
    parser.add_argument("--renderer", choices=(WEBGL_RENDERER, OFFICIAL_WEBGL_RENDERER), default=OFFICIAL_WEBGL_RENDERER, help="WebGL style to smoke-test")
    return parser.parse_args()


def app_url(args: argparse.Namespace) -> str:
    return args.url or f"http://127.0.0.1:{args.port}/index.module.html"


def profile_id(seed: int) -> str:
    return f"seed-{seed:010d}"


def install_error_capture(page: Page, console_errors: list[str], page_errors: list[str], request_failures: list[str]) -> None:
    page.route("**/favicon.ico", lambda route: route.fulfill(status=204, body=""))
    page.on("console", lambda message: console_errors.append(f"{message.type}: {message.text}") if message.type == "error" else None)
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.on("requestfailed", lambda request: request_failures.append(f"{request.method} {request.url}: {request.failure}"))


def set_fixed_profile(page: Page, seed: int, renderer: str, timeout_ms: int, face_code: str | None = None) -> str:
    page.locator("#age").fill(str(AGE), timeout=timeout_ms)
    page.locator("#presentation").select_option(PRESENTATION, timeout=timeout_ms)
    page.locator("#kit-primary").fill(KIT["primary"], timeout=timeout_ms)
    page.locator("#kit-secondary").fill(KIT["secondary"], timeout=timeout_ms)
    page.locator("#seed").fill(str(seed), timeout=timeout_ms)
    page.locator("#apply-seed").click()
    page.locator("#render-style").select_option(renderer, timeout=timeout_ms)
    page.wait_for_function(
        "renderer => document.querySelector('#debug-output').textContent.includes(renderer)",
        arg=renderer,
        timeout=timeout_ms,
    )
    if renderer == SVG_RENDERER:
        page.locator("#expression-mode").wait_for(state="visible", timeout=timeout_ms)
        page.locator("#expression-mode").select_option(EXPRESSION_MODE, timeout=timeout_ms)
    if face_code:
        page.locator("#face-code").fill(face_code, timeout=timeout_ms)
        page.locator("#load-code").click(timeout=timeout_ms)
        page.wait_for_function(
            "code => document.querySelector('#face-code').value === code",
            arg=face_code,
            timeout=timeout_ms,
        )
    return page.locator("#face-code").input_value()


def wait_for_visible_canvas(page: Page, renderer: str, timeout_ms: int) -> dict[str, Any]:
    page.wait_for_function(
        """
        renderer => {
          const webgl = document.querySelector('#portrait-webgl');
          const svg = document.querySelector('#portrait');
          const visible = element => element && !element.hidden && element.offsetWidth > 0 && element.offsetHeight > 0;
           return ['sports/morph-webgl-v1', 'sports/morph-webgl-official-v1'].includes(renderer) ? visible(webgl) || visible(svg) : visible(svg) && !visible(webgl);
        }
        """,
        arg=renderer,
        timeout=timeout_ms,
    )
    page.wait_for_timeout(100)
    webgl_visible = page.locator("#portrait-webgl").is_visible()
    svg_visible = page.locator("#portrait").is_visible()
    if renderer in (WEBGL_RENDERER, OFFICIAL_WEBGL_RENDERER):
        if webgl_visible and not svg_visible:
            status = "rendered"
            canvas = page.locator("#portrait-webgl")
        elif svg_visible and not webgl_visible:
            status = "fallback"
            canvas = page.locator("#portrait")
        else:
            status = "unavailable"
            canvas = None
    else:
        if not svg_visible or webgl_visible:
            raise RuntimeError("SVG reference did not leave exactly the SVG canvas visible")
        status = "rendered"
        canvas = page.locator("#portrait")
    return {
        "status": status,
        "canvas": canvas,
        "fallback": {
            "used": status == "fallback",
            "reason": (page.locator("#toast").text_content() or "").strip() if status == "fallback" else None,
        },
        "browserMetrics": browser_canvas_metrics(page, canvas, renderer) if canvas is not None else None,
    }


def browser_canvas_metrics(page: Page, canvas: Any, renderer: str) -> dict[str, Any]:
    return page.evaluate(
        """
        ({ selector, renderer }) => {
          const canvas = document.querySelector(selector);
          const result = { width: canvas.width, height: canvas.height, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight };
           if (!['sports/morph-webgl-v1', 'sports/morph-webgl-official-v1'].includes(renderer)) return { ...result, probe: 'screenshot-only' };
          const gl = canvas.getContext('webgl2');
          if (!gl) return { ...result, probe: 'webgl2-unavailable' };
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.readBuffer(gl.BACK);
          const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
          gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          const histogram = new Map();
          for (let offset = 0; offset < pixels.length; offset += 4) {
            const key = `${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`;
            histogram.set(key, (histogram.get(key) || 0) + 1);
          }
          const clear = histogram.entries().reduce((best, entry) => entry[1] > best[1] ? entry : best)[0].split(',').map(Number);
          const tolerance = 24;
          gl.finish();
          let count = 0, minX = gl.drawingBufferWidth, minY = gl.drawingBufferHeight, maxX = -1, maxY = -1;
          for (let y = 0; y < gl.drawingBufferHeight; y += 1) for (let x = 0; x < gl.drawingBufferWidth; x += 1) {
            const offset = (y * gl.drawingBufferWidth + x) * 4;
            const occupied = Math.max(Math.abs(pixels[offset] - clear[0]), Math.abs(pixels[offset + 1] - clear[1]), Math.abs(pixels[offset + 2] - clear[2])) > tolerance && pixels[offset + 3] > 0;
            if (occupied) { count += 1; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
          }
          return { ...result, probe: count > 0 ? 'readPixels' : 'readPixels-empty', clearColor: clear, tolerance, nonBackgroundPixels: count, occupancy: count / (gl.drawingBufferWidth * gl.drawingBufferHeight), boundingBox: maxX < 0 ? null : [minX, minY, maxX, maxY], glError: gl.getError(), diagnostics: canvas.__sportsFaceWebglDiagnostics || null };
        }
        """,
        {"selector": "#portrait-webgl" if renderer in (WEBGL_RENDERER, OFFICIAL_WEBGL_RENDERER) else "#portrait", "renderer": renderer},
    )


def decode_png(path: Path) -> tuple[int, int, list[tuple[int, int, int, int]]]:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} is not a PNG")
    offset = 8
    payload = bytearray()
    width = height = color_type = bit_depth = None
    while offset < len(data):
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        chunk_type = data[offset + 4:offset + 8]
        chunk = data[offset + 8:offset + 8 + length]
        offset += length + 12
        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(">IIBBBBB", chunk)
            if bit_depth != 8 or color_type not in (2, 6) or compression != 0 or filtering != 0 or interlace != 0:
                raise ValueError(f"unsupported PNG format in {path}")
        elif chunk_type == b"IDAT":
            payload.extend(chunk)
    if width is None or height is None:
        raise ValueError(f"PNG header missing in {path}")
    channels = 4 if color_type == 6 else 3
    stride = width * channels
    decoded = zlib.decompress(payload)
    rows: list[tuple[int, int, int, int]] = []
    previous = bytearray(stride)
    cursor = 0
    for _ in range(height):
        filter_type = decoded[cursor]
        cursor += 1
        row = bytearray(decoded[cursor:cursor + stride])
        cursor += stride
        for index in range(stride):
            left = row[index - channels] if index >= channels else 0
            above = previous[index]
            upper_left = previous[index - channels] if index >= channels else 0
            if filter_type == 1:
                row[index] = (row[index] + left) & 255
            elif filter_type == 2:
                row[index] = (row[index] + above) & 255
            elif filter_type == 3:
                row[index] = (row[index] + ((left + above) // 2)) & 255
            elif filter_type == 4:
                estimate = left + above - upper_left
                left_distance = abs(estimate - left)
                above_distance = abs(estimate - above)
                upper_left_distance = abs(estimate - upper_left)
                predictor = left if left_distance <= above_distance and left_distance <= upper_left_distance else above if above_distance <= upper_left_distance else upper_left
                row[index] = (row[index] + predictor) & 255
            elif filter_type != 0:
                raise ValueError(f"unsupported PNG filter {filter_type}")
        rows.extend((row[index], row[index + 1], row[index + 2], row[index + 3] if channels == 4 else 255) for index in range(0, stride, channels))
        previous = row
    return width, height, rows


def image_metrics(path: Path) -> dict[str, Any]:
    width, height, pixels = decode_png(path)
    background = collections.Counter(pixels).most_common(1)[0][0]
    tolerance = 24
    occupied = [index for index, pixel in enumerate(pixels) if max(abs(pixel[channel] - background[channel]) for channel in range(3)) > tolerance and pixel[3] > 0]
    if not occupied:
        box = None
    else:
        xs = [index % width for index in occupied]
        ys = [index // width for index in occupied]
        box = [min(xs), min(ys), max(xs), max(ys)]
    return {
        "width": width,
        "height": height,
        "background": list(background),
        "tolerance": tolerance,
        "nonBackgroundPixels": len(occupied),
        "occupancy": len(occupied) / (width * height),
        "boundingBox": box,
        "probe": "stdlib-png-decoder",
    }


def capture_renderer(context: Any, url: str, seed: int, renderer: str, output_dir: Path, timeout_ms: int, browser_name: str, face_code: str | None = None) -> tuple[dict[str, Any], str]:
    page = context.new_page()
    console_errors: list[str] = []
    page_errors: list[str] = []
    request_failures: list[str] = []
    install_error_capture(page, console_errors, page_errors, request_failures)
    navigation_start = time.perf_counter()
    try:
        page.goto(url, wait_until="networkidle", timeout=timeout_ms)
        navigation_ms = round((time.perf_counter() - navigation_start) * 1000, 2)
        page.wait_for_selector("#render-style", state="visible", timeout=timeout_ms)
        face_code = set_fixed_profile(page, seed, renderer, timeout_ms, face_code)
        render_start = time.perf_counter()
        ready = wait_for_visible_canvas(page, renderer, timeout_ms)
        render_ms = round((time.perf_counter() - render_start) * 1000, 2)
        filename = f"{'svg' if renderer == SVG_RENDERER else 'webgl-official' if renderer == OFFICIAL_WEBGL_RENDERER else 'webgl'}-{profile_id(seed)}.png"
        if ready["canvas"] is not None:
            ready["canvas"].screenshot(path=str(output_dir / filename), animations="disabled")
            ready["imageMetrics"] = image_metrics(output_dir / filename)
        else:
            filename = None
        asset_url = page.evaluate(
            "renderer => renderer === 'sports/morph-webgl-v1' ? new URL('tools/gnm/work/head-morph.glb', location.href).href : new URL('tools/gnm/work/gnm-official-head.glb', location.href).href",
            renderer,
        )
        capture = {
            "renderer": renderer,
            "status": ready["status"],
            "attempted": True,
            "file": filename,
            "assetUrl": asset_url,
            "timingMs": {"navigation": navigation_ms, "render": render_ms},
            "fallback": ready["fallback"],
            "canvasMetrics": ready["browserMetrics"],
            "imageMetrics": ready.get("imageMetrics"),
            "viewport": {**VIEWPORT, "deviceScaleFactor": DEVICE_SCALE_FACTOR},
            "browser": {"name": browser_name, "version": context.browser.version, "userAgent": page.evaluate("navigator.userAgent")},
            "consoleErrors": console_errors,
            "pageErrors": page_errors,
            "requestFailures": request_failures,
            "faceCode": face_code,
        }
        return capture, face_code
    except (PlaywrightTimeoutError, RuntimeError) as error:
        return {
            "renderer": renderer,
            "status": "unavailable" if renderer in (WEBGL_RENDERER, OFFICIAL_WEBGL_RENDERER) else "error",
            "attempted": True,
            "file": None,
            "assetUrl": None,
            "timingMs": {"navigation": round((time.perf_counter() - navigation_start) * 1000, 2)},
            "fallback": {"used": False, "reason": None},
            "viewport": {**VIEWPORT, "deviceScaleFactor": DEVICE_SCALE_FACTOR},
            "browser": {"name": browser_name, "version": context.browser.version, "userAgent": page.evaluate("navigator.userAgent")},
            "consoleErrors": console_errors,
            "pageErrors": page_errors,
            "requestFailures": request_failures,
            "error": str(error),
            "faceCode": None,
        }, ""
    finally:
        page.close()


def report_html(manifest: dict[str, Any]) -> str:
    rows: list[str] = []
    for case in manifest["cases"]:
        svg = case["captures"]["svg"]
        webgl = case["captures"]["webgl"]
        svg_image = f'<img src="{html.escape(svg["file"] or "")}" alt="SVG {html.escape(case["profile"]["id"])}">' if svg["file"] else "unavailable"
        webgl_image = f'<img src="{html.escape(webgl["file"] or "")}" alt="WebGL {html.escape(case["profile"]["id"])}">' if webgl["file"] else "unavailable"
        rows.append(
            "<tr>"
            f"<th scope=\"row\">{html.escape(case['profile']['id'])}</th>"
            f"<td>{svg_image}<small>{html.escape(svg['status'])}</small></td>"
            f"<td>{webgl_image}<small>{html.escape(webgl['status'])}</small></td>"
            f"<td><code>{html.escape(case['profile']['faceCode'])}</code><br>{html.escape(webgl['fallback']['reason'] or '')}</td>"
            "</tr>"
        )
    return """<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>GNM SVG/WebGL2 visual A/B comparison</title>
<style>
body{font:16px system-ui,sans-serif;background:#111827;color:#f3f4f6;margin:2rem}
table{border-collapse:collapse;width:100%;max-width:1800px}
th,td{border:1px solid #374151;padding:.75rem;vertical-align:top;text-align:left}
th{background:#1f2937}
td{width:38%}
img{display:block;width:100%;max-width:384px;background:#0f172a}
small{display:block;color:#cbd5e1;margin-top:.35rem}
code{overflow-wrap:anywhere}
.notice{background:#1f2937;padding:1rem;margin-bottom:1rem;max-width:1100px}
</style>
<h1>GNM SVG/WebGL2 visual A/B comparison</h1>
<div class="notice"><strong>Bounded diagnostic evidence.</strong> The same fixed FaceDNA profiles are shown with SVG GNM as the reference and WebGL2 geometry-only as the opt-in candidate. Different shading and projection mean this is qualitative evidence, not pixel equivalence. WebGL2 absence is reported as fallback or unavailable, never as a fabricated pass.</div>
<table><thead><tr><th>Profile</th><th>SVG reference</th><th>WebGL2 attempt</th><th>Shared profile / fallback</th></tr></thead><tbody>""" + "\n".join(rows) + """</tbody></table>
</html>
"""


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    url = app_url(args)
    cases: list[dict[str, Any]] = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, executable_path=args.browser, args=["--no-sandbox"])
            context = browser.new_context(viewport=VIEWPORT, device_scale_factor=DEVICE_SCALE_FACTOR, color_scheme="dark")
            try:
                for seed in SEEDS:
                    svg, svg_code = capture_renderer(context, url, seed, SVG_RENDERER, output_dir, args.timeout_ms, "chromium")
                    webgl, webgl_code = capture_renderer(context, url, seed, args.renderer, output_dir, args.timeout_ms, "chromium", svg_code)
                    cases.append({
                        "profile": {"id": profile_id(seed), "seed": seed, "age": AGE, "presentation": PRESENTATION, "expressionMode": EXPRESSION_MODE, "kit": KIT, "faceCode": svg_code or webgl_code},
                        "captures": {"svg": svg, "webgl": webgl},
                    })
            finally:
                context.close()
                browser.close()
    except Exception as error:
        print(f"WebGL A/B capture failed before evidence completion: {error}", file=sys.stderr)
        return 1

    manifest = {
        "schema": SCHEMA,
        "comparison": {"reference": SVG_RENDERER, "candidate": args.renderer, "claim": "qualitative diagnostic; not pixel equivalence"},
        "fixedInputs": {"seeds": list(SEEDS), "age": AGE, "presentation": PRESENTATION, "expressionMode": EXPRESSION_MODE, "kit": KIT},
        "viewport": {**VIEWPORT, "deviceScaleFactor": DEVICE_SCALE_FACTOR},
        "url": url,
        "cases": cases,
        "statusDistribution": {
            "svg": {status: sum(case["captures"]["svg"]["status"] == status for case in cases) for status in ("rendered", "error", "unavailable")},
            "webgl": {status: sum(case["captures"]["webgl"]["status"] == status for case in cases) for status in ("rendered", "fallback", "unavailable")},
        },
    }
    (output_dir / "comparison.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    (output_dir / "comparison.html").write_text(report_html(manifest), encoding="utf-8")
    print(json.dumps({"outputDir": str(output_dir), "caseCount": len(cases), "statusDistribution": manifest["statusDistribution"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
