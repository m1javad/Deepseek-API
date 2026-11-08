/*
 * Service worker for the insurance evaluator extension.
 *
 * The content script cannot talk to eboo.ir or the local DeepSeek backend
 * directly (content scripts inherit the page's CORS policy in MV3), so all
 * network calls are proxied through this worker. Extension origins with host
 * permissions are not subject to CORS.
 *
 * Message protocol (content/popup -> worker):
 *   { type: 'OCR',       payload: { base64, mime, name } } -> { ok, text, contentType }
 *   { type: 'ANALYZE',   payload: { ocrText, extraNote } } -> { ok, answer, conversation_id }
 *   { type: 'FOLLOW_UP', payload: { message, conversationId } } -> { ok, answer, conversation_id }
 *   { type: 'HEALTH' } -> { ok, status }
 */

'use strict';

const EBOO_URL = 'https://www.eboo.ir/api/ocr/getway';

// Defaults are seeded on install. The eboo token can be overridden from the popup.
const DEFAULT_SETTINGS = {
  enabled: true,
  ebooToken: '',
  ebooUrl: EBOO_URL,
  backendUrl: 'http://127.0.0.1:8000',
  autoDownload: false,
};

function settings() {
  // `get(object)` fills in defaults for any key that is not stored yet.
  return chrome.storage.local.get(DEFAULT_SETTINGS);
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const patch = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (stored[key] === undefined) patch[key] = value;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
});

/* ------------------------------------------------------------------ utils */

function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal, cache: 'no-store' })
    .finally(() => clearTimeout(timer));
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function shorten(text, limit = 300) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > limit ? s.slice(0, limit) + '…' : s;
}

/* -------------------------------------------------------------------- OCR */

async function ocrFile({ base64, mime, name, token, url }) {
  if (!token) {
    throw new Error('توکن ایبو تنظیم نشده است. آن را از پنجرهٔ افزونه وارد کنید.');
  }
  if (!base64) throw new Error('دادهٔ تصویر خالی است.');

  const endpoint = url || EBOO_URL;

  const type = mime || 'image/png';
  const safeName = (name || 'doc.png').replace(/[^\w.\-]+/g, '_');
  const blob = new Blob([base64ToBytes(base64)], { type });
  const file = new File([blob], safeName, { type });

  // 1) upload the image and obtain a FileToken
  const uploadForm = new FormData();
  uploadForm.append('token', token);
  uploadForm.append('command', 'addfile');
  uploadForm.append('filehandle', file, file.name);

  const uploadRes = await fetchWithTimeout(endpoint, { method: 'POST', body: uploadForm }, 120000);
  const uploadText = await uploadRes.text();
  if (!uploadRes.ok) {
    throw new Error(`ایبو (آپلود) HTTP ${uploadRes.status}: ${shorten(uploadText)}`);
  }

  let upload;
  try {
    upload = JSON.parse(uploadText);
  } catch {
    throw new Error('پاسخ نامعتبر از ایبو: ' + shorten(uploadText));
  }
  if (upload.Status !== 'Done' || !upload.FileToken) {
    throw new Error('آپلود به ایبو انجام نشد: ' + shorten(upload.Status || uploadText));
  }

  // 2) convert the uploaded file to raw text
  const convertForm = new FormData();
  convertForm.append('token', token);
  convertForm.append('command', 'convert');
  convertForm.append('filetoken', upload.FileToken);
  convertForm.append('method', '4');
  convertForm.append('output', 'txtraw');

  const convertRes = await fetchWithTimeout(endpoint, { method: 'POST', body: convertForm }, 180000);
  const convertText = await convertRes.text();
  if (!convertRes.ok) {
    throw new Error(`ایبو (OCR) HTTP ${convertRes.status}: ${shorten(convertText)}`);
  }

  return {
    text: convertText,
    contentType: convertRes.headers.get('content-type') || '',
  };
}

async function maybeDownload({ base64, mime, name }) {
  const { autoDownload } = await settings();
  if (!autoDownload || !base64) return;

  const type = mime || 'image/png';
  const filename = `eboo-docs/${name || 'doc.png'}`;
  let objectUrl = null;

  try {
    // A blob URL avoids data-URL length limits for multi-megabyte scans.
    objectUrl = URL.createObjectURL(new Blob([base64ToBytes(base64)], { type }));
    await chrome.downloads.download({
      url: objectUrl,
      filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
  } catch {
    try {
      await chrome.downloads.download({
        url: `data:${type};base64,${base64}`,
        filename,
        conflictAction: 'uniquify',
        saveAs: false,
      });
    } catch {
      // A failed auto-download must never break OCR.
    }
  } finally {
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  }
}

/* ---------------------------------------------------------------- backend */

async function backendBase() {
  const { backendUrl } = await settings();
  return (backendUrl || DEFAULT_SETTINGS.backendUrl).replace(/\/+$/, '');
}

async function callBackend(endpoint, fields) {
  const base = await backendBase();

  try {
    const health = await fetchWithTimeout(base + '/healthz', { method: 'GET' }, 5000);
    if (!health.ok) {
      throw new Error('HTTP ' + health.status);
    }
  } catch {
    throw new Error(
      'بک‌اند در دسترس نیست. دستور «python backend.py» را در پوشهٔ پروژه اجرا کنید.'
    );
  }

  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value == null ? '' : String(value));
  }

  const res = await fetchWithTimeout(base + endpoint, { method: 'POST', body: form }, 240000);
  const raw = await res.text();

  let data = {};
  try {
    data = JSON.parse(raw);
  } catch {
    // leave data empty and fall through to the error below
  }

  if (!res.ok) {
    const detail =
      (data && (data.detail || (data.error && data.error.message))) ||
      shorten(raw) ||
      'HTTP ' + res.status;
    throw new Error(detail);
  }
  if (!data || !data.answer) {
    throw new Error('پاسخ بک‌اند نامعتبر است: ' + shorten(raw));
  }
  return data;
}

/* ---------------------------------------------------------------- routing */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message && message.type) {
        case 'OCR': {
          const { ebooToken, ebooUrl } = await settings();
          const result = await ocrFile({
            ...(message.payload || {}),
            token: ebooToken,
            url: ebooUrl,
          });
          await maybeDownload(message.payload || {});
          sendResponse({ ok: true, ...result });
          break;
        }
        case 'ANALYZE': {
          const data = await callBackend('/api/analyze', {
            ocr_text: message.payload && message.payload.ocrText,
            extra_note: (message.payload && message.payload.extraNote) || '',
          });
          sendResponse({ ok: true, ...data });
          break;
        }
        case 'FOLLOW_UP': {
          const data = await callBackend('/api/chat', {
            message: message.payload && message.payload.message,
            conversation_id: message.payload && message.payload.conversationId,
          });
          sendResponse({ ok: true, ...data });
          break;
        }
        case 'HEALTH': {
          const base = await backendBase();
          try {
            const res = await fetchWithTimeout(base + '/healthz', { method: 'GET' }, 5000);
            sendResponse({ ok: res.ok, status: res.status });
          } catch (err) {
            sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
          }
          break;
        }
        default:
          sendResponse({ ok: false, error: 'نوع پیام ناشناخته: ' + (message && message.type) });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  })();

  // Keep the message channel open for the async response above.
  return true;
});
