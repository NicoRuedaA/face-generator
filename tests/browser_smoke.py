#!/usr/bin/env python3
"""Browser smoke test for default, legacy WebGL, and official GNM WebGL paths."""

from __future__ import annotations

from playwright.sync_api import sync_playwright


def main() -> int:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path="/usr/bin/chromium")
        messages: list[str] = []
        page_errors: list[str] = []
        for entry in ("index.html", "index.module.html"):
            page = browser.new_page()
            asset_requests: list[str] = []
            page.route("**/favicon.ico", lambda route: route.fulfill(status=204, body=""))
            page.on("request", lambda request: asset_requests.append(request.url) if request.url.endswith("gnm-official-head-render.glb") else None)
            page.on("console", lambda message: messages.append(f"{message.type}: {message.text}"))
            page.on("pageerror", lambda error: page_errors.append(f"{entry}: {error}"))
            page.goto(f"http://127.0.0.1:8080/{entry}")
            page.wait_for_load_state("networkidle")
            page.wait_for_function("document.querySelector('#portrait').width > 0")
            assert page.locator("#portrait").is_visible(), f"{entry}: default 2D canvas is not visible"
            assert not page.locator("#portrait-webgl").is_visible(), f"{entry}: WebGL canvas should be hidden by default"
            selected = page.locator("#render-style")
            assert selected.input_value() == "sports/default-v2", selected.input_value()
            assert not page.locator("#webgl-camera-controls").is_visible(), f"{entry}: WebGL controls should be hidden by default"

            selected.select_option("sports/morph-webgl-official-v1")
            page.wait_for_timeout(1800)
            webgl_visible = page.locator("#portrait-webgl").is_visible()
            fallback_visible = page.locator("#portrait").is_visible()
            diagnostic = page.locator("#toast").text_content() or ""
            assert webgl_visible or fallback_visible, f"{entry}: neither WebGL nor 2D fallback canvas is visible"
            if webgl_visible:
                controls = page.locator("#webgl-camera-controls")
                assert controls.is_visible(), f"{entry}: WebGL camera controls should be visible"
                canvas = page.locator("#portrait-webgl")
                diagnostics = page.evaluate("document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics")
                assert diagnostics["components"] == 6, diagnostics
                assert diagnostics["materials"] == 6, diagnostics
                assert diagnostics["officialTexturesIncluded"] is False, diagnostics
                assert diagnostics["renderOnly"] is True, diagnostics
                assert diagnostics["basisIncluded"] is False, diagnostics
                assert diagnostics["assetSchema"] == "sports-face-gnm-official-head/v1", diagnostics
                assert any(url.endswith("tools/gnm/work/gnm-official-head-render.glb") for url in asset_requests), asset_requests
                box = canvas.bounding_box()
                assert box, f"{entry}: WebGL canvas has no bounds"
                center_x = box["x"] + box["width"] / 2
                center_y = box["y"] + box["height"] / 2
                before = page.evaluate("document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics.camera")
                page.mouse.move(center_x, center_y)
                page.mouse.down()
                page.mouse.move(center_x + 96, center_y - 48, steps=4)
                page.mouse.up()
                page.wait_for_function("() => { const camera = document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics.camera; return camera.yaw !== 0 || camera.pitch !== 0; }")
                after_drag = page.evaluate("document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics.camera")
                assert after_drag["yaw"] != before["yaw"] or after_drag["pitch"] != before["pitch"], after_drag
                page.mouse.wheel(0, 280)
                page.wait_for_function("distance => document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics.camera.distance !== distance", arg=after_drag["distance"])
                after_wheel = page.evaluate("document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics.camera")
                assert after_wheel["distance"] != after_drag["distance"], after_wheel
                page.locator("#reset-webgl-camera").click()
                page.wait_for_function("() => { const camera = document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics.camera; return camera.yaw === 0 && camera.pitch === 0 && camera.distance === 1; }")
                reset = page.evaluate("document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics.camera")
                assert reset == {"yaw": 0, "pitch": 0, "distance": 1}, reset
                result = "PASS WebGL2: opt-in canvas visible"
            else:
                assert "WebGL2" in diagnostic or "fallback" in diagnostic.lower(), diagnostic
                result = f"BOUNDED FALLBACK: 2D GNM SVG visible; diagnostic={diagnostic!r}"
            print(f"PASS {entry} default renderer: Canvas 2D visible")
            print(f"{entry} {result}")
            page.close()
        assert not page_errors, page_errors
        console_errors = [message for message in messages if message.startswith("error:")]
        assert not console_errors, console_errors
        if messages:
            print(f"console messages: {messages}")
        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
