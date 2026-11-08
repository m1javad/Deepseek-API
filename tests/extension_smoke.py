"""End-to-end smoke test for the Chrome extension.

Run with the project venv:

    venv/Scripts/python.exe tests/extension_smoke.py

The target page (https://iapui.ostaadx.ai), the eboo OCR API and the DeepSeek
backend are all mocked locally, so no real account, token or document is used.
A visible Chromium window opens because unpacked extensions need a real browser.
"""

from __future__ import annotations

import json
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"

HTML = """<!doctype html>
<html lang="fa" dir="rtl">
<head><meta charset="utf-8"><title>mock iapui</title></head>
<body>
  <div id="content">
    <main>
      <div>سربرگ</div>
      <div>داروی مصرفی: تست خودکار</div>
    </main>
  </div>
  <img id="img1" alt="doc1">
  <div style="height: 2400px"></div>
  <script>
    async function makeBlob(color) {
      const c = document.createElement('canvas');
      c.width = 80; c.height = 80;
      const ctx = c.getContext('2d');
      ctx.fillStyle = color; ctx.fillRect(0, 0, 80, 80);
      return await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
    }
    (async () => {
      const first = await makeBlob('red');
      document.getElementById('img1').src = URL.createObjectURL(first);
      const second = await makeBlob('blue');
      const img = document.createElement('img');
      img.src = URL.createObjectURL(second);
      document.body.appendChild(img);
    })();

    // A lazy image that only appears after the extension's scroll pass.
    let lazyAdded = false;
    window.addEventListener('scroll', async () => {
      if (lazyAdded) return;
      lazyAdded = true;
      const blob = await makeBlob('green');
      const img = document.createElement('img');
      img.src = URL.createObjectURL(blob);
      document.body.appendChild(img);
    });
  </script>
</body>
</html>
"""

OCR_TEXT = "متن آزمایشی سند: آموکسی‌سیلین ۵۰۰"


class Handler(BaseHTTPRequestHandler):
    uploads = 0
    converts = 0
    analyses = 0
    chats = 0
    analyzed_body = b""

    def log_message(self, *args):  # silence the default request log
        pass

    def _send(self, status, body, content_type="application/json; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/healthz":
            self._send(200, json.dumps({"status": "ok"}))
        else:
            self._send(404, json.dumps({"detail": "not found"}))

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length)

        if self.path == "/ocr":
            if b'name="command"' in body and b"addfile" in body:
                Handler.uploads += 1
                self._send(200, json.dumps({"Status": "Done", "FileToken": "mock-token"}))
            elif b"convert" in body:
                Handler.converts += 1
                self._send(
                    200,
                    f"<html><body>{OCR_TEXT}</body></html>",
                    "text/html; charset=utf-8",
                )
            else:
                self._send(400, json.dumps({"Status": "BadCommand"}))
        elif self.path == "/api/analyze":
            Handler.analyses += 1
            Handler.analyzed_body = body
            self._send(
                200,
                json.dumps(
                    {
                        "answer": "## گزارش آزمایشی\n\nسند اول: قابل پرداخت.",
                        "conversation_id": "mock:1",
                    }
                ),
            )
        elif self.path == "/api/chat":
            Handler.chats += 1
            self._send(
                200,
                json.dumps(
                    {"answer": "پاسخ پیگیری آزمایشی", "conversation_id": "mock:2"}
                ),
            )
        else:
            self._send(404, json.dumps({"detail": "not found"}))


def current_worker(context):
    workers = context.service_workers
    return workers[0] if workers else context.wait_for_event("serviceworker", timeout=20000)


def seed_settings(worker, values, attempts=10):
    """Seed storage after onInstalled's own default-seeding has settled.

    `onInstalled` reads/writes asynchronously right after the extension loads;
    seeding immediately can race and be overwritten by the defaults, silently
    sending the test to the real eboo/backend. Wait, then write and verify.
    """
    time.sleep(1.5)
    stored = {}
    for _ in range(attempts):
        worker.evaluate(
            """async (values) => {
                await chrome.storage.local.set(values);
            }""",
            values,
        )
        time.sleep(0.35)
        stored = worker.evaluate(
            "async () => await chrome.storage.local.get(null)"
        )
        if all(stored.get(key) == value for key, value in values.items()):
            return stored
    raise RuntimeError(f"could not seed extension settings: {stored!r}")


def wait_until(page, script, timeout_ms=60000, interval=300):
    """Poll with plain evaluates. `wait_for_function` defaults to rAF polling,
    which Chrome throttles while the visible test window is occluded."""
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        try:
            if page.evaluate(script):
                return True
        except Exception:
            pass
        page.wait_for_timeout(interval)
    return False


def wait_for_launcher(page, timeout_ms=20000):
    """The pipeline is manual now: a small start button must appear."""
    return wait_until(
        page,
        """() => {
            const host = document.getElementById('ostaadx-insurance-assistant');
            const btn = host && host.shadowRoot &&
              host.shadowRoot.querySelector('#ostaadx-launcher');
            return !!(btn && getComputedStyle(btn).display !== 'none' &&
              host.style.display !== 'none');
        }""",
        timeout_ms=timeout_ms,
    )


def click_launcher(page):
    page.evaluate(
        """() => {
            const host = document.getElementById('ostaadx-insurance-assistant');
            const btn = host && host.shadowRoot &&
              host.shadowRoot.querySelector('#ostaadx-launcher');
            if (btn) btn.click();
        }"""
    )


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"

    user_data = tempfile.mkdtemp(prefix="ostaadx-ext-test-")
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data,
            headless=False,
            args=[
                f"--disable-extensions-except={EXT}",
                f"--load-extension={EXT}",
                "--no-first-run",
                "--no-default-browser-check",
            ],
            viewport={"width": 1200, "height": 900},
        )
        try:
            worker = current_worker(context)
            print("service worker:", worker.url)

            seed_settings(
                worker,
                {
                    "enabled": True,
                    "backendUrl": base,
                    "ebooUrl": base + "/ocr",
                    "autoDownload": False,
                },
            )

            page = context.new_page()
            page.route(
                "https://iapui.ostaadx.ai/**",
                lambda route: route.fulfill(
                    status=200, content_type="text/html; charset=utf-8", body=HTML
                ),
            )
            page.goto("https://iapui.ostaadx.ai/test", wait_until="domcontentloaded")

            page.wait_for_selector(
                "#ostaadx-insurance-assistant", state="attached", timeout=20000
            )
            print("panel attached")

            assert wait_for_launcher(page), "start button did not appear"
            click_launcher(page)
            print("start button clicked")

            assert wait_until(
                page,
                """() => {
                    const host = document.getElementById('ostaadx-insurance-assistant');
                    const report = host && host.shadowRoot && host.shadowRoot.querySelector('.report');
                    return !!(report && report.textContent.includes('گزارش آزمایشی'));
                }""",
                timeout_ms=60000,
            ), "report did not render"

            report = page.evaluate(
                """() => {
                    const host = document.getElementById('ostaadx-insurance-assistant');
                    const root = host.shadowRoot;
                    return {
                      report: root.querySelector('.report').innerText,
                      images: root.querySelectorAll('.img-card').length,
                      status: root.querySelector('#statusLine').textContent,
                    };
                }"""
            )
            print("report:", report["report"].replace("\n", " | "))
            print("image cards:", report["images"])
            print("status:", report["status"])
            print(
                "uploads:", Handler.uploads,
                "converts:", Handler.converts,
                "analyses:", Handler.analyses,
            )

            assert Handler.uploads >= 3, "expected the two initial + one lazy OCR upload"
            assert Handler.converts >= 3, "expected at least three OCR conversions"
            assert Handler.analyses == 1, "expected exactly one analysis call"
            assert OCR_TEXT.encode("utf-8") in Handler.analyzed_body, (
                "OCR text missing from the analyze request body"
            )
            assert report["images"] >= 3, "expected three image cards"

            # Follow-up chat reuses the conversation id from the analysis.
            page.evaluate(
                """() => {
                    const host = document.getElementById('ostaadx-insurance-assistant');
                    const root = host.shadowRoot;
                    root.querySelector('#chatInput').value = 'سوال پیگیری';
                    root.querySelector('#btnSend').click();
                }"""
            )
            assert wait_until(
                page,
                """() => {
                    const host = document.getElementById('ostaadx-insurance-assistant');
                    const chat = host && host.shadowRoot && host.shadowRoot.querySelector('.chat');
                    return !!(chat && chat.textContent.includes('پاسخ پیگیری آزمایشی'));
                }""",
                timeout_ms=20000,
            ), "follow-up chat did not render"
            assert Handler.chats == 1, "expected one follow-up chat call"
            print("follow-up chat: ok")

            # Turning the toggle off must hide the panel and persist the setting.
            page.evaluate(
                """() => {
                    const host = document.getElementById('ostaadx-insurance-assistant');
                    const toggle = host.shadowRoot.querySelector('#toggle');
                    toggle.checked = false;
                    toggle.dispatchEvent(new Event('change'));
                }"""
            )
            page.wait_for_timeout(600)

            enabled = current_worker(context).evaluate(
                "async () => (await chrome.storage.local.get({enabled:true})).enabled"
            )
            visible = page.evaluate(
                """() => {
                    const host = document.getElementById('ostaadx-insurance-assistant');
                    return host.style.display !== 'none';
                }"""
            )
            print("enabled after toggle:", enabled, "panel visible:", visible)
            assert enabled is False, "toggle should persist enabled=false"
            assert visible is False, "panel should hide when disabled"

            print("SMOKE TEST PASSED")
        finally:
            context.close()
            server.shutdown()


if __name__ == "__main__":
    main()
