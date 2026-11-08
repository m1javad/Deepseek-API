/*
 * Content script for https://iapui.ostaadx.ai/*
 *
 * Watches for the medication section, harvests every blob: image on the page
 * (including lazy-loaded ones, same-origin iframes, CSS backgrounds and
 * canvases), sends the bytes to the service worker for OCR, and finally asks
 * the local DeepSeek backend to evaluate the extracted documents.
 *
 * The whole UI lives in a shadow root so the host page's CSS cannot leak in.
 */

(() => {
  'use strict';

  if (window.__ostaadxInsuranceAssistant) return;
  window.__ostaadxInsuranceAssistant = true;

  /* ------------------------------------------------------------- constants */

  const CFG = {
    triggerXPath: '//*[@id="content"]/main/div[2]',
    phrase: 'داروی مصرفی',
    // Normalised comparison target (Arabic/Persian letter variants, ZWNJ, ...).
    phraseNorm: normalizeFa('داروی مصرفی'),
    maxDocs: 4,
    ocrConcurrency: 3,
    // Attachment viewers keep only the active page as a blob: image; switching
    // pages revokes the old one. Cap how many page buttons we click through.
    maxAttachmentPages: 30,
    pageLoadTimeout: 10000,
  };

  const state = {
    enabled: true,
    running: false,
    runToken: 0,
    phase: 'idle',
    lastRunKey: null,
    dismissedKey: null,
    triggerKey: null,
    conversationId: null,
    ocrText: '',
    results: new Map(), // url/synthetic key -> record
    harvestedRoots: new WeakSet(), // attachment cards whose pages were captured
    nextIndex: 1,
    panel: null,
    shadow: null,
    els: {},
  };

  const canvasKeys = new WeakMap();
  let canvasCounter = 0;
  let pendingTimer = null;
  let pendingKey = null;
  let observerTimer = null;

  /* --------------------------------------------------------------- helpers */

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function logDiag(...args) {
    try {
      console.info('[ostaadx-assistant]', ...args);
    } catch {
      // console may be unavailable in rare contexts
    }
  }

  function normalizeFa(value) {
    return String(value || '')
      .replace(/[يى]/g, 'ی') // Arabic yeh -> Persian yeh
      .replace(/ك/g, 'ک') // Arabic kaf -> Persian kaf
      .replace(/[​-‏‪-‮﻿]/g, '') // ZWNJ, bidi marks
      .replace(/[ً-ٰٟ]/g, '') // diacritics
      .replace(/\s+/g, ' ')
      .trim();
  }

  function hashString(value) {
    let hash = 5381;
    for (let i = 0; i < value.length; i++) {
      hash = ((hash * 33) ^ value.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function isBlobUrl(value) {
    return typeof value === 'string' && value.startsWith('blob:');
  }

  function mimeToExt(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.includes('pdf')) return 'pdf';
    if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
    if (m.includes('webp')) return 'webp';
    if (m.includes('gif')) return 'gif';
    if (m.includes('bmp')) return 'bmp';
    if (m.includes('tiff')) return 'tiff';
    return 'png';
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const data = String(reader.result || '');
        const comma = data.indexOf(',');
        resolve(comma >= 0 ? data.slice(comma + 1) : data);
      };
      reader.onerror = () => reject(reader.error || new Error('خواندن فایل ناموفق بود'));
      reader.readAsDataURL(blob);
    });
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            resolve({ ok: false, error: 'ارتباط با پس‌زمینهٔ افزونه قطع شد: ' + error.message });
          } else {
            resolve(response || { ok: false, error: 'پاسخ خالی از پس‌زمینهٔ افزونه' });
          }
        });
      } catch (err) {
        resolve({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    });
  }

  /* ------------------------------------------------------------- documents */

  function collectDocuments(rootDoc, out = [], depth = 0) {
    if (!rootDoc || out.includes(rootDoc)) return out;
    out.push(rootDoc);
    if (depth >= 3) return out;
    let frames;
    try {
      frames = rootDoc.querySelectorAll('iframe, frame');
    } catch {
      return out;
    }
    for (const frame of frames) {
      try {
        const inner = frame.contentDocument;
        if (inner) collectDocuments(inner, out, depth + 1);
      } catch {
        // cross-origin iframe: inaccessible, skip
      }
    }
    return out;
  }

  function findTriggerElement() {
    for (const doc of collectDocuments(document)) {
      try {
        const result = doc.evaluate(
          CFG.triggerXPath,
          doc,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        );
        if (result.singleNodeValue) return result.singleNodeValue;
      } catch {
        // XPath unsupported in this document, try the next one
      }
    }
    return null;
  }

  function triggerMentionsPhrase(element) {
    if (!element) return false;
    const raw = element.textContent || '';
    if (raw.includes(CFG.phrase)) return true;
    // Fall back to a normalised comparison for Arabic letter variants.
    return normalizeFa(raw.slice(0, 60000)).includes(CFG.phraseNorm);
  }

  function triggerKey(element) {
    const raw = normalizeFa((element && element.textContent) || '').replace(/\d+/g, '#');
    return location.href + '|' + hashString(raw.slice(0, 4000));
  }

  /* --------------------------------------------------------------- capture */

  function canvasKey(canvas) {
    if (!canvasKeys.has(canvas)) {
      canvasCounter += 1;
      canvasKeys.set(canvas, `__canvas__${canvasCounter}__`);
    }
    return canvasKeys.get(canvas);
  }

  function discoverBlobs({ deep = false } = {}) {
    const items = new Map(); // stable key -> { url, kind, element }
    const docs = collectDocuments(document);

    // After the pagination harvest, the viewer card may show a fresh object URL
    // for a page we already captured (e.g. after restoring the original page).
    // Ignore blobs inside that card to avoid OCR-ing the same page twice.
    const isHarvested = (el) => {
      let node = el;
      for (let depth = 0; depth < 8 && node; depth += 1, node = node.parentElement) {
        if (state.harvestedRoots.has(node)) return true;
      }
      return false;
    };

    for (const doc of docs) {
      // <img>, <input type=image>
      let images = [];
      try {
        images = doc.querySelectorAll('img, input[type="image"]');
      } catch {
        images = [];
      }
      for (const img of images) {
        if (isHarvested(img)) continue;
        const src = img.currentSrc || img.src || img.getAttribute('src') || '';
        if (isBlobUrl(src) && !items.has(src)) {
          items.set(src, { url: src, kind: 'img', element: img });
        }
      }

      // <a href="blob:...">
      let links = [];
      try {
        links = doc.querySelectorAll('a[href]');
      } catch {
        links = [];
      }
      for (const link of links) {
        if (isHarvested(link)) continue;
        const href = link.href || link.getAttribute('href') || '';
        if (isBlobUrl(href) && !items.has(href)) {
          items.set(href, { url: href, kind: 'link', element: link });
        }
      }

      // inline background-image: url("blob:...")
      let inline = [];
      try {
        inline = doc.querySelectorAll('[style*="blob:"]');
      } catch {
        inline = [];
      }
      for (const el of inline) {
        if (isHarvested(el)) continue;
        const style = el.getAttribute('style') || '';
        const match = /url\(["']?(blob:[^"')]+)["']?\)/i.exec(style);
        if (match && !items.has(match[1])) {
          items.set(match[1], { url: match[1], kind: 'bg', element: el });
        }
      }
    }

    // Computed backgrounds are expensive: only do this on a deep scan. They can
    // coexist with <img> blobs, so this is not gated on `items.size`.
    if (deep) {
      for (const doc of docs) {
        const win = doc.defaultView;
        if (!win) continue;
        const scope = doc.getElementById('content') || doc.body;
        if (!scope) continue;
        let elements = [];
        try {
          elements = scope.querySelectorAll('*');
        } catch {
          elements = [];
        }
        const limit = Math.min(elements.length, 4000);
        for (let i = 0; i < limit; i++) {
          const el = elements[i];
          if (isHarvested(el)) continue;
          let bg = '';
          try {
            bg = win.getComputedStyle(el).backgroundImage || '';
          } catch {
            continue;
          }
          const match = /url\(["']?(blob:[^"')]+)["']?\)/i.exec(bg);
          if (match && !items.has(match[1])) {
            items.set(match[1], { url: match[1], kind: 'bg', element: el });
          }
        }
      }
    }

    // Canvas-based viewers are the last resort.
    if (deep && items.size === 0) {
      for (const doc of docs) {
        let canvases = [];
        try {
          canvases = doc.querySelectorAll('canvas');
        } catch {
          canvases = [];
        }
        for (const canvas of canvases) {
          if ((canvas.width || 0) < 40 || (canvas.height || 0) < 40) continue;
          if (isHarvested(canvas)) continue;
          const key = canvasKey(canvas);
          if (!items.has(key)) {
            items.set(key, { url: key, kind: 'canvas', element: canvas });
          }
        }
      }
    }

    return items;
  }

  async function fetchBlobBytes(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const blob = await response.blob();
    return {
      blob,
      mime: blob.type || response.headers.get('content-type') || 'image/png',
      base64: await blobToBase64(blob),
    };
  }

  async function canvasBytes(canvas) {
    const blob = await new Promise((resolve, reject) => {
      try {
        canvas.toBlob((result) => {
          if (result) resolve(result);
          else reject(new Error('تبدیل canvas ناموفق بود'));
        }, 'image/png');
      } catch (err) {
        reject(err);
      }
    });
    return { blob, mime: 'image/png', base64: await blobToBase64(blob) };
  }

  async function imageBytes(img, fallbackUrl) {
    try {
      return await fetchBlobBytes(img.currentSrc || img.src || fallbackUrl);
    } catch (err) {
      // Blob fetch can fail for detached/lazy nodes; drawing the <img> into a
      // canvas usually still works because it is same-origin.
      if (!img.complete) {
        try {
          await img.decode();
        } catch {
          // ignore and try the canvas anyway
        }
      }
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      if (!width || !height) throw err;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      return canvasBytes(canvas);
    }
  }

  async function itemBytes(item) {
    if (item.kind === 'canvas') return canvasBytes(item.element);
    if (item.kind === 'img') return imageBytes(item.element, item.url);
    return fetchBlobBytes(item.url);
  }

  /* ---------------------------------------------------- paginated attachments */
  //
  // The real page renders one <img src="blob:..."> inside a react-zoom-pan-pinch
  // viewer. The blob only exists for the currently selected attachment page;
  // clicking "2", "3", ... swaps in a new object URL and the old one is revoked.
  // We therefore click every page button and fetch the blob immediately.

  function toEnDigits(value) {
    return String(value || '')
      .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  }

  function imageUrl(img) {
    if (!img) return '';
    const url = img.currentSrc || img.src || '';
    return isBlobUrl(url) ? url : '';
  }

  function isActivePageButton(button) {
    if (!button) return false;
    const cls = String(button.className || '');
    return (
      /(^|\s)bg-primary(\s|$)/.test(cls) ||
      button.getAttribute('aria-current') === 'page' ||
      button.getAttribute('data-state') === 'active'
    );
  }

  function viewerImage(root, doc) {
    const scope = root || doc || document;
    let img = null;
    try {
      img = scope.querySelector(
        '.react-transform-wrapper img, .react-transform-component img, [class*="transform-component"] img'
      );
    } catch {
      img = null;
    }
    if (!img) {
      try {
        img = [...scope.querySelectorAll('img')].find((node) => imageUrl(node)) || null;
      } catch {
        img = null;
      }
    }
    return img;
  }

  function findAttachmentPagerIn(scope, doc) {
    if (!scope || !scope.querySelectorAll) return null;

    let labels = [];
    try {
      // `div` is included because some builds wrap the heading in a plain div.
      labels = scope.querySelectorAll('p, span, h2, h3, h4, div');
    } catch {
      return null;
    }

    let best = null;
    const seenCards = new Set();
    const limit = Math.min(labels.length, 8000);
    for (let i = 0; i < limit; i++) {
      const label = labels[i];
      if (label.children.length) continue;
      const text = normalizeFa(label.textContent).replace(/\s+/g, '');
      // Exact "پیوستها" plus tolerant variants ("پیوست‌ها (۶)", "پیوست‌ها:"),
      // but not words like "پیوست‌های".
      const isPagerLabel =
        text === 'پیوستها' || /^پیوستها[:(]/.test(text) || /^پیوستها\d+$/.test(text);
      if (!isPagerLabel) continue;

      // Walk up from the "پیوست‌ها" heading until we find the group that holds
      // the numeric page buttons (1, 2, 3, ...).
      let node = label.parentElement;
      for (let depth = 0; depth < 6 && node; depth += 1, node = node.parentElement) {
        const numbers = new Map();
        let buttons = [];
        try {
          buttons = node.querySelectorAll('button');
        } catch {
          break;
        }
        for (const button of buttons) {
          const valueText = toEnDigits((button.textContent || '').trim());
          if (!/^\d{1,3}$/.test(valueText)) continue;
          const value = Number(valueText);
          if (!numbers.has(value)) numbers.set(value, button);
        }
        if (numbers.size < 2) continue;

        const card = label.closest('[data-slot="card"]') || node;
        if (seenCards.has(card)) break;
        seenCards.add(card);

        const viewer = viewerImage(card, label.ownerDocument || doc || document);
        const hasViewer =
          !!viewer ||
          !!card.querySelector('.react-transform-wrapper, [class*="transform-component"], img');
        if (!hasViewer) break;

        // Prefer the card that is actually on screen and already shows a blob;
        // hidden/placeholder cards can otherwise win by DOM order alone.
        const hasBlob = !!(viewer && imageUrl(viewer));
        let visible = false;
        try {
          const rect = card.getBoundingClientRect();
          visible = rect.width > 0 && rect.height > 0;
        } catch {
          visible = false;
        }
        const score = (hasBlob ? 4 : 0) + (viewer ? 2 : 0) + (visible ? 1 : 0);

        const candidate = {
          buttons: [...numbers.entries()]
            .sort((a, b) => a[0] - b[0])
            .slice(0, CFG.maxAttachmentPages)
            .map(([page, element]) => ({ page, element })),
          root: card,
          doc: label.ownerDocument || doc || document,
          score,
        };
        if (!best || score > best.score) best = candidate;
        break;
      }
    }
    return best;
  }

  function findAttachmentPager() {
    const scopes = [];
    const seenScopes = new Set();
    const addScope = (scope, doc) => {
      if (!scope || !doc || seenScopes.has(scope)) return;
      seenScopes.add(scope);
      scopes.push({ scope, doc });
    };

    const trigger = findTriggerElement();
    if (trigger) addScope(trigger, trigger.ownerDocument);
    // Always scan whole documents as well. The attachments card can live
    // outside `#content > main > div[2]` (or inside a same-origin iframe)
    // even when the trigger phrase is inside it.
    for (const doc of collectDocuments(document)) addScope(doc, doc);

    let best = null;
    for (const entry of scopes) {
      const pager = findAttachmentPagerIn(entry.scope, entry.doc);
      if (pager && (!best || pager.score > best.score)) best = pager;
    }
    return best;
  }

  async function waitForImageReady(img, timeoutMs) {
    if (!img) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (img.complete && (img.naturalWidth || img.naturalHeight)) return;
      await sleep(80);
    }
  }

  async function waitForBlobChange(root, doc, previousUrl, isCancelled) {
    const deadline = Date.now() + CFG.pageLoadTimeout;
    while (Date.now() < deadline) {
      if (isCancelled()) return '';
      const img = viewerImage(root, doc);
      const url = imageUrl(img);
      // A new object URL appears once the app has fetched and decoded the page.
      // If the page was visited before, React may reuse an existing URL; in
      // that case it still differs from the previous page's URL.
      if (url && url !== previousUrl) return url;
      await sleep(100);
    }
    return '';
  }

  async function harvestAttachmentPages({ isCancelled, onCaptured }) {
    // The attachments card is often fetched separately and can mount a moment
    // after the trigger phrase. Give it a few short attempts before giving up.
    let pager = findAttachmentPager();
    for (let attempt = 0; (!pager || pager.buttons.length < 2) && attempt < 4; attempt += 1) {
      if (isCancelled()) return 0;
      await sleep(400);
      pager = findAttachmentPager();
    }
    if (!pager || pager.buttons.length < 2) {
      logDiag('attachment pager not found');
      return 0;
    }
    logDiag(
      'attachment pager found: pages',
      pager.buttons.map((button) => button.page).join(','),
      'score',
      pager.score
    );

    const buttons = pager.buttons;
    let root = pager.root;
    let doc = pager.doc;

    // React may replace the button nodes while pages load; re-query the live
    // button by its page number before every click, and refresh the card if
    // the whole subtree was remounted.
    const liveButton = (page) => {
      if (!root || !root.isConnected) {
        const fresh = findAttachmentPager();
        if (!fresh) return null;
        root = fresh.root;
        doc = fresh.doc;
      }
      let nodes = [];
      try {
        nodes = root.querySelectorAll('button');
      } catch {
        return null;
      }
      for (const node of nodes) {
        if (Number(toEnDigits((node.textContent || '').trim())) === page) {
          return node;
        }
      }
      return null;
    };

    // Give a lazy viewer a moment to expose the current page's blob.
    let currentImg = null;
    let initialUrl = '';
    const startDeadline = Date.now() + 5000;
    while (Date.now() < startDeadline) {
      currentImg = viewerImage(root, doc);
      initialUrl = imageUrl(currentImg);
      if (initialUrl) break;
      if (isCancelled()) return 0;
      await sleep(150);
    }
    // Do not bail out when the viewer is empty: some builds render the pager
    // before the first page is loaded, and the blob only appears after a click.

    const initialActive =
      buttons
        .map(({ page }) => ({ page, element: liveButton(page) }))
        .find(({ element }) => isActivePageButton(element)) || null;
    const initialPage = initialActive ? initialActive.page : buttons[0].page;
    logDiag(
      'viewer initial blob:',
      initialUrl ? 'present' : 'missing',
      '| active page:',
      initialActive ? initialPage : 'unknown'
    );

    let captured = 0;
    let rootMarked = false;
    const capturedUrls = new Set();
    const capturedPages = new Set();

    const captureCurrent = async (url, page, img) => {
      if (!url || capturedUrls.has(url)) return false;
      let bytes = null;
      try {
        // Fetch immediately: the next click may revoke this object URL.
        bytes = await fetchBlobBytes(url);
      } catch {
        await waitForImageReady(img, 3000);
        try {
          bytes = await imageBytes(img, url);
        } catch {
          bytes = null;
        }
      }
      if (!bytes) {
        logDiag('attachment page', page, ': could not read the blob bytes');
        return false;
      }

      // From now on, discovery ignores this card: any new blob it shows is a
      // page we already captured (see the restore click below).
      if (!rootMarked) {
        state.harvestedRoots.add(root);
        rootMarked = true;
      }

      capturedUrls.add(url);
      capturedPages.add(page);
      logDiag('captured attachment page', page, '-', bytes.base64.length, 'base64 chars');
      onCaptured({ url, kind: 'url', element: img, page, captured: bytes });
      captured += 1;
      return true;
    };

    // Capture the already-visible page before clicking anything. If the class
    // heuristic can't identify the active button, this still preserves it.
    const initialCaptured = initialUrl
      ? await captureCurrent(initialUrl, initialPage, currentImg)
      : false;
    if (initialCaptured) capturedPages.add(initialPage);

    for (const { page } of buttons) {
      if (isCancelled()) break;
      if (capturedPages.has(page)) continue;

      const element = liveButton(page);
      if (!element) {
        logDiag('attachment page', page, ': button not found');
        continue;
      }

      const current = viewerImage(root, doc);
      const beforeUrl = imageUrl(current);
      let url = beforeUrl;

      // Click when the button is not active, and also when it looks active but
      // the viewer has no blob yet (the first page may still be loading).
      if (!isActivePageButton(element) || !beforeUrl) {
        try {
          element.click();
        } catch {
          continue;
        }
        url = await waitForBlobChange(root, doc, beforeUrl, isCancelled);
      }

      // Clicking an already-active, blobless button can be a no-op. Force the
      // viewer to render another page, then come back to this one.
      if (!url && !beforeUrl && isActivePageButton(element)) {
        const other = buttons.find((button) => button.page !== page);
        const otherElement = other ? liveButton(other.page) : null;
        if (otherElement) {
          try {
            otherElement.click();
          } catch {
            // ignore
          }
          const forcedUrl = await waitForBlobChange(root, doc, '', isCancelled);
          if (forcedUrl) {
            try {
              element.click();
            } catch {
              // ignore
            }
            url = await waitForBlobChange(root, doc, forcedUrl, isCancelled);
          }
        }
      }

      if (!url || capturedUrls.has(url)) {
        logDiag('attachment page', page, ': no new blob after click');
        continue;
      }

      const img = viewerImage(root, doc) || current;
      await captureCurrent(url, page, img);
    }

    // Put the view back on the page the user had selected.
    if (!isCancelled()) {
      const restore = liveButton(initialPage);
      if (restore && !isActivePageButton(restore)) {
        try {
          restore.click();
        } catch {
          // ignore
        }
      }
    }

    return captured;
  }

  /* ---------------------------------------------------------------- scroll */

  function scrollTargets() {
    const targets = [];
    const seen = new Set();

    for (const doc of collectDocuments(document)) {
      const win = doc.defaultView;
      if (!win) continue;

      const scrolling = doc.scrollingElement || doc.documentElement;
      if (scrolling && scrolling.scrollHeight > win.innerHeight + 100) {
        targets.push({ kind: 'window', win, doc });
      }

      const content = doc.getElementById('content');
      if (!content) continue;

      let candidates = [];
      try {
        candidates = content.querySelectorAll('*');
      } catch {
        candidates = [];
      }
      const limit = Math.min(candidates.length, 4000);
      for (let i = 0; i < limit && targets.length < CFG.maxDocs + 1; i++) {
        const el = candidates[i];
        if (el.scrollHeight <= el.clientHeight + 100) continue;
        let overflowY = '';
        try {
          overflowY = win.getComputedStyle(el).overflowY;
        } catch {
          continue;
        }
        if (overflowY !== 'auto' && overflowY !== 'scroll') continue;
        if (seen.has(el)) continue;
        seen.add(el);
        targets.push({ kind: 'element', el });
      }
    }
    return targets;
  }

  async function scrollPass(onStep, isCancelled) {
    const targets = scrollTargets();
    // Bound the whole pass so a very long page cannot stall the evaluation.
    const deadline = Date.now() + 15000;
    const expired = () => isCancelled() || Date.now() > deadline;

    for (const target of targets) {
      if (expired()) return;

      if (target.kind === 'window') {
        const { win, doc } = target;
        if ((win.innerHeight || 0) < 100) continue;
        const scrolling = doc.scrollingElement || doc.documentElement;
        const startY = win.scrollY;
        const step = Math.max(Math.floor(win.innerHeight * 0.85), 400);
        for (let y = 0; y <= scrolling.scrollHeight; y += step) {
          if (expired()) break;
          win.scrollTo(0, y);
          onStep();
          await sleep(260);
        }
        if (!expired()) {
          win.scrollTo(0, scrolling.scrollHeight);
          await sleep(600);
          onStep();
        }
        win.scrollTo(0, startY);
      } else {
        const el = target.el;
        const start = el.scrollTop;
        const step = Math.max(Math.floor(el.clientHeight * 0.85), 300);
        for (let y = 0; y <= el.scrollHeight; y += step) {
          if (expired()) break;
          el.scrollTop = y;
          onStep();
          await sleep(240);
        }
        if (!expired()) {
          el.scrollTop = el.scrollHeight;
          await sleep(500);
          onStep();
        }
        el.scrollTop = start;
      }
    }

    await sleep(400);
    onStep();
  }

  /* ----------------------------------------------------------------- panel */

  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel {
      --brand: #0f766e;
      --brand2: #14b8a6;
      --ink: #0f172a;
      --muted: #64748b;
      --line: #e2e8f0;
      --soft: #f8fafc;
      --ok: #15803d;
      --err: #b91c1c;
      width: min(430px, calc(100vw - 32px));
      max-height: min(80vh, 780px);
      display: flex;
      flex-direction: column;
      direction: rtl;
      font-family: Vazirmatn, "Segoe UI", Tahoma, sans-serif;
      font-size: 13px;
      line-height: 1.85;
      color: var(--ink);
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 16px;
      box-shadow: 0 24px 70px rgba(15, 23, 42, .24), 0 2px 8px rgba(15, 23, 42, .08);
      overflow: hidden;
    }
    .panel.collapsed .body { display: none; }
    .header {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 10px 12px;
      background: linear-gradient(135deg, #0f766e, #0d9488);
      color: #fff;
    }
    .title { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .logo { font-size: 18px; line-height: 1; }
    .name { font-weight: 700; font-size: 13px; white-space: nowrap; }
    .sub { font-size: 10.5px; opacity: .85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
    .actions { display: flex; align-items: center; gap: 6px; }
    .icon {
      width: 26px; height: 26px; border: 0; border-radius: 7px;
      background: rgba(255,255,255,.16); color: #fff; cursor: pointer;
      font-size: 15px; line-height: 1; display: grid; place-items: center;
    }
    .icon:hover { background: rgba(255,255,255,.3); }
    .switch { position: relative; display: inline-block; width: 38px; height: 21px; flex: none; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .switch .slider {
      position: absolute; inset: 0; cursor: pointer; border-radius: 999px;
      background: rgba(255,255,255,.35); transition: .2s;
    }
    .switch .slider::before {
      content: ""; position: absolute; width: 15px; height: 15px; left: 3px; top: 3px;
      border-radius: 50%; background: #fff; transition: .2s;
    }
    .switch input:checked + .slider { background: #34d399; }
    .switch input:checked + .slider::before { transform: translateX(17px); }

    .body { overflow-y: auto; padding: 12px 13px 13px; }
    .status-row {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 8px 10px; border-radius: 10px; background: var(--soft);
      border: 1px solid var(--line); margin-bottom: 10px;
      font-size: 12px; color: #334155; min-height: 34px;
    }
    .spinner {
      width: 13px; height: 13px; flex: none; margin-top: 4px;
      border: 2px solid #cbd5e1; border-top-color: var(--brand);
      border-radius: 50%; animation: spin .8s linear infinite; display: none;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .images { display: flex; flex-direction: column; gap: 7px; }
    .img-card { border: 1px solid var(--line); border-radius: 10px; background: #fff; overflow: hidden; }
    .img-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 9px; background: var(--soft); }
    .img-name { font-size: 11.5px; font-weight: 600; color: #334155; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: ltr; text-align: left; }
    .badge { font-size: 10px; padding: 1px 7px; border-radius: 999px; white-space: nowrap; }
    .badge.wait { background: #e2e8f0; color: #475569; }
    .badge.busy { background: #fef3c7; color: #92400e; }
    .badge.ok { background: #dcfce7; color: var(--ok); }
    .badge.err { background: #fee2e2; color: var(--err); }
    .img-card details { padding: 0 9px 7px; }
    .img-card summary { cursor: pointer; font-size: 11px; color: var(--muted); padding-top: 5px; }
    .img-card pre {
      margin: 5px 0 0; max-height: 150px; overflow: auto; white-space: pre-wrap;
      font-family: inherit; font-size: 11px; line-height: 1.7; color: #334155;
      background: var(--soft); padding: 7px; border-radius: 7px;
    }

    .section-title { font-weight: 700; font-size: 12px; color: var(--brand); margin: 13px 0 5px; }
    .report {
      border: 1px solid #bbf7d0; background: #f0fdf4; border-radius: 10px;
      padding: 9px 11px; font-size: 12.5px; line-height: 1.95; overflow-wrap: anywhere;
    }
    .report:empty { display: none; }
    .report h1, .report h2, .report h3 { margin: 10px 0 5px; font-size: 13px; color: #065f46; }
    .report h1 { font-size: 14px; }
    .report p { margin: 5px 0; }
    .report ul, .report ol { padding-right: 20px; margin: 5px 0; }
    .report li { margin: 3px 0; }
    .report table { border-collapse: collapse; width: 100%; margin: 7px 0; font-size: 11.5px; }
    .report th, .report td { border: 1px solid #cbd5e1; padding: 4px 7px; text-align: right; }
    .report th { background: #dcfce7; }
    .report code { background: #e2e8f0; padding: 1px 5px; border-radius: 4px; direction: ltr; }
    .report pre { background: #1e293b; color: #e2e8f0; padding: 8px; border-radius: 7px; overflow: auto; direction: ltr; text-align: left; }
    .report blockquote { border-right: 3px solid var(--brand2); padding-right: 9px; color: var(--muted); margin: 6px 0; }

    .chat { display: flex; flex-direction: column; gap: 7px; margin-top: 6px; }
    .chat:empty { display: none; }
    .msg { padding: 7px 10px; border-radius: 10px; font-size: 12px; line-height: 1.85; overflow-wrap: anywhere; }
    .msg.user { background: #dbeafe; align-self: flex-start; max-width: 88%; white-space: pre-wrap; }
    .msg.ai { background: var(--soft); border: 1px solid var(--line); align-self: stretch; }
    .msg.ai h1, .msg.ai h2, .msg.ai h3 { margin: 7px 0 4px; font-size: 12.5px; color: var(--brand); }
    .msg.ai p { margin: 4px 0; }
    .msg.ai ul, .msg.ai ol { padding-right: 18px; margin: 4px 0; }
    .msg.ai table { border-collapse: collapse; width: 100%; margin: 6px 0; font-size: 11px; }
    .msg.ai th, .msg.ai td { border: 1px solid var(--line); padding: 3px 6px; text-align: right; }

    .chat-input { display: flex; gap: 6px; margin-top: 8px; }
    .chat-input input {
      flex: 1; min-width: 0; padding: 7px 9px; border: 1px solid var(--line);
      border-radius: 8px; font-family: inherit; font-size: 12px; outline: none;
    }
    .chat-input input:focus { border-color: var(--brand2); }
    .chat-input button, .footer button {
      border: 0; border-radius: 8px; padding: 7px 11px; cursor: pointer;
      font-family: inherit; font-size: 11.5px; font-weight: 600;
    }
    .chat-input button { background: var(--brand); color: #fff; white-space: nowrap; }
    .chat-input button:disabled { background: #cbd5e1; cursor: not-allowed; }
    .footer { display: flex; gap: 6px; margin-top: 9px; }
    .footer button { background: var(--soft); border: 1px solid var(--line); color: #334155; }
    .footer button:hover { background: #eef2f7; }
    .hint { margin-top: 8px; font-size: 10.5px; color: var(--muted); line-height: 1.7; }
    .hint:empty { display: none; }

	 .launcher {
	  display: none; align-items: center; gap: 7px;
	  position: relative; bottom: 76px; left: 6px;
	  direction: rtl; font-family: Vazirmatn, "Segoe UI", Tahoma, sans-serif;
	  font-size: 12.5px; font-weight: 700; color: #fff;
	  background:
		radial-gradient(circle at 30% 20%, rgba(255, 255, 255, .42), transparent 35%),
		linear-gradient(135deg, rgba(255, 255, 255, .2), transparent 50%),
		linear-gradient(135deg, #0f766e, #0d9488);
	  border: 1px solid rgba(255, 255, 255, .18);
	  border-radius: 999px; padding: 9px 15px; cursor: pointer;
	  box-shadow: 0 8px 26px rgba(15, 23, 42, .28), 0 2px 8px rgba(15, 23, 42, .12);
	  -webkit-tap-highlight-color: transparent;
		}
    .launcher:hover { filter: brightness(1.07); }
    .launcher:active { transform: translateY(1px); }
    .launcher .l-icon { font-size: 15px; line-height: 1; }
  `;

  const PANEL_HTML = `
    <div class="panel">
      <div class="header">
        <div class="title">
          <span class="logo">🏥</span>
          <div>
            <div class="name">ارزیاب بیمه تکمیلی</div>
            <div class="sub" id="subStatus">آماده</div>
          </div>
        </div>
        <div class="actions">
          <label class="switch" title="روشن / خاموش">
            <input type="checkbox" id="toggle" />
            <span class="slider"></span>
          </label>
          <button class="icon" id="btnMin" title="جمع کردن">—</button>
          <button class="icon" id="btnClose" title="بستن">×</button>
        </div>
      </div>
      <div class="body">
        <div class="status-row">
          <span class="spinner" id="spinner"></span>
          <span id="statusLine">در حال بررسی صفحه…</span>
        </div>
        <div class="images" id="images"></div>
        <div class="section-title" id="reportTitle" hidden>🧠 ارزیابی</div>
        <div class="report" id="report"></div>
        <div class="section-title" id="chatTitle" hidden>💬 پیگیری</div>
        <div class="chat" id="chat"></div>
        <div class="chat-input">
          <input id="chatInput" type="text" placeholder="سؤال یا پیگیری…" disabled />
          <button id="btnSend" disabled>ارسال</button>
        </div>
        <div class="footer">
          <button id="btnRun">اجرای مجدد</button>
          <button id="btnDownload">دانلود تصاویر</button>
        </div>
        <div class="hint" id="hint"></div>
      </div>
    </div>
  `;

  function ensurePanel() {
    if (state.panel) {
      if (!state.panel.isConnected) document.documentElement.appendChild(state.panel);
      return;
    }

    const host = document.createElement('div');
    host.id = 'ostaadx-insurance-assistant';
    host.style.cssText =
      'all: initial; position: fixed; left: 16px; bottom: 16px; ' +
      'z-index: 2147483647; display: none;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    shadow.appendChild(style);

    const wrapper = document.createElement('div');
    wrapper.innerHTML = PANEL_HTML;
    shadow.appendChild(wrapper.firstElementChild);

    // Small start button shown on medicine pages. The pipeline never runs on
    // its own; the user clicks this only when they actually want an evaluation.
    const launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.id = 'ostaadx-launcher';
    launcher.className = 'launcher';
    launcher.title = 'شروع ارزیابی مدارک این صفحه';
    launcher.setAttribute('aria-label', 'شروع ارزیابی مدارک این صفحه');
    launcher.innerHTML = '<span class="l-icon">🏥</span><span>ارزیابی مدارک</span>';
    launcher.style.display = 'none';
    shadow.appendChild(launcher);

    document.documentElement.appendChild(host);

    const $ = (selector) => shadow.querySelector(selector);
    state.panel = host;
    state.shadow = shadow;
    state.els = {
      panel: $('.panel'),
      subStatus: $('#subStatus'),
      statusLine: $('#statusLine'),
      spinner: $('#spinner'),
      images: $('#images'),
      report: $('#report'),
      reportTitle: $('#reportTitle'),
      chat: $('#chat'),
      chatTitle: $('#chatTitle'),
      chatInput: $('#chatInput'),
      hint: $('#hint'),
      toggle: $('#toggle'),
      btnSend: $('#btnSend'),
      btnRun: $('#btnRun'),
      btnDownload: $('#btnDownload'),
      btnMin: $('#btnMin'),
      btnClose: $('#btnClose'),
      launcher: $('#ostaadx-launcher'),
    };

    bindPanelEvents();
    updateToggle();
  }

  function bindPanelEvents() {
    const els = state.els;

    els.toggle.addEventListener('change', async () => {
      state.enabled = els.toggle.checked;
      try {
        await chrome.storage.local.set({ enabled: state.enabled });
      } catch {
        // storage can be unavailable after an extension reload
      }
      if (!state.enabled) {
        cancelRun();
        hidePanel();
        setStatus('خاموش است.', 'idle');
      } else {
        maybeActivate();
      }
    });

    els.btnMin.addEventListener('click', () => {
      els.panel.classList.toggle('collapsed');
    });

    els.btnClose.addEventListener('click', () => {
      const el = findTriggerElement();
      state.dismissedKey = state.lastRunKey || (el ? triggerKey(el) : location.href);
      hidePanel();
      // Manual mode: closing the panel brings the small start button back.
      maybeActivate();
    });

    els.btnRun.addEventListener('click', () => {
      cancelRun();
      state.running = false;
      state.lastRunKey = null;
      state.dismissedKey = null;
      showPanel();
      maybeActivate({ force: true });
    });

    els.btnDownload.addEventListener('click', downloadImages);

    if (els.launcher) els.launcher.addEventListener('click', startFromLauncher);

    els.btnSend.addEventListener('click', sendFollowUp);
    els.chatInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        sendFollowUp();
      }
    });
  }

  function isPanelVisible() {
    return !!(
      state.els &&
      state.els.panel &&
      state.els.panel.style.display !== 'none' &&
      state.panel &&
      state.panel.style.display !== 'none'
    );
  }

  function showPanel() {
    ensurePanel();
    if (state.els && state.els.launcher) state.els.launcher.style.display = 'none';
    if (state.els && state.els.panel) state.els.panel.style.display = '';
    state.panel.style.display = 'block';
  }

  function hidePanel() {
    if (state.els && state.els.panel) state.els.panel.style.display = 'none';
    if (state.els && state.els.launcher) state.els.launcher.style.display = 'none';
    if (state.panel) state.panel.style.display = 'none';
  }

  function showLauncher() {
    ensurePanel();
    if (!state.els || !state.els.launcher) return;
    if (state.els.panel) state.els.panel.style.display = 'none';
    state.els.launcher.style.display = 'inline-flex';
    state.panel.style.display = 'block';
  }

  function hideLauncher() {
    if (!state.els) return;
    if (state.els.launcher) state.els.launcher.style.display = 'none';
    if (state.panel && !isPanelVisible()) state.panel.style.display = 'none';
  }

  function startFromLauncher() {
    if (!state.enabled) return;
    const element = findTriggerElement();
    if (!triggerMentionsPhrase(element)) {
      hideLauncher();
      return;
    }
    if (state.running) {
      showPanel();
      return;
    }
    state.lastRunKey = null;
    state.dismissedKey = null;
    showPanel();
    maybeActivate({ force: true });
  }

  function updateToggle() {
    if (state.els.toggle) state.els.toggle.checked = state.enabled;
  }

  function setStatus(text, kind = 'info') {
    if (state.els.statusLine) {
      state.els.statusLine.textContent = text;
      state.els.statusLine.dataset.kind = kind;
    }
    if (state.els.subStatus) state.els.subStatus.textContent = text;
  }

  function setSpinner(visible) {
    if (state.els.spinner) state.els.spinner.style.display = visible ? 'inline-block' : 'none';
  }

  function setHint(text) {
    if (state.els.hint) state.els.hint.textContent = text || '';
  }

  function badgeFor(status) {
    if (status === 'done') return { cls: 'ok', text: '✅ متن آماده' };
    if (status === 'error') return { cls: 'err', text: 'خطا' };
    if (status === 'ocr') return { cls: 'busy', text: 'OCR…' };
    return { cls: 'wait', text: 'در صف' };
  }

  function renderImages() {
    const box = state.els.images;
    if (!box) return;
    const items = [...state.results.values()].sort((a, b) => a.index - b.index);
    box.innerHTML = '';

    for (const record of items) {
      const card = document.createElement('div');
      card.className = 'img-card';

      const head = document.createElement('div');
      head.className = 'img-head';

      const name = document.createElement('span');
      name.className = 'img-name';
      name.textContent = `${record.index}. ${record.name}`;

      const badge = badgeFor(record.status);
      const badgeEl = document.createElement('span');
      badgeEl.className = 'badge ' + badge.cls;
      badgeEl.textContent = badge.text;

      head.append(name, badgeEl);
      card.appendChild(head);

      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = record.status === 'error' ? 'خطا' : 'متن استخراج‌شده';
      details.appendChild(summary);

      const pre = document.createElement('pre');
      if (record.status === 'error') pre.textContent = record.error || 'خطای نامشخص';
      else pre.textContent = record.text || '…';
      details.appendChild(pre);

      card.appendChild(details);
      box.appendChild(card);
    }
  }

  function updateProgress() {
    if (state.phase !== 'ocr') return;
    const all = [...state.results.values()];
    if (!all.length) {
      setStatus('در حال جستجوی تصاویر…', 'busy');
      return;
    }
    const done = all.filter((r) => r.status === 'done').length;
    const failed = all.filter((r) => r.status === 'error').length;
    const waiting = all.filter((r) => r.status === 'pending' || r.status === 'ocr').length;
    let text = `⏳ OCR: ${done} آماده`;
    if (failed) text += `، ${failed} ناموفق`;
    if (waiting) text += `، ${waiting} در صف`;
    setStatus(text, 'busy');
  }

  function renderMd(text) {
    const marked = globalThis.marked;
    if (marked && typeof marked.parse === 'function') {
      try {
        return sanitizeHtml(marked.parse(text, { gfm: true, breaks: true }));
      } catch {
        // fall through to the plain renderer
      }
    }
    return sanitizeHtml(escapeHtml(text).replace(/\n/g, '<br>'));
  }

  function sanitizeHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = html;

    const blocked = new Set([
      'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META',
      'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT',
    ]);

    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const el of nodes) {
      if (blocked.has(el.tagName)) {
        el.remove();
        continue;
      }
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value || '';
        if (name.startsWith('on')) {
          el.removeAttribute(attr.name);
          continue;
        }
        if (
          (name === 'href' || name === 'src' || name === 'xlink:href') &&
          /^\s*(javascript|vbscript|data:text\/html)/i.test(value)
        ) {
          el.removeAttribute(attr.name);
        }
      }
      if (el.tagName === 'A') {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }

    return template.innerHTML;
  }

  function renderReport(markdown) {
    if (!state.els.report) return;
    state.els.report.innerHTML = renderMd(markdown);
    state.els.reportTitle.hidden = false;
  }

  function addChat(role, text, isMarkdown) {
    if (!state.els.chat) return null;
    const bubble = document.createElement('div');
    bubble.className = 'msg ' + (role === 'user' ? 'user' : 'ai');
    if (isMarkdown) bubble.innerHTML = renderMd(text);
    else bubble.textContent = text;
    state.els.chat.appendChild(bubble);
    state.els.chatTitle.hidden = false;
    state.els.chat.scrollTop = state.els.chat.scrollHeight;
    return bubble;
  }

  function setChatEnabled(enabled) {
    if (state.els.chatInput) state.els.chatInput.disabled = !enabled;
    if (state.els.btnSend) state.els.btnSend.disabled = !enabled;
  }

  function resetPanelUi() {
    if (!state.els.images) return;
    state.els.images.innerHTML = '';
    state.els.report.innerHTML = '';
    state.els.reportTitle.hidden = true;
    state.els.chat.innerHTML = '';
    state.els.chatTitle.hidden = true;
    state.els.hint.textContent = '';
    state.els.chatInput.value = '';
    setChatEnabled(false);
    setSpinner(true);
    setStatus('در حال بررسی صفحه…', 'busy');
    state.phase = 'discover';
  }

  async function downloadImages() {
    const items = [...state.results.values()].filter((r) => r.blob);
    if (!items.length) {
      setHint('تصویری برای دانلود موجود نیست.');
      return;
    }
    for (const record of items) {
      try {
        const url = URL.createObjectURL(record.blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = record.name || 'doc.png';
        document.documentElement.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 15000);
      } catch {
        // keep going with the next image
      }
      await sleep(250);
    }
    setHint(`دانلود ${items.length} تصویر آغاز شد.`);
  }

  /* ------------------------------------------------------------------- run */

  function cancelRun() {
    state.runToken += 1;
    state.running = false;
    setSpinner(false);
  }

  function maybeActivate({ force = false } = {}) {
    if (!state.enabled) {
      hideLauncher();
      return;
    }

    const element = findTriggerElement();
    if (!triggerMentionsPhrase(element)) {
      hideLauncher();
      return;
    }

    ensurePanel();
    updateToggle();

    if (force) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
      pendingKey = triggerKey(element);
      state.lastRunKey = pendingKey;
      state.dismissedKey = null;
      runPipeline();
      return;
    }

    // Manual mode: never analyze automatically. Show a small start button and
    // wait for the user to click it.
    if (state.running) return;
    if (isPanelVisible()) return;
    showLauncher();
  }

  async function runPipeline() {
    if (!state.enabled || state.running) return;

    const element = findTriggerElement();
    if (!triggerMentionsPhrase(element)) return;

    const token = ++state.runToken;
    state.running = true;
    state.conversationId = null;
    state.ocrText = '';
    state.results.clear();
    state.nextIndex = 1;
    state.dismissedKey = null;

    showPanel();
    resetPanelUi();
    state.phase = 'ocr';
    setChatEnabled(false);

    const seen = new Map();
    const jobs = [];
    let cursor = 0;
    let scrollDone = false;

    const addJobs = (items) => {
      for (const [key, item] of items) {
        if (seen.has(key)) {
          // A blob found earlier (usually the visible page) was just captured
          // by the pagination harvest; attach its bytes to the existing record.
          const existing = state.results.get(key);
          if (existing && item.captured && !existing.captured) {
            existing.captured = item.captured;
          }
          continue;
        }
        seen.set(key, item);
        const index = state.nextIndex++;
        const record = {
          key,
          url: item.url,
          kind: item.kind,
          element: item.element,
          index,
          name: `doc_${index}.png`,
          status: 'pending',
          text: '',
          error: '',
          blob: null,
          mime: '',
          captured: item.captured || null,
        };
        state.results.set(key, record);
        jobs.push(record);
      }
      if (jobs.length) renderImages();
    };

    state.harvestedRoots = new WeakSet();
    addJobs(discoverBlobs({ deep: true }));
    updateProgress();

    // The attachment viewer keeps only the active page as a blob: image, so
    // collect every page by clicking through the numbered buttons before the
    // OCR workers start (each switch revokes the previous object URL).
    const isCancelled = () => token !== state.runToken;
    const onHarvested = (item) => {
      addJobs(new Map([[item.url, item]]));
      updateProgress();
      setStatus(`⏳ ${state.results.size} تصویر پیدا شد — آماده‌سازی…`, 'busy');
    };
    const harvestedPages = await harvestAttachmentPages({
      isCancelled,
      onCaptured: onHarvested,
    });
    logDiag(
      'attachment harvest:',
      harvestedPages,
      'page(s); total images:',
      state.results.size
    );
    if (token !== state.runToken) return;
    updateProgress();

    const scrollTask = (async () => {
      try {
        await scrollPass(
          () => {
            if (token !== state.runToken) return;
            addJobs(discoverBlobs());
            updateProgress();
          },
          () => token !== state.runToken
        );
        if (token === state.runToken) {
          // One last deep look once everything has loaded.
          addJobs(discoverBlobs({ deep: true }));
          updateProgress();
        }
        if (harvestedPages === 0 && token === state.runToken) {
          // The attachments card may have mounted after the first attempt.
          // Retry before scrollDone lets the OCR workers exit.
          const retried = await harvestAttachmentPages({
            isCancelled,
            onCaptured: onHarvested,
          });
          logDiag(
            'attachment harvest retry:',
            retried,
            'page(s); total images:',
            state.results.size
          );
          updateProgress();
        }
      } finally {
        scrollDone = true;
      }
    })();

    const processJob = async (record) => {
      if (token !== state.runToken) return;
      record.status = 'ocr';
      renderImages();
      updateProgress();

      try {
        // Paginated pages were fetched during harvest (their object URLs are
        // revoked on the next click), so reuse those bytes instead of fetching.
        const bytes =
          record.captured ||
          (await itemBytes({
            kind: record.kind,
            url: record.url,
            element: record.element,
          }));
        record.captured = null;
        if (token !== state.runToken) return;

        record.blob = bytes.blob;
        record.mime = bytes.mime;
        record.name = `doc_${record.index}.${mimeToExt(bytes.mime)}`;

        const response = await sendMessage({
          type: 'OCR',
          payload: {
            base64: bytes.base64,
            mime: bytes.mime,
            name: record.name,
          },
        });
        if (token !== state.runToken) return;
        if (!response.ok) throw new Error(response.error || 'OCR ناموفق بود');

        let text = response.text || '';
        if (String(response.contentType || '').includes('text/html')) {
          try {
            const parsed = new DOMParser().parseFromString(text, 'text/html');
            text = (parsed.body && parsed.body.textContent) || text;
          } catch {
            // keep the raw text
          }
        }

        record.text = text.trim();
        record.status = record.text ? 'done' : 'error';
        if (!record.text) record.error = 'متنی استخراج نشد.';
      } catch (err) {
        record.status = 'error';
        record.error = err && err.message ? err.message : String(err);
      } finally {
        if (token === state.runToken) {
          renderImages();
          updateProgress();
        }
      }
    };

    const worker = async () => {
      while (true) {
        if (token !== state.runToken) return;
        if (cursor >= jobs.length) {
          if (scrollDone) return;
          await sleep(200);
          continue;
        }
        const record = jobs[cursor++];
        await processJob(record);
      }
    };

    const workers = Array.from({ length: CFG.ocrConcurrency }, () => worker());
    await Promise.all([scrollTask, ...workers]);
    if (token !== state.runToken) return;

    const successes = [...state.results.values()]
      .filter((r) => r.status === 'done' && r.text.trim())
      .sort((a, b) => a.index - b.index);

    if (!successes.length) {
      setSpinner(false);
      state.running = false;
      state.phase = 'done';
      const failures = [...state.results.values()]
        .filter((r) => r.error)
        .map((r) => r.error)
        .slice(0, 2)
        .join(' | ');
      setStatus(failures ? 'OCR ناموفق بود — ' + failures : 'تصویری پیدا نشد.', 'error');
      setHint(
        'اگر مدارک به‌صورت lazy بارگذاری می‌شوند، صفحه را دستی تا انتها اسکرول کنید و «اجرای مجدد» بزنید.'
      );
      setTimeout(() => maybeActivate(), 1500);
      return;
    }

    state.ocrText = successes
      .map((r) => `--- سند ${r.index}: ${r.name} ---\n${r.text.trim()}`)
      .join('\n\n');

    state.phase = 'analyze';
    setStatus(`✅ OCR ${successes.length} سند انجام شد — ارزیابی با DeepSeek…`, 'busy');
    setSpinner(true);

    try {
      const response = await sendMessage({
        type: 'ANALYZE',
        payload: { ocrText: state.ocrText, extraNote: '' },
      });
      if (token !== state.runToken) return;
      if (!response.ok) throw new Error(response.error || 'ارزیابی ناموفق بود');

      state.conversationId = response.conversation_id || null;
      renderReport(response.answer);
      setChatEnabled(!!state.conversationId);
      setStatus('✅ ارزیابی آماده است.', 'ok');
      state.phase = 'done';
    } catch (err) {
      if (token !== state.runToken) return;
      const message = err && err.message ? err.message : String(err);
      addChat('ai', 'خطا: ' + message, false);
      setStatus('خطا در ارزیابی.', 'error');
      setHint(
        'مطمئن شوید بک‌اند با دستور «python backend.py» در حال اجرا است و در DeepSeek وارد شده‌اید.'
      );
      state.phase = 'done';
    } finally {
      if (token === state.runToken) {
        setSpinner(false);
        state.running = false;
      }
      setTimeout(() => maybeActivate(), 1500);
    }
  }

  async function sendFollowUp() {
    const input = state.els.chatInput;
    if (!input || !state.conversationId) return;
    const message = input.value.trim();
    if (!message) return;

    input.value = '';
    addChat('user', message, false);
    const typing = addChat('ai', 'در حال پاسخ…', false);

    try {
      const response = await sendMessage({
        type: 'FOLLOW_UP',
        payload: { message, conversationId: state.conversationId },
      });
      if (typing) typing.remove();
      if (!response.ok) throw new Error(response.error || 'پاسخ ناموفق بود');
      if (response.conversation_id) state.conversationId = response.conversation_id;
      addChat('ai', response.answer, true);
    } catch (err) {
      if (typing) typing.remove();
      addChat('ai', 'خطا: ' + (err && err.message ? err.message : String(err)), false);
    }
  }

  /* ------------------------------------------------------------ activation */

  function onNavigate() {
    cancelRun();
    state.phase = 'idle';
    state.lastRunKey = null;
    state.dismissedKey = null;
    state.triggerKey = null;
    state.conversationId = null;
    state.ocrText = '';
    state.results.clear();
    state.nextIndex = 1;

    if (state.els.chat) state.els.chat.innerHTML = '';
    if (state.els.report) state.els.report.innerHTML = '';
    if (state.els.images) state.els.images.innerHTML = '';
    if (state.els.reportTitle) state.els.reportTitle.hidden = true;
    if (state.els.chatTitle) state.els.chatTitle.hidden = true;
    setChatEnabled(false);
    hidePanel();

    setTimeout(() => maybeActivate(), 900);
  }

  function startObservers() {
    const observer = new MutationObserver(() => {
      if (state.panel && !state.panel.isConnected) {
        document.documentElement.appendChild(state.panel);
      }
      if (observerTimer) return;
      observerTimer = setTimeout(() => {
        observerTimer = null;
        maybeActivate();
      }, 500);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['src', 'href', 'style'],
    });

    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        onNavigate();
      }
    }, 1000);
  }

  /* ---------------------------------------------------------------- startup */

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) return;

    if (message.type === 'PING') {
      const element = findTriggerElement();
      sendResponse({
        ok: true,
        enabled: state.enabled,
        running: state.running,
        hasTrigger: triggerMentionsPhrase(element),
        panelVisible: isPanelVisible(),
        launcherVisible: !!(
          state.els &&
          state.els.launcher &&
          state.els.launcher.style.display !== 'none' &&
          state.panel &&
          state.panel.style.display !== 'none'
        ),
      });
      return;
    }

    if (message.type === 'RUN_NOW') {
      try {
        chrome.storage.local.set({ enabled: true });
      } catch {
        // ignore
      }
      state.enabled = true;
      updateToggle();
      cancelRun();
      state.lastRunKey = null;
      state.dismissedKey = null;
      showPanel();
      maybeActivate({ force: true });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'SHOW_PANEL') {
      showPanel();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'SET_ENABLED') {
      state.enabled = !!message.enabled;
      updateToggle();
      if (!state.enabled) {
        cancelRun();
        hidePanel();
      } else {
        maybeActivate();
      }
      sendResponse({ ok: true });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.enabled) return;
    state.enabled = changes.enabled.newValue !== false;
    updateToggle();
    if (!state.enabled) {
      cancelRun();
      hidePanel();
    } else {
      maybeActivate();
    }
  });

  (async () => {
    try {
      const stored = await chrome.storage.local.get({ enabled: true });
      state.enabled = stored.enabled !== false;
    } catch {
      state.enabled = true;
    }

    ensurePanel();
    hidePanel();
    updateToggle();
    startObservers();
    setTimeout(() => maybeActivate(), 1200);
  })();
})();
