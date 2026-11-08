/* Toolbar popup: master toggle + settings. */
'use strict';

const DEFAULTS = {
  enabled: true,
  ebooToken: '',
  backendUrl: 'http://127.0.0.1:8000',
  autoDownload: false,
};

const $ = (id) => document.getElementById(id);

function flash(text, kind) {
  const el = $('msg');
  el.textContent = text || '';
  el.style.color = kind === 'error' ? '#b91c1c' : '#0f766e';
}

function setPageState(text, kind) {
  const el = $('pageState');
  el.textContent = text;
  el.className = 'state ' + (kind || 'busy');
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  $('enabled').checked = stored.enabled !== false;
  $('ebooToken').value = stored.ebooToken || '';
  $('backendUrl').value = stored.backendUrl || DEFAULTS.backendUrl;
  $('autoDownload').checked = !!stored.autoDownload;
}

async function saveSettings(silent) {
  const backendUrl = ($('backendUrl').value.trim() || DEFAULTS.backendUrl).replace(/\/+$/, '');
  await chrome.storage.local.set({
    enabled: $('enabled').checked,
    ebooToken: $('ebooToken').value.trim(),
    backendUrl,
    autoDownload: $('autoDownload').checked,
  });
  $('backendUrl').value = backendUrl;
  if (!silent) flash('ذخیره شد.');
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      resolve(error ? { ok: false, error: error.message } : response || { ok: false });
    });
  });
}

function isTargetUrl(url) {
  return /^https:\/\/iapui\.ostaadx\.ai\//.test(url || '');
}

async function refreshPageState() {
  const tab = await activeTab();
  // `tab.url` can be missing when we lack host access; try PING in that case
  // instead of declaring the tab wrong.
  if (!tab || (tab.url && !isTargetUrl(tab.url))) {
    setPageState('این تب در دامنهٔ هدف (iapui.ostaadx.ai) نیست.', 'warn');
    $('btnRun').disabled = true;
    $('btnPanel').disabled = true;
    return;
  }

  const response = await sendToTab(tab.id, { type: 'PING' });
  if (!response || !response.ok) {
    setPageState('افزونه در این صفحه فعال نیست. صفحه را رفرش کنید.', 'err');
    $('btnRun').disabled = true;
    $('btnPanel').disabled = true;
    return;
  }

  $('btnRun').disabled = false;
  $('btnPanel').disabled = false;

  if (response.running) setPageState('در حال پردازش مدارک…', 'busy');
  else if (response.hasTrigger) {
    setPageState('آماده — دکمهٔ «ارزیابی مدارک» در صفحه را بزنید.', 'ok');
  } else setPageState('عبارت «داروی مصرفی» در این صفحه پیدا نشد.', 'warn');
}

async function runNow() {
  const tab = await activeTab();
  if (!tab || (tab.url && !isTargetUrl(tab.url))) {
    flash('ابتدا صفحهٔ مدارک را باز کنید.', 'error');
    return;
  }
  await saveSettings(true);
  const response = await sendToTab(tab.id, { type: 'RUN_NOW' });
  if (response && response.ok) {
    flash('ارزیابی آغاز شد.');
    setTimeout(refreshPageState, 600);
  } else {
    flash('ارسال فرمان ناموفق بود. صفحه را رفرش کنید.', 'error');
  }
}

async function showPanel() {
  const tab = await activeTab();
  if (!tab || (tab.url && !isTargetUrl(tab.url))) {
    flash('ابتدا صفحهٔ مدارک را باز کنید.', 'error');
    return;
  }
  const response = await sendToTab(tab.id, { type: 'SHOW_PANEL' });
  if (response && response.ok) flash('پنل نمایش داده شد.');
  else flash('نمایش پنل ناموفق بود. صفحه را رفرش کنید.', 'error');
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await refreshPageState();

  $('enabled').addEventListener('change', async () => {
    await saveSettings(true);
    flash($('enabled').checked ? 'روشن شد.' : 'خاموش شد.');
    setTimeout(refreshPageState, 400);
  });

  $('btnSave').addEventListener('click', async () => {
    await saveSettings(false);
    setTimeout(refreshPageState, 400);
  });

  $('btnRun').addEventListener('click', runNow);
  $('btnPanel').addEventListener('click', showPanel);
});
