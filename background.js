"use strict";

const DOWNLOAD_MESSAGE = "DOWNLOAD_VIDEO";
const DOWNLOAD_STATUS_MESSAGE = "GET_DOWNLOAD_STATUS";
const DOWNLOAD_PREFERENCE_KEY = "downloadMode";
const DEFAULT_DOWNLOAD_MODE = "saveAs";
const DIRECT_DOWNLOAD_MODE = "direct";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return false;

  if (message.type === DOWNLOAD_STATUS_MESSAGE) {
    getDownloadStatus(message.downloadId, sendResponse);
    return true;
  }

  if (message.type !== DOWNLOAD_MESSAGE) return false;

  let sourceUrl;
  try {
    sourceUrl = new URL(message.url);
  } catch {
    sendResponse({ ok: false, error: "Endereco de video invalido." });
    return false;
  }

  if (sourceUrl.protocol !== "http:" && sourceUrl.protocol !== "https:") {
    sendResponse({ ok: false, error: "Este tipo de endereco nao pode ser baixado." });
    return false;
  }

  shouldUseSaveAs((saveAs) => {
    const options = {
      url: sourceUrl.href,
      saveAs,
      conflictAction: "uniquify"
    };
    const filename = sanitizeFilename(message.filename);
    if (filename) options.filename = filename;

    chrome.downloads.download(options, (downloadId) => {
      const error = chrome.runtime.lastError;
      if (error) {
        sendResponse({ ok: false, error: error.message });
        return;
      }
      sendResponse({ ok: true, downloadId, state: "in_progress" });
    });
  });

  return true;
});

function shouldUseSaveAs(callback) {
  try {
    chrome.storage.local.get({ [DOWNLOAD_PREFERENCE_KEY]: DEFAULT_DOWNLOAD_MODE }, (preferences) => {
      const error = chrome.runtime.lastError;
      callback(error ? true : preferences?.[DOWNLOAD_PREFERENCE_KEY] !== DIRECT_DOWNLOAD_MODE);
    });
  } catch {
    callback(true);
  }
}

function getDownloadStatus(downloadId, sendResponse) {
  if (!Number.isInteger(downloadId) || downloadId < 1) {
    sendResponse({ ok: false, error: "Identificador de download invalido." });
    return;
  }

  chrome.downloads.search({ id: downloadId }, (items) => {
    const error = chrome.runtime.lastError;
    if (error) {
      sendResponse({ ok: false, error: error.message });
      return;
    }
    const item = items?.[0];
    if (!item) {
      sendResponse({ ok: false, error: "O download nao foi encontrado no Chrome." });
      return;
    }
    sendResponse({
      ok: true,
      download: {
        id: item.id,
        state: item.state || null,
        error: item.error || null,
        paused: Boolean(item.paused),
        canResume: Boolean(item.canResume),
        bytesReceived: Number.isFinite(item.bytesReceived) ? item.bytesReceived : null,
        totalBytes: Number.isFinite(item.totalBytes) ? item.totalBytes : null,
        mime: item.mime || null,
        danger: item.danger || null,
        startTime: item.startTime || null,
        endTime: item.endTime || null,
        estimatedEndTime: item.estimatedEndTime || null
      }
    });
  });
}

function sanitizeFilename(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 180);
}
