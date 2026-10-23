"use strict";

const DOWNLOAD_PREFERENCE_KEY = "downloadMode";
const DEFAULT_DOWNLOAD_MODE = "saveAs";
const VALID_DOWNLOAD_MODES = new Set(["saveAs", "direct"]);
const modeInputs = [...document.querySelectorAll('input[name="downloadMode"]')];
const statusElement = document.querySelector(".status");

chrome.storage.local.get({ [DOWNLOAD_PREFERENCE_KEY]: DEFAULT_DOWNLOAD_MODE }, (preferences) => {
  const error = chrome.runtime.lastError;
  const storedMode = preferences?.[DOWNLOAD_PREFERENCE_KEY];
  const selectedMode = !error && VALID_DOWNLOAD_MODES.has(storedMode)
    ? storedMode
    : DEFAULT_DOWNLOAD_MODE;
  const selectedInput = modeInputs.find((input) => input.value === selectedMode);
  if (selectedInput) selectedInput.checked = true;
});

for (const input of modeInputs) {
  input.addEventListener("change", () => {
    if (!input.checked || !VALID_DOWNLOAD_MODES.has(input.value)) return;
    chrome.storage.local.set({ [DOWNLOAD_PREFERENCE_KEY]: input.value }, () => {
      const error = chrome.runtime.lastError;
      statusElement.dataset.error = error ? "true" : "false";
      statusElement.textContent = error
        ? "Nao foi possivel salvar a preferencia."
        : "Preferencia salva.";
    });
  });
}
