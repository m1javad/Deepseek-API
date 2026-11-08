"""End-to-end test for paginated attachments.

The real site keeps only the currently selected attachment page as a
``blob:`` image and revokes the object URL when another page is clicked.
This test reproduces that in the mock page: three numbered buttons, one
viewer image, and ``URL.revokeObjectURL`` on the previous page's URL.

Two scenarios are checked:

* the viewer already shows page 1 when the extension starts;
* the viewer is empty and its first blob only appears after clicking "1"
  (some builds render the pager before the first page loads).

Run with the project venv:

    venv/Scripts/python.exe tests/pagination_smoke.py
"""

from __future__ import annotations

import tempfile
import threading
import time
from http.server import ThreadingHTTPServer

from playwright.sync_api import sync_playwright

from extension_smoke import (
    EXT,
    OCR_TEXT,
    Handler,
    click_launcher,
    current_worker,
    seed_settings,
    wait_for_launcher,
)

PAGED_HTML = """<!doctype html>
<html lang="fa" dir="rtl">
<head><meta charset="utf-8"><title>paged iapui</title></head>
<body>
  <div id="content">
    <main>
      <div>سربرگ</div>
      <div>داروی مصرفی: تست صفحه‌بندی
        <div data-slot="card">
          <div class="flex items-center gap-2">
            <p class="text-sm font-semibold">پیوست‌ها</p>
            <div class="flex flex-1 flex-wrap gap-2">
              <button type="button" class="bg-primary text-primary-foreground" data-page="1">1</button>
              <button type="button" class="border bg-white" data-page="2">2</button>
              <button type="button" class="border bg-white" data-page="3">3</button>
            </div>
          </div>
          <div class="react-transform-wrapper">
            <div class="react-transform-component">
              <div><img alt="page1.jpg" draggable="false"></div>
            </div>
          </div>
        </div>
      </div>
    </main>
  </div>
  <script>
    const INITIAL_EMPTY = __INITIAL_EMPTY__;
    const pages = {};
    const urls = {};
    let current = 1;

    async function makeBlob(page) {
      const c = document.createElement('canvas');
      c.width = 120; c.height = 120;
      const ctx = c.getContext('2d');
      const colors = {1: 'rgb(220,40,40)', 2: 'rgb(40,160,40)', 3: 'rgb(40,60,220)'};
      ctx.fillStyle = colors[page]; ctx.fillRect(0, 0, 120, 120);
      ctx.fillStyle = '#fff'; ctx.font = '48px sans-serif';
      ctx.fillText(String(page), 40, 80);
      return await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.9));
    }

    function activate(page) {
      const img = document.querySelector('.react-transform-wrapper img');
      const previous = urls[current];
      const nextUrl = URL.createObjectURL(pages[page]);
      urls[page] = nextUrl;
      img.src = nextUrl;
      img.alt = `page${page}.jpg`;
      current = page;
      document.querySelectorAll('[data-page]').forEach((button) => {
        button.className = Number(button.dataset.page) === page
          ? 'bg-primary text-primary-foreground'
          : 'border bg-white';
      });
      // Match the real app: the blob for the previous page is revoked.
      if (previous && previous !== nextUrl) {
        setTimeout(() => URL.revokeObjectURL(previous), 30);
      }
    }

    (async () => {
      pages[1] = await makeBlob(1);
      pages[2] = await makeBlob(2);
      pages[3] = await makeBlob(3);
      if (!INITIAL_EMPTY) {
        urls[1] = URL.createObjectURL(pages[1]);
        document.querySelector('.react-transform-wrapper img').src = urls[1];
      }
      document.querySelectorAll('[data-page]').forEach((button) => {
        button.addEventListener('click', () => activate(Number(button.dataset.page)));
      });
    })();
  </script>
</body>
</html>
"""


def wait_until(page, script, timeout_ms=60000, interval=300):
    """Poll with plain evaluates; wait_for_function's rAF polling is throttled
    when the visible test window is occluded."""
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        try:
            if page.evaluate(script):
                return True
        except Exception:
            pass
        page.wait_for_timeout(interval)
    return False


def reset_handler():
    Handler.uploads = 0
    Handler.converts = 0
    Handler.analyses = 0
    Handler.chats = 0
    Handler.analyzed_body = b""


def run_scenario(context, base, initially_empty):
    label = "empty viewer" if initially_empty else "preloaded viewer"
    print(f"\n=== scenario: {label} ===")
    reset_handler()

    page = context.new_page()
    html = PAGED_HTML.replace(
        "__INITIAL_EMPTY__", "true" if initially_empty else "false"
    )
    page.route(
        "https://iapui.ostaadx.ai/**",
        lambda route: route.fulfill(
            status=200, content_type="text/html; charset=utf-8", body=html
        ),
    )
    page.goto("https://iapui.ostaadx.ai/paged", wait_until="domcontentloaded")
    page.wait_for_selector("#ostaadx-insurance-assistant", state="attached", timeout=20000)
    print("panel attached")

    assert wait_for_launcher(page), f"{label}: start button did not appear"
    click_launcher(page)
    print("start button clicked")

    rendered = wait_until(
        page,
        """() => {
            const host = document.getElementById('ostaadx-insurance-assistant');
            const report = host && host.shadowRoot &&
              host.shadowRoot.querySelector('.report');
            return !!(report && report.textContent.includes('گزارش آزمایشی'));
        }""",
        timeout_ms=60000,
    )

    info = page.evaluate(
        """() => {
            const host = document.getElementById('ostaadx-insurance-assistant');
            const root = host && host.shadowRoot;
            const active = [...document.querySelectorAll('[data-page]')]
              .find((b) => b.className.includes('bg-primary'));
            return {
              cards: root ? root.querySelectorAll('.img-card').length : 0,
              images: root ? [...root.querySelectorAll('.img-card')]
                .map((c) => c.innerText.split('\\n')[0]).join(' | ') : '',
              status: root && root.querySelector('#statusLine')
                ? root.querySelector('#statusLine').textContent : '',
              active: active ? active.dataset.page : '',
            };
        }"""
    )
    print("rendered:", rendered)
    print("image cards:", info["cards"], "->", info["images"])
    print("status:", info["status"], "| active page after run:", info["active"])
    print(
        "uploads:", Handler.uploads,
        "converts:", Handler.converts,
        "analyses:", Handler.analyses,
    )

    assert rendered, f"{label}: report did not render"
    assert info["cards"] >= 3, f"{label}: expected one card per attachment page"
    assert Handler.uploads >= 3, f"{label}: expected an OCR upload per attachment page"
    assert Handler.converts >= 3, f"{label}: expected an OCR conversion per page"
    assert Handler.analyses == 1, f"{label}: expected exactly one analysis call"
    assert Handler.analyzed_body.count(OCR_TEXT.encode("utf-8")) >= 3, (
        f"{label}: all three OCR texts should be in the analyze request"
    )
    assert info["active"] == "1", f"{label}: the viewer should be restored to page 1"

    page.close()
    print(f"scenario passed: {label}")


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"

    user_data = tempfile.mkdtemp(prefix="ostaadx-paged-test-")
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

            run_scenario(context, base, initially_empty=False)
            run_scenario(context, base, initially_empty=True)

            print("PAGINATION TEST PASSED")
        finally:
            context.close()
            server.shutdown()


if __name__ == "__main__":
    main()
