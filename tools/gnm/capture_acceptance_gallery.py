#!/usr/bin/env python3
"""Capture deterministic visual acceptance evidence for the GNM renderer."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


RENDERER = "sports/morph-gnm-v1"
EXPRESSION_MODE = "neutral"
SEED = 424242
AGE = 22
PRESENTATION = "neutral"
CANVAS_SIZE = 768

BASE_FACE_DNA = {
    "head": 4,
    "skin": 5,
    "eyes": 1,
    "brows": 2,
    "nose": 2,
    "mouth": 5,
    "freckles": 0,
    "eyeColor": 2,
    "earShape": 0,
    "jaw": 5,
    "faceProportion": 2,
    "hair": 9,
    "beard": 0,
    "hairColor": 3,
    "hairVisible": 1,
    "glasses": 0,
    "scar": 0,
}

FAMILIES = (
    ("gnm-01-compact", {"head": 4, "faceProportion": 2}),
    ("gnm-02-compact-wide", {"head": 1, "faceProportion": 0}),
    ("gnm-03-balanced", {"head": 0, "faceProportion": 2}),
    ("gnm-04-tapered", {"head": 5, "faceProportion": 2}),
    ("gnm-05-angular", {"head": 3, "faceProportion": 2}),
    ("gnm-06-broad", {"head": 1, "faceProportion": 2}),
    ("gnm-07-long", {"head": 2, "faceProportion": 2}),
    ("gnm-08-high-forehead", {"head": 0, "faceProportion": 5}),
)


class CdpError(RuntimeError):
    pass


class WebSocket:
    def __init__(self, url: str) -> None:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != "ws" or not parsed.hostname or not parsed.port:
            raise CdpError(f"Unsupported CDP websocket URL: {url}")
        self.socket = socket.create_connection((parsed.hostname, parsed.port), timeout=15)
        self.socket.settimeout(15)
        path = parsed.path or "/"
        if parsed.query:
            path += f"?{parsed.query}"
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {parsed.hostname}:{parsed.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        ).encode("ascii")
        self.socket.sendall(request)
        response = self._read_http_headers()
        if not response.startswith(b"HTTP/1.1 101"):
            raise CdpError(f"CDP websocket handshake failed: {response!r}")

    def _read_http_headers(self) -> bytes:
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = self.socket.recv(4096)
            if not chunk:
                raise CdpError("CDP websocket closed during handshake")
            data += chunk
        return data.split(b"\r\n\r\n", 1)[0]

    def _recv_exact(self, length: int) -> bytes:
        data = b""
        while len(data) < length:
            chunk = self.socket.recv(length - len(data))
            if not chunk:
                raise CdpError("CDP websocket closed unexpectedly")
            data += chunk
        return data

    def _read_frame(self) -> tuple[int, bytes]:
        first, second = self._recv_exact(2)
        opcode = first & 0x0F
        length = second & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._recv_exact(8))[0]
        mask = self._recv_exact(4) if second & 0x80 else b""
        payload = bytearray(self._recv_exact(length))
        if mask:
            for index in range(length):
                payload[index] ^= mask[index % 4]
        return opcode, bytes(payload)

    def send(self, payload: bytes, opcode: int = 1) -> None:
        mask = os.urandom(4)
        masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        length = len(masked)
        if length < 126:
            header = bytes([0x80 | opcode, 0x80 | length])
        elif length < 65536:
            header = bytes([0x80 | opcode, 0x80 | 126]) + struct.pack(">H", length)
        else:
            header = bytes([0x80 | opcode, 0x80 | 127]) + struct.pack(">Q", length)
        self.socket.sendall(header + mask + masked)

    def close(self) -> None:
        try:
            self.send(b"", opcode=8)
        except OSError:
            pass
        self.socket.close()


class Cdp:
    def __init__(self, websocket_url: str) -> None:
        self.websocket = WebSocket(websocket_url)
        self.next_id = 0

    def close(self) -> None:
        self.websocket.close()

    def command(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self.next_id += 1
        request_id = self.next_id
        self.websocket.send(json.dumps({"id": request_id, "method": method, "params": params or {}}).encode("utf-8"))
        while True:
            opcode, payload = self.websocket._read_frame()
            if opcode == 8:
                raise CdpError("CDP websocket closed")
            if opcode != 1:
                continue
            message = json.loads(payload.decode("utf-8"))
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise CdpError(f"{method}: {message['error']}")
            return message.get("result", {})


def evaluate(cdp: Cdp, expression: str, await_promise: bool = False) -> Any:
    result = cdp.command("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": await_promise})
    if result.get("exceptionDetails"):
        raise CdpError(result["exceptionDetails"].get("text", "Runtime.evaluate failed"))
    remote = result.get("result", {})
    if remote.get("subtype") == "error":
        raise CdpError(remote.get("description", "Runtime.evaluate returned an error"))
    return remote.get("value")


def wait_until(cdp: Cdp, expression: str, timeout: float = 15) -> Any:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = evaluate(cdp, expression)
        if value:
            return value
        time.sleep(0.05)
    raise CdpError(f"Timed out waiting for: {expression}")


def wait_for_cdp(port: int) -> None:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1):
                return
        except (OSError, urllib.error.URLError):
            time.sleep(0.1)
    raise CdpError(f"Chromium CDP did not start on port {port}")


def cdp_target(port: int, url: str) -> dict[str, Any]:
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/json/new?{urllib.parse.urlencode({'url': url})}",
        method="PUT",
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


def fixed_profile(overrides: dict[str, int]) -> dict[str, Any]:
    values = {**BASE_FACE_DNA, **overrides}
    return {
        "seed": SEED,
        "age": AGE,
        "presentation": PRESENTATION,
        "faceDNA": values,
        "kit": {"primary": "#b91c1c", "secondary": "#f8fafc"},
    }


def set_profile(cdp: Cdp, overrides: dict[str, int], show_landmarks: bool) -> None:
    values = json.dumps({**BASE_FACE_DNA, **overrides}, separators=(",", ":"))
    evaluate(cdp, f"""
      (() => {{
        const values = {values};
        const seed = document.querySelector('#seed');
        seed.value = String({SEED});
        document.querySelector('#apply-seed').click();
        const style = document.querySelector('#render-style');
        style.value = {json.dumps(RENDERER)};
        style.dispatchEvent(new Event('change', {{ bubbles: true }}));
        const expression = document.querySelector('#expression-mode');
        expression.value = {json.dumps(EXPRESSION_MODE)};
        expression.dispatchEvent(new Event('change', {{ bubbles: true }}));
        for (const [key, value] of Object.entries(values)) {{
          const select = document.querySelector(`select[data-feature="${{key}}"]`);
          if (!select) throw new Error(`Missing FaceDNA control: ${{key}}`);
          select.value = String(value);
          select.dispatchEvent(new Event('change', {{ bubbles: true }}));
        }}
        const landmarks = document.querySelector('#show-landmarks');
        if (landmarks.checked !== {str(show_landmarks).lower()}) landmarks.click();
        return true;
      }})()
    """)
    wait_until(cdp, "document.querySelector('#debug-output').textContent.includes('sports/morph-gnm-v1')")
    evaluate(cdp, "new Promise(resolve => setTimeout(resolve, 100))", await_promise=True)


def capture_entry(cdp: Cdp, expected_family: str, overrides: dict[str, int], show_landmarks: bool) -> tuple[dict[str, Any], bytes]:
    set_profile(cdp, overrides, show_landmarks)
    debug = json.loads(evaluate(cdp, "document.querySelector('#debug-output').textContent"))
    checks = evaluate(cdp, """
      (() => {
        const canvas = document.querySelector('#portrait');
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let nonBlankPixels = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index] || pixels[index + 1] || pixels[index + 2] || pixels[index + 3] !== 0) nonBlankPixels += 1;
        }
        return {
          width: canvas.width,
          height: canvas.height,
          nonBlankPixels,
          renderer: document.querySelector('#render-style').value,
          landmarksEnabled: document.querySelector('#show-landmarks').checked,
          unavailableMessage: document.body.innerText.includes('GNM morphology is unavailable'),
          browserErrors: window.__gnmAcceptanceErrors || [],
          dataUrl: canvas.toDataURL('image/png'),
        };
      })()
    """)
    data_url = checks.pop("dataUrl")
    image = base64.b64decode(data_url.split(",", 1)[1])
    mapping = debug.get("renderMapping", {})
    source = mapping.get("source", {})
    family = mapping.get("family", {})
    expression = mapping.get("expressionMode", {})
    checks.update({
        "expectedFamily": expected_family,
        "actualFamily": family.get("id"),
        "rendererMatches": debug.get("selectedRenderer") == RENDERER and checks["renderer"] == RENDERER,
        "sourceKind": source.get("kind"),
        "gnmDerived": source.get("gnmDerived"),
        "semanticFamilySelection": mapping.get("familySelection", {}).get("semantic"),
        "expressionSelected": expression.get("selected"),
        "noBrowserUnavailableMessage": not checks["unavailableMessage"],
        "canvasNonBlank": checks["nonBlankPixels"] > 0,
        "canvasSizeMatches": checks["width"] == CANVAS_SIZE and checks["height"] == CANVAS_SIZE,
        "landmarksModeMatches": checks["landmarksEnabled"] == show_landmarks,
        "browserErrors": checks["browserErrors"],
    })
    return {
        "familyId": expected_family,
        "faceDNA": fixed_profile(overrides),
        "checks": checks,
        "debug": debug,
        "sha256": hashlib.sha256(image).hexdigest(),
    }, image


def make_montage(output_dir: Path, entries: list[dict[str, Any]]) -> str | None:
    command = shutil.which("montage") or shutil.which("magick")
    if not command:
        return None
    output = output_dir / "gnm-acceptance-gallery.png"
    images = [str(output_dir / entry["file"]) for entry in entries]
    args = [command, *images, "-tile", "4x2", "-geometry", "384x384+12+32", "-background", "#111827", "-label", "%t", str(output)]
    if Path(command).name == "magick":
        args.insert(1, "montage")
    try:
        subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    except (OSError, subprocess.CalledProcessError):
        pass
    else:
        return output.name

    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return None
    try:
        cell_width, cell_height = 384, 416
        montage = Image.new("RGB", (cell_width * 4, cell_height * 2), "#111827")
        for index, entry in enumerate(entries):
            image = Image.open(output_dir / entry["file"]).convert("RGB")
            image.thumbnail((cell_width - 24, cell_height - 44))
            left = (index % 4) * cell_width + (cell_width - image.width) // 2
            top = (index // 4) * cell_height + 32
            montage.paste(image, (left, top))
            ImageDraw.Draw(montage).text(((index % 4) * cell_width + 12, 8 + (index // 4) * cell_height), entry["familyId"], fill="white")
        montage.save(output)
    except (OSError, ValueError):
        return None
    return output.name


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Capture the deterministic 8-family GNM browser acceptance gallery.")
    parser.add_argument("--url", default="http://127.0.0.1:8080/index.module.html", help="Running modular app URL")
    parser.add_argument("--output-dir", default="/tmp/sports-face-gnm-acceptance", help="Evidence output directory")
    parser.add_argument("--cdp-port", type=int, default=9222, help="Chromium remote debugging port")
    parser.add_argument("--chromium", default="chromium", help="Chromium executable")
    parser.add_argument("--landmarks", action="store_true", help="Capture with landmark overlay enabled")
    parser.add_argument("--keep-browser", action="store_true", help="Keep the Chromium process started by this script")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    browser: subprocess.Popen[str] | None = None
    cdp: Cdp | None = None
    try:
        browser = subprocess.Popen([
            args.chromium, "--headless=new", "--no-sandbox", "--disable-gpu",
            f"--remote-debugging-port={args.cdp_port}",
            f"--user-data-dir={tempfile.mkdtemp(prefix='sports-face-gnm-cdp-')}",
            "about:blank",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        wait_for_cdp(args.cdp_port)
        target = cdp_target(args.cdp_port, args.url)
        cdp = Cdp(target["webSocketDebuggerUrl"])
        cdp.command("Runtime.enable")
        cdp.command("Page.enable")
        cdp.command("Page.addScriptToEvaluateOnNewDocument", {"source": """
          (() => {
            window.__gnmAcceptanceErrors = [];
            window.addEventListener('error', event => window.__gnmAcceptanceErrors.push(`error: ${event.message}`));
            window.addEventListener('unhandledrejection', event => window.__gnmAcceptanceErrors.push(`unhandledrejection: ${event.reason}`));
            const originalError = console.error;
            console.error = (...args) => {
              window.__gnmAcceptanceErrors.push(`console.error: ${args.map(String).join(' ')}`);
              originalError.apply(console, args);
            };
          })();
        """})
        cdp.command("Page.navigate", {"url": args.url})
        wait_until(cdp, "document.readyState === 'complete' && document.querySelector('#debug-output').textContent.length > 0")

        entries = []
        for family_id, overrides in FAMILIES:
            entry, image = capture_entry(cdp, family_id, overrides, args.landmarks)
            entry["file"] = f"{family_id}{'-landmarks' if args.landmarks else ''}.png"
            (output_dir / entry["file"]).write_bytes(image)
            entries.append(entry)

        for entry in entries:
            checks = entry["checks"]
            if checks["actualFamily"] != checks["expectedFamily"]:
                raise CdpError(f"{entry['familyId']}: expected {checks['expectedFamily']}, got {checks['actualFamily']}")
            for key in ("rendererMatches", "semanticFamilySelection", "noBrowserUnavailableMessage", "canvasNonBlank", "canvasSizeMatches", "landmarksModeMatches"):
                if not checks[key]:
                    raise CdpError(f"{entry['familyId']}: acceptance check failed: {key}")
            if checks["sourceKind"] != "gnm-head-v3" or checks["gnmDerived"] is not True:
                raise CdpError(f"{entry['familyId']}: unexpected GNM pack source")
            if checks["expressionSelected"] != EXPRESSION_MODE:
                raise CdpError(f"{entry['familyId']}: unexpected expression mode")

        montage = make_montage(output_dir, entries)
        browser_errors = [error for entry in entries for error in entry["checks"]["browserErrors"]]
        if browser_errors:
            raise CdpError(f"Browser errors captured: {browser_errors}")
        manifest = {
            "schema": "sports-face-gnm-acceptance-gallery/v1",
            "renderer": RENDERER,
            "packSource": {"kind": "gnm-head-v3", "gnmDerived": True, "pack": "tools/gnm/work/gnm-morphology-pack.json"},
            "fixedInputs": {"seed": SEED, "age": AGE, "presentation": PRESENTATION, "expressionMode": EXPRESSION_MODE, "landmarks": args.landmarks, "baseFaceDNA": BASE_FACE_DNA},
            "familyIds": [family_id for family_id, _ in FAMILIES],
            "canvas": {"width": CANVAS_SIZE, "height": CANVAS_SIZE, "format": "image/png"},
            "browser": {"url": args.url, "mechanism": "Chromium CDP", "errors": browser_errors},
            "entries": entries,
            "montage": montage,
            "allChecksPassed": True,
        }
        (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
        summary = [
            "GNM 2D baseline acceptance gallery",
            f"Renderer: {RENDERER}",
            f"Inputs: seed={SEED}, age={AGE}, presentation={PRESENTATION}, expression={EXPRESSION_MODE}, landmarks={'on' if args.landmarks else 'off'}",
            f"Families: {', '.join(manifest['familyIds'])}",
            "Canvas: 768x768; browser errors: 0",
            f"Montage: {montage or 'not available; individual PNG files retained'}",
            f"Evidence: {output_dir}",
        ]
        (output_dir / "SUMMARY.txt").write_text("\n".join(summary) + "\n", encoding="utf-8")
        print("\n".join(summary))
        return 0
    except (CdpError, OSError, json.JSONDecodeError) as error:
        print(f"GNM acceptance capture failed: {error}", file=sys.stderr)
        return 1
    finally:
        if cdp is not None:
            cdp.close()
        if browser is not None and not args.keep_browser:
            browser.terminate()
            try:
                browser.wait(timeout=5)
            except subprocess.TimeoutExpired:
                browser.kill()


if __name__ == "__main__":
    raise SystemExit(main())
