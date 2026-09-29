#!/usr/bin/env python3
"""Browser smoke test for the sole GNM 3D Player path and explicit unavailable states."""

from __future__ import annotations

import os

from playwright.sync_api import sync_playwright

PLAYER_CANVAS = "#portrait-gnm3d"
PLAYER_DIAGNOSTICS = f"document.querySelector('{PLAYER_CANVAS}').__sportsFaceWebglDiagnostics"
# Offscreen-pipeline fallbacks: no float colour buffers (RGBA8 compressed
# encoding), and no multisampled renderbuffer storage (direct-to-canvas).
NO_FLOAT_COLOR_BUFFERS = """const getExtension = WebGL2RenderingContext.prototype.getExtension;
WebGL2RenderingContext.prototype.getExtension = function(name) {
  return name === 'EXT_color_buffer_float' ? null : getExtension.call(this, name);
};"""
NO_MULTISAMPLE_STORAGE = "WebGL2RenderingContext.prototype.renderbufferStorageMultisample = function() {};"


def player_pixel_summary(page) -> dict:
    """Mean colour, spread and a 24x24 luminance grid of the composited canvas."""
    return page.evaluate("""() => {
        const canvas = document.querySelector('#portrait-gnm3d');
        const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
        const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const mean = [0, 0, 0]; let squares = 0;
        const grid = new Array(24 * 24).fill(0), counts = new Array(24 * 24).fill(0);
        for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
          const i = (y * width + x) * 4;
          const luminance = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
          for (let c = 0; c < 3; c += 1) mean[c] += pixels[i + c];
          squares += luminance * luminance;
          const cell = Math.floor(y * 24 / height) * 24 + Math.floor(x * 24 / width);
          grid[cell] += luminance; counts[cell] += 1;
        }
        const n = width * height;
        const meanLuminance = (0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2]) / n;
        return { mean: mean.map((value) => value / n), std: Math.sqrt(Math.max(squares / n - meanLuminance * meanLuminance, 0)), grid: grid.map((value, cell) => value / counts[cell]) };
    }""")


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
    before_requests = 0
    page.wait_for_function(f"() => {{ const c = document.querySelector('{PLAYER_CANVAS}'); return c.__sportsFaceWebglDiagnostics && !c.hidden; }}", timeout=60000)
    assert page.locator("#render-style").count() == 0
    assert page.locator("#portrait, #portrait-webgl").count() == 0
    assert page.locator("#webgl-camera-controls").is_visible(), f"{entry}: camera controls should be visible"
    assert page.locator("#expression-mode-field").is_visible(), f"{entry}: micro-expression selector should be visible"
    diagnostics = page.evaluate(PLAYER_DIAGNOSTICS)
    assert diagnostics["renderer"] == "sports/gnm-3d-player-v1", diagnostics
    assert diagnostics["semanticMapping"] == "measured-landmark-features-v1", diagnostics
    assert diagnostics["officialTexturesIncluded"] is False and diagnostics["runtimeBasisLoaded"] is True, diagnostics
    assert diagnostics["identityPriorCount"] == 32 and diagnostics["featureCount"] == 19 and diagnostics["identityCoefficientCount"] == 170, diagnostics
    assert diagnostics["maxAbsIdentityCoefficient"] < 4.6, diagnostics
    assert diagnostics["framebufferStatus"] == "complete", diagnostics
    lighting = diagnostics["lighting"]
    assert lighting["model"] == "studio-environment-v3", lighting
    assert lighting["cavity"] == "local-normal-curvature", lighting
    assert lighting["shadowMap"]["status"] == "complete" and lighting["shadowMap"]["size"] >= 1024, lighting
    assert lighting["rimShadowMap"]["status"] == "complete", lighting
    bake = lighting["ambientOcclusionBake"]
    assert bake["status"] == "complete" and bake["directions"] == 32 and bake["points"] > 18000 and bake["storage"] == "gpu-texture", bake
    assert diagnostics["collar"]["model"] == "fitted-ribbed-crew-neck", diagnostics
    assert diagnostics["collar"]["ringVertices"] == 128, diagnostics
    assert all(0 <= diagnostics["groomingStrands"][key] <= cap for key, cap in (("hair", 16000), ("beard", 16000), ("brow", 4000))), diagnostics
    # Strand hair: built once per profile; the main view draws the full tier.
    hair = diagnostics["hair"]
    assert hair["model"] == "guide-interpolated-clumped-strands" and hair["strands"] == diagnostics["groomingStrands"]["hair"], hair
    if hair["strands"] > 0:
        assert hair["built"] == "full" and hair["guides"] > 0 and hair["babyHairs"] > 0, hair
        expected_lod = "full" if min(diagnostics["canvas"]["width"], diagnostics["canvas"]["height"]) > 320 else "reduced"
        assert hair["drawn"]["lod"] == expected_lod and hair["drawn"]["dithered"] is False, hair
    # Beard and brows are strands too: built once per profile, same levels of detail.
    facial = diagnostics["facialHair"]
    assert facial["model"] == "surface-walked-clumped-strands" and facial["underlay"] == "per-vertex-root-density", facial
    for part, key in (("beard", "beard"), ("brows", "brow")):
        built = facial[part]
        assert built["strands"] == diagnostics["groomingStrands"][key], (part, built)
        if built["strands"] > 0:
            expected_lod = "full" if min(diagnostics["canvas"]["width"], diagnostics["canvas"]["height"]) > 320 else "reduced"
            assert built["built"] == "full" and built["drawn"]["lod"] == expected_lod and built["drawn"]["dithered"] is False, (part, built)
    # Offscreen HDR pipeline: MSAA scene target, resolve, composite (tone mapping, grain, vignette, DOF).
    post = diagnostics["post"]
    assert post["pipeline"] == "offscreen" and post["status"] == "complete", post
    assert post["mode"] in ("float16", "rgba8-compressed") and post["samples"] >= 2, post
    assert post["framebuffers"] == {"scene": "complete", "resolve": "complete", "depthOfField": "complete"}, post
    assert post["toneMapping"] == "composite" and post["backdrop"] == "seamless-studio-paper", post
    assert post["grain"]["amplitude"] > 0 and 0 < post["vignette"]["strength"] <= 0.25, post
    size = diagnostics["canvas"]
    assert post["depthOfField"]["enabled"] == (min(size["width"], size["height"]) > 320), post
    eyes = diagnostics["eyes"]
    assert eyes["lashes"]["upper"] > 0 and eyes["lashes"]["lower"] > 0 and eyes["lashes"]["strands"] == eyes["lashes"]["upper"] + eyes["lashes"]["lower"], eyes
    assert eyes["tearLineVertices"] > 0 and eyes["contactSamples"] == 32, eyes
    assert diagnostics["camera"] == {"yaw": 0.38, "pitch": -0.06, "distance": 1}, diagnostics
    new_requests = asset_requests[before_requests:]
    assert any(url.endswith("gnm-player-generator.bin") for url in new_requests) and any(url.endswith("gnm-player-generator.json") for url in new_requests), new_requests
    # The first frame is drawn while the canvas is still hidden; take the
    # baseline from a redraw at the visible size.
    page.locator("#reset-webgl-camera").click()
    page.wait_for_timeout(300)
    neutral_hash = player_pixel_hash(page)
    bake_serial = page.evaluate(PLAYER_DIAGNOSTICS)["lighting"]["ambientOcclusionBake"]["bakeSerial"]
    visible = page.evaluate(PLAYER_DIAGNOSTICS)
    assert visible["post"]["framebuffers"]["scene"] == "complete" and visible["framebufferStatus"] == "complete", visible["post"]
    if visible["canvas"]["height"] >= 420:
        assert visible["eyes"]["lashes"]["drawn"] is True, visible["eyes"]
    page.locator("#reset-webgl-camera").click()
    page.wait_for_timeout(300)
    assert player_pixel_hash(page) == neutral_hash, "grain and depth of field are deterministic for the same profile and camera"

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
    orbited = page.evaluate(PLAYER_DIAGNOSTICS)["lighting"]["ambientOcclusionBake"]
    assert orbited["bakeSerial"] == bake_serial, "camera orbit must not re-bake ambient occlusion"

    identity = diagnostics["identityCoefficientsHead"]
    page.locator("#age").fill("48")
    page.wait_for_function(f"() => {PLAYER_DIAGNOSTICS}.camera && document.querySelector('#age-value').textContent === '48'")
    page.wait_for_timeout(400)
    aged = page.evaluate(PLAYER_DIAGNOSTICS)
    assert aged["identityCoefficientsHead"] == identity, "age must not change the GNM identity"
    assert aged["wrinkleStrength"] == 0.625, "skin wrinkles follow age, independently of hair pigment"
    nose = page.locator("select[data-feature=nose]")
    # Index 1 is nose/wide and 2 is nose/narrow; pick whichever differs from
    # the random starting player so the edit is never a no-op.
    target_index = 2 if nose.input_value() == "1" else 1
    nose.select_option(index=target_index)
    page.wait_for_function(f"() => {PLAYER_DIAGNOSTICS}.featureTargets.noseWidth !== undefined")
    widened = page.evaluate(PLAYER_DIAGNOSTICS)
    assert widened["identityCoefficientsHead"] == identity, "local edits must preserve the global GNM identity"
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
    # The session override must not mutate the facial code or lose identity.
    code = page.locator("#face-code").input_value()
    page.locator("select[data-feature=hairVisible]").select_option("1")
    page.wait_for_timeout(200)
    code = page.locator("#face-code").input_value()
    original = page.evaluate(PLAYER_DIAGNOSTICS)
    page.locator("#hairstyle-prototype").select_option("side-part")
    page.wait_for_function(f"() => {PLAYER_DIAGNOSTICS}.appearance.hairStyle === 'hair/prototype-side-part'")
    trial = page.evaluate(PLAYER_DIAGNOSTICS)
    assert trial["identityCoefficientsHead"] == original["identityCoefficientsHead"]
    assert page.locator("#face-code").input_value() == code
    assert 'hair/prototype-side-part' in page.locator("#debug-output").text_content()
    page.locator("#hairstyle-prototype").select_option("original")
    page.wait_for_function(f"() => {PLAYER_DIAGNOSTICS}.appearance.hairStyle !== 'hair/prototype-side-part'")
    assert page.evaluate(PLAYER_DIAGNOSTICS)["appearance"]["hairStyle"] == original["appearance"]["hairStyle"]
    return f"PASS GNM 3D Player: identity={identity[:3]} hash={neutral_hash} gallery=12"


def check_offscreen_fallbacks(browser, entry: str) -> str:
    """Same face through the float, RGBA8-compressed and direct-to-canvas paths."""
    code = None
    identity = None
    results = {}
    for label, init in (("float", None), ("rgba8", NO_FLOAT_COLOR_BUFFERS), ("direct", NO_MULTISAMPLE_STORAGE)):
        context = browser.new_context(accept_downloads=True)
        context.add_init_script("localStorage.setItem('sports-face-expression-mode', 'neutral')")
        if init:
            context.add_init_script(init)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(f"http://127.0.0.1:8080/{entry}")
        page.wait_for_load_state("networkidle")
        page.wait_for_function(f"() => {{ const c = document.querySelector('{PLAYER_CANVAS}'); return c.__sportsFaceWebglDiagnostics && !c.hidden; }}", timeout=60000)
        if code is None:
            code = page.locator("#face-code").input_value()
            identity = page.evaluate(PLAYER_DIAGNOSTICS)["identityCoefficientsHead"]
        else:
            page.locator("#face-code").fill(code)
            page.locator("#load-code").click()
            page.wait_for_function(f"(head) => JSON.stringify({PLAYER_DIAGNOSTICS}.identityCoefficientsHead) === JSON.stringify(head)", arg=identity, timeout=60000)
        page.locator("#reset-webgl-camera").click()
        page.wait_for_timeout(500)
        diagnostics = page.evaluate(PLAYER_DIAGNOSTICS)
        assert diagnostics["framebufferStatus"] == "complete", diagnostics["framebufferStatus"]
        drawn = diagnostics["hair"]["drawn"]
        if diagnostics["hair"]["strands"] > 0:
            # The direct fallback (no MSAA) draws the reduced tier with dithered coverage.
            assert (drawn["lod"], drawn["dithered"]) == (("reduced", True) if label == "direct" else ("full", False)), (label, drawn)
        brows = diagnostics["facialHair"]["brows"]
        if brows["strands"] > 0:
            assert (brows["drawn"]["lod"], brows["drawn"]["dithered"]) == (("reduced", True) if label == "direct" else ("full", False)), (label, brows["drawn"])
        summary = player_pixel_summary(page)
        assert summary["std"] > 12, f"{entry} {label}: rendered image is not blank ({summary['std']})"
        with page.expect_download() as download:
            page.locator("#download-png").click()
        assert download.value.suggested_filename.endswith(".png")
        assert not errors, errors
        results[label] = (diagnostics["post"], summary)
        context.close()
    float_post, float_pixels = results["float"]
    rgba8_post, rgba8_pixels = results["rgba8"]
    direct_post, direct_pixels = results["direct"]
    assert float_post["mode"] in ("float16", "rgba8-compressed"), float_post
    assert rgba8_post["mode"] == "rgba8-compressed" and rgba8_post["colorFormat"] == "RGBA8" and rgba8_post["pipeline"] == "offscreen", rgba8_post
    assert direct_post["pipeline"] == "direct" and direct_post["toneMapping"] == "scene-shader" and direct_post["depthOfField"]["enabled"] is False, direct_post
    grid_difference = lambda a, b: sum(abs(x - y) for x, y in zip(a["grid"], b["grid"])) / len(a["grid"])
    rgba8_difference = grid_difference(float_pixels, rgba8_pixels)
    direct_difference = grid_difference(float_pixels, direct_pixels)
    assert rgba8_difference < 3, f"{entry}: RGBA8 fallback matches the float path ({rgba8_difference:.2f})"
    assert direct_difference < 12, f"{entry}: direct fallback keeps the portrait ({direct_difference:.2f})"
    return f"PASS offscreen pipeline {float_post['mode']}/{float_post['samples']}x, RGBA8 fallback (grid diff {rgba8_difference:.2f}), direct fallback (grid diff {direct_difference:.2f}), exports"


def main() -> int:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"), args=["--enable-unsafe-swiftshader"])
        for entry in ("index.html", "index.module.html"):
            context = browser.new_context(accept_downloads=True)
            context.add_init_script("localStorage.setItem('sports-face-render-style', 'sports/default-v2')")
            page = context.new_page()
            errors = []
            requests = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("request", lambda request: requests.append(request.url))
            page.goto(f"http://127.0.0.1:8080/{entry}")
            page.wait_for_load_state("networkidle")
            print(entry, check_gnm_player(page, entry, requests))
            with page.expect_download() as download:
                page.locator("#download-png").click()
            assert download.value.suggested_filename.endswith(".png")
            code = page.locator("#face-code").input_value()
            page.locator("#new-player").click()
            page.locator("#face-code").fill(code)
            page.locator("#load-code").click()
            assert page.locator("#face-code").input_value() == code
            page.wait_for_function("!document.querySelector('#download-png').disabled")
            assert not errors, errors
            context.close()
            print(entry, check_offscreen_fallbacks(browser, entry))
            for failure in ("webgl", "asset"):
                context = browser.new_context()
                if failure == "webgl":
                    context.add_init_script("""const original = HTMLCanvasElement.prototype.getContext;
                    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
                      return type === 'webgl2' ? null : original.call(this, type, ...args);
                    };""")
                else:
                    context.route("**/gnm-player-generator.bin", lambda route: route.fulfill(status=200, body=b"invalid"))
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(f"http://127.0.0.1:8080/{entry}")
                page.wait_for_load_state("networkidle")
                page.wait_for_function("document.querySelector('#render-status').textContent.includes('No se puede')")
                assert not page.locator(PLAYER_CANVAS).is_visible()
                assert page.locator("#download-png").is_disabled()
                assert page.locator("#portrait, #portrait-webgl").count() == 0
                assert not errors, errors
                print(entry, failure, "PASS explicit error, no fallback, export disabled")
                context.close()
        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
