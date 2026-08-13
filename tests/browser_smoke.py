#!/usr/bin/env python3
"""Browser smoke test for default, official GNM WebGL, and Basis Lab paths."""

from __future__ import annotations

from playwright.sync_api import sync_playwright


def main() -> int:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path="/usr/bin/chromium")
        messages: list[str] = []
        page_errors: list[str] = []
        for entry in ("index.html", "index.module.html"):
            context = browser.new_context()
            page = context.new_page()
            asset_requests: list[str] = []
            page.route("**/favicon.ico", lambda route: route.fulfill(status=204, body=""))
            page.on("request", lambda request: asset_requests.append(request.url) if any(request.url.endswith(asset) for asset in ("gnm-official-head-render.glb", "gnm-official-basis-lab.bin", "gnm-official-basis-lab.json")) else None)
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
            selected.select_option("sports/morph-webgl-official-basis-lab-v1")
            page.wait_for_timeout(1800)
            basis_visible = page.locator("#portrait-webgl").is_visible()
            if basis_visible:
                basis_controls = page.locator("#basis-lab-controls")
                assert basis_controls.is_visible(), f"{entry}: Basis Lab controls should be visible"
                assert basis_controls.locator("input[type=range]").count() == 8
                labels = basis_controls.locator("span").all_text_contents()
                assert "GNM identity basis 000" in labels and "GNM expression basis 003" in labels, labels
                basis_diagnostics = page.evaluate("document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics")
                assert basis_diagnostics["basisIncluded"] is True, basis_diagnostics
                assert basis_diagnostics["semanticMapping"] == "disabled", basis_diagnostics
                assert basis_diagnostics["runtimeBasisLoaded"] is True, basis_diagnostics
                assert basis_diagnostics["identityCount"] == 4 and basis_diagnostics["expressionCount"] == 4, basis_diagnostics
                assert len(basis_diagnostics["selectedVectors"]) == 8, basis_diagnostics
                assert basis_diagnostics["activeCoefficients"] == [0] * 8, basis_diagnostics
                assert any(url.endswith("gnm-official-basis-lab.bin") for url in asset_requests), asset_requests
                def pixel_hash() -> str:
                    return page.evaluate("""() => {
                        const data = document.querySelector('#portrait-webgl').getContext('webgl2', { preserveDrawingBuffer: true })
                            .readPixels ? (() => {
                            const canvas = document.querySelector('#portrait-webgl');
                            const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
                            const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
                            gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                            return pixels;
                        })() : [];
                        let hash = 2166136261;
                        for (const value of data) hash = Math.imul(hash ^ value, 16777619);
                        return (hash >>> 0).toString(16).padStart(8, '0');
                    }""")
                neutral_hash = pixel_hash()
                slider = basis_controls.locator("input[type=range]").nth(0)
                assert slider.get_attribute("min") == "-0.25"
                assert slider.get_attribute("max") == "0.25"
                slider.fill("0.25")
                page.wait_for_function("() => document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics.activeCoefficients[0] === 0.25")
                changed_diagnostics = page.evaluate("document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics")
                changed_hash = pixel_hash()
                assert changed_diagnostics["activeCoefficients"] == [0.25] + [0] * 7, changed_diagnostics
                assert changed_hash != neutral_hash, {"neutral": neutral_hash, "changed": changed_hash}
                page.locator("#reset-basis-lab").click()
                page.wait_for_function("() => document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics.activeCoefficients.every((value) => value === 0)")
                reset_diagnostics = page.evaluate("document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics")
                reset_hash = pixel_hash()
                assert reset_diagnostics["activeCoefficients"] == [0] * 8, reset_diagnostics
                assert reset_hash == neutral_hash, {"neutral": neutral_hash, "reset": reset_hash}
                print(f"{entry} Basis Lab coefficients/pixels: neutral={neutral_hash} changed={changed_hash} reset={reset_hash}")
            else:
                assert page.locator("#portrait").is_visible(), f"{entry}: Basis Lab fallback must show the 2D canvas"
            print(f"PASS {entry} default renderer: Canvas 2D visible")
            print(f"{entry} {result}")
            context.close()
        assert not page_errors, page_errors
        console_errors = [message for message in messages if message.startswith("error:")]
        assert not console_errors, console_errors
        if messages:
            print(f"console messages: {messages}")
        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
