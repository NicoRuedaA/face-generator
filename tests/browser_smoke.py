#!/usr/bin/env python3
"""Browser smoke test for the default 2D path and opt-in WebGL fallback contract."""

from __future__ import annotations

from playwright.sync_api import sync_playwright


def main() -> int:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path="/usr/bin/chromium")
        messages: list[str] = []
        for entry in ("index.html", "index.module.html"):
            page = browser.new_page()
            page.on("console", lambda message: messages.append(f"{message.type}: {message.text}"))
            page.goto(f"http://127.0.0.1:8080/{entry}")
            page.wait_for_load_state("networkidle")
            page.wait_for_function("document.querySelector('#portrait').width > 0")
            assert page.locator("#portrait").is_visible(), f"{entry}: default 2D canvas is not visible"
            assert not page.locator("#portrait-webgl").is_visible(), f"{entry}: WebGL canvas should be hidden by default"
            selected = page.locator("#render-style")
            assert selected.input_value() == "sports/default-v2", selected.input_value()

            selected.select_option("sports/morph-webgl-v1")
            page.wait_for_timeout(1800)
            webgl_visible = page.locator("#portrait-webgl").is_visible()
            fallback_visible = page.locator("#portrait").is_visible()
            diagnostic = page.locator("#toast").text_content() or ""
            assert webgl_visible or fallback_visible, f"{entry}: neither WebGL nor 2D fallback canvas is visible"
            if webgl_visible:
                result = "PASS WebGL2: opt-in canvas visible"
            else:
                assert "WebGL2" in diagnostic or "fallback" in diagnostic.lower(), diagnostic
                result = f"BOUNDED FALLBACK: 2D GNM SVG visible; diagnostic={diagnostic!r}"
            print(f"PASS {entry} default renderer: Canvas 2D visible")
            print(f"{entry} {result}")
            page.close()
        if messages:
            print(f"console messages: {messages}")
        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
