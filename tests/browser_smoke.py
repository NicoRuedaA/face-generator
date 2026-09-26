#!/usr/bin/env python3
"""Browser smoke test for default, official GNM WebGL, Basis Lab and GNM 3D Player paths."""

from __future__ import annotations

import os

from playwright.sync_api import sync_playwright

PLAYER_CANVAS = "#portrait-gnm3d"
PLAYER_DIAGNOSTICS = f"document.querySelector('{PLAYER_CANVAS}').__sportsFaceWebglDiagnostics"


def player_pixel_hash(page) -> str:
    return page.evaluate("""() => {
        const canvas = document.querySelector('#portrait-gnm3d');
        const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
        const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
        gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let hash = 2166136261;
        for (const value of pixels) hash = Math.imul(hash ^ value, 16777619);
        return (hash >>> 0).toString(16).padStart(8, '0');
    }""")


def check_gnm_player(page, entry: str, asset_requests: list[str]) -> str:
    """GNM 3D Player: diagnostics contract, camera, identity invariance, expressions, gallery."""
    selected = page.locator("#render-style")
    before_requests = len(asset_requests)
    selected.select_option("sports/gnm-3d-player-v1")
    page.wait_for_function(f"() => {{ const c = document.querySelector('{PLAYER_CANVAS}'); return (c.__sportsFaceWebglDiagnostics && !c.hidden) || !document.querySelector('#portrait').hidden; }}", timeout=60000)
    if not page.locator(PLAYER_CANVAS).is_visible():
        assert page.locator("#portrait").is_visible(), f"{entry}: GNM 3D Player fallback must show the 2D canvas"
        return f"BOUNDED FALLBACK: GNM 3D Player -> 2D GNM SVG ({page.locator('#toast').text_content()!r})"
    assert not page.locator("#portrait-webgl").is_visible(), f"{entry}: the shared WebGL canvas must stay hidden for the 3D player"
    assert page.locator("#webgl-camera-controls").is_visible(), f"{entry}: camera controls should be visible"
    assert page.locator("#expression-mode-field").is_visible(), f"{entry}: micro-expression selector should be visible"
    diagnostics = page.evaluate(PLAYER_DIAGNOSTICS)
    assert diagnostics["renderer"] == "sports/gnm-3d-player-v1", diagnostics
    assert diagnostics["semanticMapping"] == "measured-landmark-features-v1", diagnostics
    assert diagnostics["officialTexturesIncluded"] is False and diagnostics["runtimeBasisLoaded"] is True, diagnostics
    assert diagnostics["identityPriorCount"] == 32 and diagnostics["featureCount"] == 19 and diagnostics["identityCoefficientCount"] == 170, diagnostics
    assert diagnostics["maxAbsIdentityCoefficient"] < 4.6, diagnostics
    assert diagnostics["framebufferStatus"] == "complete", diagnostics
    assert diagnostics["camera"] == {"yaw": 0.38, "pitch": -0.06, "distance": 1}, diagnostics
    new_requests = asset_requests[before_requests:]
    assert any(url.endswith("gnm-player-generator.bin") for url in new_requests) and any(url.endswith("gnm-player-generator.json") for url in new_requests), new_requests
    # The first frame is drawn while the canvas is still hidden; take the
    # baseline from a redraw at the visible size.
    page.locator("#reset-webgl-camera").click()
    page.wait_for_timeout(300)
    neutral_hash = player_pixel_hash(page)

    canvas = page.locator(PLAYER_CANVAS)
    box = canvas.bounding_box()
    center_x = box["x"] + box["width"] / 2
    center_y = box["y"] + box["height"] / 2
    page.mouse.move(center_x, center_y)
    page.mouse.down()
    page.mouse.move(center_x + 90, center_y - 40, steps=4)
    page.mouse.up()
    page.wait_for_function(f"() => {PLAYER_DIAGNOSTICS}.camera.yaw !== 0.38")
    page.mouse.wheel(0, 240)
    page.wait_for_function(f"() => {PLAYER_DIAGNOSTICS}.camera.distance !== 1")
    page.locator("#reset-webgl-camera").click()
    page.wait_for_function(f"() => {{ const camera = {PLAYER_DIAGNOSTICS}.camera; return camera.yaw === 0.38 && camera.pitch === -0.06 && camera.distance === 1; }}")
    assert player_pixel_hash(page) == neutral_hash, "camera reset must restore the default portrait"

    identity = diagnostics["identityCoefficientsHead"]
    page.locator("#age").fill("48")
    page.wait_for_function(f"() => {PLAYER_DIAGNOSTICS}.camera && document.querySelector('#age-value').textContent === '48'")
    page.wait_for_timeout(400)
    aged = page.evaluate(PLAYER_DIAGNOSTICS)
    assert aged["identityCoefficientsHead"] == identity, "age must not change the GNM identity"
    nose = page.locator("select[data-feature=nose]")
    # Index 1 is nose/wide and 2 is nose/narrow; pick whichever differs from
    # the random starting player so the edit is never a no-op.
    target_index = 2 if nose.input_value() == "1" else 1
    nose.select_option(index=target_index)
    page.wait_for_function(f"() => {PLAYER_DIAGNOSTICS}.featureTargets.noseWidth !== undefined")
    widened = page.evaluate(PLAYER_DIAGNOSTICS)
    assert widened["identityCoefficientsHead"] != identity, "editing a geometric trait must change the GNM identity"
    nose_z = widened["identityFeatureZ"]["noseWidth"]
    assert (nose_z > 0.5) if target_index == 1 else (nose_z < -0.5), widened["identityFeatureZ"]
    page.locator("#expression-mode").select_option("focused")
    page.wait_for_function(f"() => {PLAYER_DIAGNOSTICS}.expression.mode === 'focused'")
    focused = page.evaluate(PLAYER_DIAGNOSTICS)
    assert focused["expression"]["weights"] == {"squint": 0.42}, focused["expression"]
    assert focused["identityCoefficientsHead"] == widened["identityCoefficientsHead"], "expressions must not change identity"
    page.locator("#expression-mode").select_option("auto")
    page.wait_for_function("() => [...document.querySelectorAll('.gallery-item canvas')].length === 12")
    page.wait_for_timeout(2500)
    painted = page.evaluate("""() => [...document.querySelectorAll('.gallery-item canvas')].filter((canvas) => {
        const data = canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
        return data[3] > 0;
    }).length""")
    assert painted == 12, f"{entry}: 3D gallery thumbnails missing ({painted}/12)"
    return f"PASS GNM 3D Player: identity={identity[:3]} hash={neutral_hash} gallery=12"


def main() -> int:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"))
        messages: list[str] = []
        page_errors: list[str] = []
        for entry in ("index.html", "index.module.html"):
            context = browser.new_context()
            page = context.new_page()
            asset_requests: list[str] = []
            page.route("**/favicon.ico", lambda route: route.fulfill(status=204, body=""))
            page.on("request", lambda request: asset_requests.append(request.url) if any(request.url.endswith(asset) for asset in ("gnm-official-head-render.glb", "gnm-official-basis-lab.bin", "gnm-official-basis-lab.json", "gnm-player-generator.bin", "gnm-player-generator.json")) else None)
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
            assert not asset_requests, f"{entry}: default renderer requested official WebGL assets: {asset_requests}"

            selected.select_option("sports/morph-webgl-official-v1")
            page.wait_for_timeout(1800)
            neutral_asset_request_count = len(asset_requests)
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
                assert diagnostics["materialModel"] == "neutral-procedural-components-v2", diagnostics
                assert diagnostics["materialModelVersion"] == "neutral-procedural-components-v2", diagnostics
                assert diagnostics["lighting"] == {"hemisphere": True, "key": True, "fill": True, "rim": True, "specular": True, "cavity": True}, diagnostics
                assert len(diagnostics["componentMaterialInfo"]) == 6, diagnostics
                assert [material["component"] for material in diagnostics["componentMaterialInfo"]] == ["skin", "left_eye", "right_eye", "upper_teeth_and_gums", "lower_teeth_and_gums", "tongue"], diagnostics
                assert [material["materialIndex"] for material in diagnostics["componentMaterialInfo"]] == list(range(6)), diagnostics
                assert all(material["materialSource"] == "neutral-procedural" and material["officialTexturesIncluded"] is False for material in diagnostics["componentMaterialInfo"]), diagnostics
                assert not any(url.endswith("gnm-official-basis-lab.bin") or url.endswith("gnm-official-basis-lab.json") for url in asset_requests[:neutral_asset_request_count]), asset_requests
                assert any(url.endswith("tools/gnm/work/gnm-official-head-render.glb") for url in asset_requests), asset_requests

                def pixel_sample() -> dict:
                    return page.evaluate("""() => {
                        const canvas = document.querySelector('#portrait-webgl');
                        const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
                        if (!gl || canvas.width <= 0 || canvas.height <= 0) {
                            return { readbackFailure: 'webgl2-unavailable-or-empty-canvas', samples: [] };
                        }
                        while (gl.getError() !== gl.NO_ERROR) {}
                        const coordinates = [[0, 0], [Math.floor(canvas.width / 2), Math.floor(canvas.height / 2)], [canvas.width - 1, canvas.height - 1]];
                        const samples = [];
                        for (const [x, y] of coordinates) {
                            const pixel = new Uint8Array(4);
                            gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
                            samples.push(...pixel);
                        }
                        const error = gl.getError();
                        return { readbackFailure: error === gl.NO_ERROR ? null : `gl-error-${error}`, samples };
                    }""")

                def pixel_hash() -> str:
                    return page.evaluate("""() => {
                        const canvas = document.querySelector('#portrait-webgl');
                        const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
                        const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
                        gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                        let hash = 2166136261;
                        for (const value of pixels) hash = Math.imul(hash ^ value, 16777619);
                        return (hash >>> 0).toString(16).padStart(8, '0');
                    }""")

                official_pixel_sample = pixel_sample()
                assert official_pixel_sample["readbackFailure"] is None, official_pixel_sample
                assert official_pixel_sample["samples"] and all(isinstance(value, int) and 0 <= value <= 255 for value in official_pixel_sample["samples"]), official_pixel_sample
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

                # --- Technical deformation visualization toggles (official neutral) ---
                tech_panel = page.locator("#technical-visualization-controls")
                assert tech_panel.is_visible(), f"{entry}: technical visualization panel should be visible in official style"
                uv_checker = page.locator("#uv-checker-toggle")
                wireframe_toggle = page.locator("#wireframe-toggle")
                assert not uv_checker.is_checked() and not wireframe_toggle.is_checked(), f"{entry}: toggles must default OFF"
                assert page.locator("#technical-visualization-state").inner_text() == "none"
                neutral_diagnostics = page.evaluate("document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics")
                assert neutral_diagnostics["technicalVisualization"] == "none", neutral_diagnostics
                assert "not an official texture" in neutral_diagnostics["technicalVisualizationNote"], neutral_diagnostics
                assert neutral_diagnostics["uvCheckerDensity"] == 16, neutral_diagnostics
                assert neutral_diagnostics["wireframeColor"] == [0.96, 0.16, 0.86], neutral_diagnostics
                neutral_hash = pixel_hash()

                uv_checker.check()
                page.wait_for_function("() => document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics.technicalVisualization === 'uv-checker'")
                assert page.locator("#technical-visualization-state").inner_text() == "uv-checker"
                uv_diagnostics = page.evaluate("document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics")
                assert uv_diagnostics["technicalVisualization"] == "uv-checker", uv_diagnostics
                uv_hash = pixel_hash()
                assert uv_hash != neutral_hash, {"neutral": neutral_hash, "uv": uv_hash}
                # Camera controls keep working while the checker is enabled.
                before_uv = uv_diagnostics["camera"]
                page.mouse.move(center_x, center_y)
                page.mouse.down()
                page.mouse.move(center_x + 64, center_y - 32, steps=3)
                page.mouse.up()
                page.wait_for_function("() => document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics.camera.yaw !== 0 || document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics.camera.pitch !== 0")
                after_uv_drag = page.evaluate("document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics")
                assert after_uv_drag["camera"]["yaw"] != before_uv["yaw"] or after_uv_drag["camera"]["pitch"] != before_uv["pitch"], after_uv_drag["camera"]
                assert after_uv_drag["technicalVisualization"] == "uv-checker", after_uv_drag
                page.locator("#reset-webgl-camera").click()
                page.wait_for_function("() => { const camera = document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics.camera; return camera.yaw === 0 && camera.pitch === 0 && camera.distance === 1; }")

                wireframe_toggle.check()
                page.wait_for_function("() => document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics.technicalVisualization === 'uv-checker+wireframe'")
                combined_diagnostics = page.evaluate("document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics")
                assert combined_diagnostics["technicalVisualization"] == "uv-checker+wireframe", combined_diagnostics
                assert combined_diagnostics["wireframeEdgeCount"] == 105972, combined_diagnostics
                combined_hash = pixel_hash()
                assert combined_hash != uv_hash and combined_hash != neutral_hash, {"neutral": neutral_hash, "uv": uv_hash, "combined": combined_hash}

                uv_checker.uncheck()
                page.wait_for_function("() => document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics.technicalVisualization === 'wireframe'")
                wireframe_diagnostics = page.evaluate("document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics")
                assert wireframe_diagnostics["technicalVisualization"] == "wireframe", wireframe_diagnostics
                wire_hash = pixel_hash()
                assert wire_hash != neutral_hash, {"neutral": neutral_hash, "wire": wire_hash}

                wireframe_toggle.uncheck()
                page.wait_for_function("() => document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics.technicalVisualization === 'none'")
                restored_hash = pixel_hash()
                assert restored_hash == neutral_hash, {"neutral": neutral_hash, "restored": restored_hash}
                print(f"{entry} official technical visualization: neutral={neutral_hash} uv={uv_hash} combined={combined_hash} wire={wire_hash} restored={restored_hash}")
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
                assert basis_diagnostics["materialModel"] == "neutral-procedural-components-v2", basis_diagnostics
                assert basis_diagnostics["lighting"] == {"hemisphere": True, "key": True, "fill": True, "rim": True, "specular": True, "cavity": True}, basis_diagnostics
                assert [material["materialIndex"] for material in basis_diagnostics["componentMaterialInfo"]] == list(range(6)), basis_diagnostics
                basis_requests = asset_requests[neutral_asset_request_count:]
                assert basis_requests and all(url.endswith("gnm-official-basis-lab.bin") or url.endswith("gnm-official-basis-lab.json") for url in basis_requests), basis_requests
                basis_pixel_sample = page.evaluate("""() => {
                    const canvas = document.querySelector('#portrait-webgl');
                    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
                    if (!gl || canvas.width <= 0 || canvas.height <= 0) {
                        return { readbackFailure: 'webgl2-unavailable-or-empty-canvas', samples: [] };
                    }
                    while (gl.getError() !== gl.NO_ERROR) {}
                    const coordinates = [[0, 0], [Math.floor(canvas.width / 2), Math.floor(canvas.height / 2)], [canvas.width - 1, canvas.height - 1]];
                    const samples = [];
                    for (const [x, y] of coordinates) {
                        const pixel = new Uint8Array(4);
                        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
                        samples.push(...pixel);
                    }
                    const error = gl.getError();
                    return { readbackFailure: error === gl.NO_ERROR ? null : `gl-error-${error}`, samples };
                }""")
                assert basis_pixel_sample["readbackFailure"] is None, basis_pixel_sample
                assert basis_pixel_sample["samples"] and all(isinstance(value, int) and 0 <= value <= 255 for value in basis_pixel_sample["samples"]), basis_pixel_sample
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

                # --- Technical deformation visualization toggles (Basis Lab) ---
                tech_panel = page.locator("#technical-visualization-controls")
                assert tech_panel.is_visible(), f"{entry}: technical visualization panel should be visible in Basis Lab style"
                basis_uv_checker = page.locator("#uv-checker-toggle")
                basis_wireframe = page.locator("#wireframe-toggle")
                assert not basis_uv_checker.is_checked() and not basis_wireframe.is_checked(), f"{entry}: toggles must default OFF"
                basis_neutral_diagnostics = page.evaluate("document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics")
                assert basis_neutral_diagnostics["technicalVisualization"] == "none", basis_neutral_diagnostics
                assert "not an official texture" in basis_neutral_diagnostics["technicalVisualizationNote"], basis_neutral_diagnostics
                # Re-apply a coefficient and prove the checker changes the deformed pixels.
                slider.fill("0.25")
                page.wait_for_function("() => document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics.activeCoefficients[0] === 0.25")
                coefficient_hash = pixel_hash()
                assert coefficient_hash != neutral_hash, {"neutral": neutral_hash, "coefficient": coefficient_hash}
                basis_uv_checker.check()
                page.wait_for_function("() => document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics.technicalVisualization === 'uv-checker'")
                assert page.locator("#technical-visualization-state").inner_text() == "uv-checker"
                basis_uv_diagnostics = page.evaluate("document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics")
                assert basis_uv_diagnostics["technicalVisualization"] == "uv-checker", basis_uv_diagnostics
                assert basis_uv_diagnostics["basisIncluded"] is True and basis_uv_diagnostics["activeCoefficients"] == [0.25] + [0] * 7, basis_uv_diagnostics
                checker_hash = pixel_hash()
                assert checker_hash != coefficient_hash, {"coefficient": coefficient_hash, "checker": checker_hash}
                # Camera controls keep working with checker + coefficient active.
                before_basis = basis_uv_diagnostics["camera"]
                page.mouse.move(center_x, center_y)
                page.mouse.down()
                page.mouse.move(center_x - 80, center_y + 40, steps=3)
                page.mouse.up()
                page.wait_for_function("() => { const d = document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics; return d.camera.yaw !== 0 || d.camera.pitch !== 0; }")
                after_basis_drag = page.evaluate("document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics")
                assert after_basis_drag["camera"]["yaw"] != before_basis["yaw"] or after_basis_drag["camera"]["pitch"] != before_basis["pitch"], after_basis_drag["camera"]
                assert after_basis_drag["technicalVisualization"] == "uv-checker", after_basis_drag
                page.locator("#reset-webgl-camera").click()
                page.wait_for_function("() => { const camera = document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics.camera; return camera.yaw === 0 && camera.pitch === 0 && camera.distance === 1; }")
                basis_wireframe.check()
                page.wait_for_function("() => document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics.technicalVisualization === 'uv-checker+wireframe'")
                basis_combined_diagnostics = page.evaluate("document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics")
                assert basis_combined_diagnostics["technicalVisualization"] == "uv-checker+wireframe", basis_combined_diagnostics
                assert basis_combined_diagnostics["wireframeEdgeCount"] == 105972, basis_combined_diagnostics
                combined_with_coefficient_hash = pixel_hash()
                assert combined_with_coefficient_hash != checker_hash, {"checker": checker_hash, "combined": combined_with_coefficient_hash}
                # Toggles off + coefficient reset restores the original neutral basis hash.
                basis_uv_checker.uncheck()
                basis_wireframe.uncheck()
                page.locator("#reset-basis-lab").click()
                page.wait_for_function("() => { const d = document.querySelector('#portrait-webgl').__sportsFaceWebglDiagnostics; return d.activeCoefficients.every((value) => value === 0) && d.technicalVisualization === 'none'; }")
                basis_restored_hash = pixel_hash()
                assert basis_restored_hash == neutral_hash, {"neutral": neutral_hash, "basis_restored": basis_restored_hash}
                print(f"{entry} Basis Lab technical visualization: coefficient={coefficient_hash} checker={checker_hash} combined={combined_with_coefficient_hash} restored={basis_restored_hash}")
            else:
                assert page.locator("#portrait").is_visible(), f"{entry}: Basis Lab fallback must show the 2D canvas"
            print(f"{entry} {check_gnm_player(page, entry, asset_requests)}")
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
