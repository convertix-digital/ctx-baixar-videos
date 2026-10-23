(() => {
  "use strict";

  if (window.__videoDownloadButtonLoaded) {
    return;
  }
  window.__videoDownloadButtonLoaded = true;

  const DOWNLOAD_MESSAGE = "DOWNLOAD_VIDEO";
  const DOWNLOAD_STATUS_MESSAGE = "GET_DOWNLOAD_STATUS";
  const DOWNLOAD_MONITOR_TIMEOUT_MS = 90_000;
  const STREAMING_EXTENSIONS = [".m3u8", ".mpd"];
  const VIDEO_EXTENSIONS = ["mp4", "webm", "ogv", "ogg", "mov", "m4v", "avi", "mkv"];
  const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "svg"];
  const DOWNLOAD_PREFERENCE_KEY = "downloadMode";
  const EXTENSION_VERSION = chrome.runtime.getManifest().version;

  let activeMedia = null;
  let hideTimer = null;
  let resetTimer = null;
  let isDownloading = false;
  let vimeoConfigPromise = null;
  let lastErrorReport = "";
  let downloadMode = "saveAs";

  chrome.storage.local.get({ [DOWNLOAD_PREFERENCE_KEY]: "saveAs" }, (preferences) => {
    downloadMode = preferences?.[DOWNLOAD_PREFERENCE_KEY] === "direct" ? "direct" : "saveAs";
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[DOWNLOAD_PREFERENCE_KEY]) return;
    downloadMode = changes[DOWNLOAD_PREFERENCE_KEY].newValue === "direct" ? "direct" : "saveAs";
  });

  const overlayHost = document.createElement("div");
  overlayHost.setAttribute("data-video-downloader", "");
  overlayHost.setAttribute("data-ctx-version", EXTENSION_VERSION);
  overlayHost.style.cssText = [
    "all: initial",
    "position: fixed",
    "inset: 0 auto auto 0",
    "z-index: 2147483647",
    "pointer-events: none"
  ].join(";");

  const shadow = overlayHost.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }

      .download-button {
        align-items: center;
        appearance: none;
        background: rgba(17, 24, 39, 0.9);
        border: 1px solid rgba(255, 255, 255, 0.28);
        border-radius: 5px;
        box-shadow: 0 2px 7px rgba(0, 0, 0, 0.28);
        color: #fff;
        cursor: pointer;
        display: none;
        height: 26px;
        justify-content: center;
        padding: 0;
        pointer-events: auto;
        position: fixed;
        width: 26px;
      }

      .download-button:hover { background: rgba(3, 7, 18, 0.96); }
      .download-button:focus-visible { outline: 2px solid #60a5fa; outline-offset: 2px; }
      .download-button[disabled] { cursor: wait; opacity: 0.8; }
      .download-button.visible { display: inline-flex; }

      .download-button svg {
        display: block;
        height: 12px;
        width: 12px;
      }

      .status {
        align-items: flex-start;
        background: rgba(17, 24, 39, 0.94);
        border-radius: 6px;
        box-shadow: 0 3px 10px rgba(0, 0, 0, 0.28);
        color: #fff;
        display: none;
        flex-direction: column;
        font: 500 12px/1.25 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        gap: 7px;
        max-width: 300px;
        padding: 8px 10px;
        pointer-events: none;
        position: fixed;
      }

      .status.visible { display: flex; }

      .status.error {
        background: rgba(127, 29, 29, 0.96);
        pointer-events: auto;
        user-select: text;
      }

      .copy-error {
        appearance: none;
        background: rgba(255, 255, 255, 0.14);
        border: 1px solid rgba(255, 255, 255, 0.35);
        border-radius: 5px;
        color: #fff;
        cursor: pointer;
        display: none;
        font: 600 11px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 6px 8px;
        user-select: none;
      }

      .copy-error:hover { background: rgba(255, 255, 255, 0.23); }
      .copy-error:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
      .status.error .copy-error { display: inline-flex; }
    </style>
    <button class="download-button" type="button" title="Baixar esta midia" aria-label="Baixar esta midia">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M11 3a1 1 0 0 1 2 0v9.59l2.3-2.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.42l2.3 2.3V3ZM5 19a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1Z" />
      </svg>
    </button>
    <div class="status" role="status" aria-live="polite">
      <span class="status-message"></span>
      <button class="copy-error" type="button">Copiar diagnostico</button>
    </div>
  `;

  const button = shadow.querySelector(".download-button");
  const status = shadow.querySelector(".status");
  const statusMessage = shadow.querySelector(".status-message");
  const copyErrorButton = shadow.querySelector(".copy-error");

  (document.documentElement || document).appendChild(overlayHost);

  document.addEventListener("pointerover", handlePointerOver, true);
  document.addEventListener("pointermove", handlePointerMove, true);
  document.addEventListener("pointerleave", scheduleHide, true);
  document.addEventListener("fullscreenchange", handleFullscreenChange, true);
  window.addEventListener("scroll", updatePosition, true);
  window.addEventListener("resize", updatePosition, true);

  button.addEventListener("pointerenter", cancelHide);
  button.addEventListener("pointerleave", scheduleHide);
  button.addEventListener("click", handleDownload);
  copyErrorButton.addEventListener("click", handleCopyError);

  function handlePointerOver(event) {
    const media = findMediaAtPoint(event.clientX, event.clientY, event.composedPath());
    if (!isDownloadableMedia(media)) return;
    showForMedia(media);
  }

  function handlePointerMove(event) {
    const path = event.composedPath();
    if (path.includes(overlayHost)) {
      cancelHide();
      return;
    }

    const media = findMediaAtPoint(event.clientX, event.clientY, path);
    if (isDownloadableMedia(media)) {
      showForMedia(media);
    } else if (activeMedia) {
      scheduleHide();
    }
  }

  function showForMedia(media) {
    cancelHide();
    activeMedia = media;
    const label = getMediaButtonLabel(media);
    button.title = label;
    button.setAttribute("aria-label", label);
    button.classList.add("visible");
    updatePosition();
  }

  function getMediaButtonLabel(media) {
    return media instanceof HTMLImageElement ? "Baixar esta imagem" : "Baixar este video";
  }

  function findMediaAtPoint(clientX, clientY, path) {
    const pathMedia = path.find(isMediaElement);
    if (pathMedia) return pathMedia;
    return document.elementsFromPoint(clientX, clientY).find(isMediaElement) || null;
  }

  function isMediaElement(node) {
    return node instanceof HTMLVideoElement
      || node instanceof HTMLImageElement
      || isVturbSmartPlayer(node);
  }

  function isVturbSmartPlayer(node) {
    return node?.localName === "vturb-smartplayer";
  }

  function isDownloadableMedia(media) {
    if (media instanceof HTMLVideoElement) {
      return media.readyState !== 0 || Boolean(getMediaUrl(media));
    }
    if (media instanceof HTMLImageElement) {
      const rect = media.getBoundingClientRect();
      return Boolean(getMediaUrl(media))
        && Math.max(media.naturalWidth || 0, rect.width) >= 80
        && Math.max(media.naturalHeight || 0, rect.height) >= 80;
    }
    if (isVturbSmartPlayer(media)) {
      const rect = media.getBoundingClientRect();
      return rect.width >= 80 && rect.height >= 80;
    }
    return false;
  }

  function handleFullscreenChange() {
    const fullscreenElement = document.fullscreenElement;
    if (fullscreenElement && !fullscreenElement.contains(overlayHost)) {
      button.classList.remove("visible");
      status.classList.remove("visible");
      activeMedia = null;
    }
  }

  function updatePosition() {
    if (!activeMedia || !activeMedia.isConnected || !button.classList.contains("visible")) {
      return;
    }

    const rect = activeMedia.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 30 || rect.bottom <= 0 || rect.top >= window.innerHeight) {
      button.classList.remove("visible");
      return;
    }

    const buttonWidth = button.offsetWidth || 26;
    const left = Math.max(6, Math.min(rect.right - buttonWidth - 8, window.innerWidth - buttonWidth - 6));
    const top = Math.max(6, rect.top + 8);

    button.style.left = `${left}px`;
    button.style.top = `${top}px`;

    status.style.left = `${Math.max(6, Math.min(left, window.innerWidth - 326))}px`;
    status.style.top = `${top + 32}px`;
  }

  function scheduleHide() {
    cancelHide();
    hideTimer = window.setTimeout(() => {
      if (!isDownloading) {
        button.classList.remove("visible");
        status.classList.remove("visible");
        activeMedia = null;
      }
    }, 160);
  }

  function cancelHide() {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  async function handleDownload(event) {
    event?.preventDefault();
    event?.stopPropagation();

    if (!activeMedia || isDownloading) {
      return;
    }

    const isImageDownload = activeMedia instanceof HTMLImageElement;
    const pageUrl = getMediaUrl(activeMedia);
    const segmentedDownloader = window.CTXSegmentedDownloader;
    const hasSegmentedSource = !isImageDownload && pageUrl.startsWith("blob:")
      && segmentedDownloader?.hasSegmentedSources();
    const saveHandlePromise = hasSegmentedSource && !isInstagramPage() && downloadMode !== "direct"
      ? segmentedDownloader.prepareSaveHandle()
      : null;

    setDownloading(true);
    const diagnostics = createDiagnostics(activeMedia);
    markDiagnosticStep(diagnostics, "inicializacao", "ok", {
      source: describeMediaUrl(pageUrl),
      segmentedSourceDetected: Boolean(hasSegmentedSource),
      segmentedSavePrepared: Boolean(saveHandlePromise),
      requiresOpenTab: Boolean(hasSegmentedSource),
      downloadMode
    });

    try {
      markDiagnosticStep(diagnostics, "resolucao-da-fonte", "iniciado");
      const source = isImageDownload
        ? { url: pageUrl, filename: getSuggestedFilename(pageUrl, activeMedia) }
        : await resolveDownloadSource(activeMedia, diagnostics);
      const url = source.url;
      const shouldDownloadSegmented = segmentedDownloader?.shouldDownloadSegmented(
        source,
        hasSegmentedSource
      ) ?? Boolean(source.segmented);
      diagnostics.resolvedSource = describeMediaUrl(url);
      markDiagnosticStep(diagnostics, "resolucao-da-fonte", "ok", {
        resolvedSource: diagnostics.resolvedSource,
        segmented: shouldDownloadSegmented
      });

      if (shouldDownloadSegmented) {
        if (!segmentedDownloader) {
          throw new Error("O modulo de download segmentado nao foi carregado.");
        }

        markDiagnosticStep(diagnostics, "download-segmentado", "iniciado");
        const result = await segmentedDownloader.downloadSegmented({
          source,
          videoId: location.pathname.match(/^\/video\/(\d+)/)?.[1] || null,
          diagnostics,
          saveHandlePromise,
          onProgress: updateSegmentedProgress
        });

        if (!result.savedDirectly) {
          const objectUrl = URL.createObjectURL(result.file);
          triggerAnchorDownload(objectUrl, result.filename);
          window.setTimeout(() => {
            URL.revokeObjectURL(objectUrl);
            result.cleanup?.();
          }, 10 * 60 * 1_000);
        }

        showStatus(result.savedDirectly
          ? "Video salvo no local escolhido."
          : "Download do video iniciado.", false);
        markDiagnosticStep(diagnostics, "download-segmentado", "concluido", {
          savedDirectly: Boolean(result.savedDirectly),
          output: diagnostics.segmented?.outputMode || null,
          bytes: diagnostics.segmented?.outputBytes || 0
        });
        return;
      }

      if (!url) {
        throw new Error("Nao foi encontrado um arquivo de video nesta pagina.");
      }

      if (isSegmentedStream(url)) {
        throw new Error("Este video usa streaming segmentado e nao oferece uma versao MP4 direta.");
      }

      if (url.startsWith("blob:") || url.startsWith("data:")) {
        markDiagnosticStep(diagnostics, "download-local", "iniciado");
        await downloadLocalUrl(url, activeMedia);
        markDiagnosticStep(diagnostics, "download-local", "solicitado");
      } else {
        diagnostics.download = {
          requestedSource: describeMediaUrl(url),
          requestedAt: new Date().toISOString(),
          downloadId: null,
          monitorResult: null,
          item: null
        };
        markDiagnosticStep(diagnostics, "solicitacao-ao-chrome", "iniciado");
        const response = await sendDownloadMessage({
          type: DOWNLOAD_MESSAGE,
          url,
          filename: source.filename || getSuggestedFilename(url, activeMedia)
        });

        if (!response || !response.ok) {
          diagnostics.downloadError = response?.error || "O Chrome recusou o download.";
          markDiagnosticStep(diagnostics, "solicitacao-ao-chrome", "erro", {
            error: diagnostics.downloadError
          });
          throw new Error(response?.error || "O Chrome recusou o download.");
        }

        diagnostics.download.downloadId = response.downloadId;
        markDiagnosticStep(diagnostics, "solicitacao-ao-chrome", "aceito", {
          downloadId: response.downloadId,
          initialState: response.state || null
        });

        showPersistentStatus("Download iniciado. Confirmando o resultado no Chrome...");
        const monitored = await monitorChromeDownload(response.downloadId, diagnostics);
        if (monitored.state === "interrupted") {
          diagnostics.downloadError = monitored.error || "DOWNLOAD_INTERRUPTED";
          throw new Error(formatChromeDownloadError(monitored.error));
        }

        if (monitored.state === "complete") {
          showStatus("Download concluido.", false);
          return;
        }
      }

      showStatus("Download iniciado e continua no Chrome.", false);
    } catch (error) {
      markDiagnosticStep(diagnostics, diagnostics.execution.currentStage || "desconhecida", "falhou", {
        errorName: error?.name || "Error",
        errorMessage: error?.message || String(error)
      });
      diagnostics.failure = {
        stage: diagnostics.execution.currentStage,
        name: error?.name || "Error",
        message: error?.message || String(error)
      };
      const message = `Nao foi possivel baixar: ${error.message}`;
      diagnostics.resources = summarizeMediaResources();
      lastErrorReport = buildDiagnosticReport(message, diagnostics);
      showStatus(message, true);
    } finally {
      setDownloading(false);
    }
  }

  async function resolveDownloadSource(video, diagnostics) {
    const pageSource = getMediaUrl(video);

    if (isVturbSmartPlayer(video)) {
      if (!window.CTXSegmentedDownloader?.hasSegmentedSources()) {
        throw new Error("SmartPlayer: inicie o video por alguns segundos para a playlist aparecer e tente novamente.");
      }
      return {
        url: pageSource,
        filename: "",
        segmented: true
      };
    }

    if (isVimeoPlayerFrame()) {
      diagnostics.vimeo.detected = true;
      const vimeoSource = await resolveVimeoProgressiveSource(diagnostics);
      if (vimeoSource) {
        return vimeoSource;
      }

      if (pageSource.startsWith("blob:") || isSegmentedStream(pageSource)) {
        return {
          url: pageSource,
          filename: "",
          segmented: true
        };
      }
    }

    if (pageSource.startsWith("blob:") && isInstagramPage()) {
      const progressiveSource = window.CTXSegmentedDownloader?.findInstagramProgressiveSource(
        diagnostics
      );
      if (progressiveSource) {
        return progressiveSource;
      }

      const instagramSource = window.CTXSegmentedDownloader?.findInstagramMediaPlan(
        diagnostics,
        Number.isFinite(video.duration) ? video.duration : null
      );
      if (instagramSource) {
        return instagramSource;
      }
      if (diagnostics.directMedia?.incomplete) {
        throw new Error("Instagram: a pagina nao ofereceu um MP4 direto e as partes carregadas pelo player ainda estavam incompletas.");
      }
      throw new Error("Instagram: nao foi possivel associar um arquivo de video ao Reel atual.");
    }

    return { url: pageSource, filename: "" };
  }

  function isVimeoPlayerFrame() {
    return location.hostname === "player.vimeo.com"
      && /^\/video\/\d+/.test(location.pathname);
  }

  function isInstagramPage() {
    return /(^|\.)instagram\.com$/i.test(location.hostname);
  }

  async function resolveVimeoProgressiveSource(diagnostics) {
    if (!vimeoConfigPromise) {
      vimeoConfigPromise = loadVimeoConfig(diagnostics);
    } else {
      diagnostics.vimeo.configSource = "cache-do-player";
    }

    const config = await vimeoConfigPromise;
    if (!config) {
      vimeoConfigPromise = null;
    }
    summarizeVimeoConfig(config, diagnostics);
    const progressiveFiles = config?.request?.files?.progressive;

    if (!Array.isArray(progressiveFiles) || progressiveFiles.length === 0) {
      return null;
    }

    const bestFile = progressiveFiles
      .filter((file) => file && typeof file.url === "string" && /^https?:\/\//.test(file.url))
      .sort((first, second) => getVimeoFileScore(second) - getVimeoFileScore(first))[0];

    if (!bestFile) {
      return null;
    }

    const title = sanitizeFilename(config?.video?.title || document.title || "video-vimeo");
    const quality = sanitizeFilename(bestFile.quality || (bestFile.height ? `${bestFile.height}p` : ""));
    const label = quality ? ` - ${quality}` : "";

    return {
      url: bestFile.url,
      filename: `${title || "video-vimeo"}${label}.mp4`
    };
  }

  function getVimeoFileScore(file) {
    const width = Number(file.width) || 0;
    const height = Number(file.height) || Number.parseInt(file.quality, 10) || 0;
    return width * height || height;
  }

  async function loadVimeoConfig(diagnostics) {
    const embeddedConfig = findEmbeddedVimeoConfig();
    if (embeddedConfig) {
      diagnostics.vimeo.configSource = "json-incorporado-no-player";
      return embeddedConfig;
    }

    const videoId = location.pathname.match(/^\/video\/(\d+)/)?.[1];
    diagnostics.vimeo.videoId = videoId || null;
    if (!videoId) {
      return null;
    }

    const candidates = new Set();

    for (const entry of performance.getEntriesByType("resource")) {
      if (entry.name.includes(`/video/${videoId}/config`)) {
        candidates.add(entry.name);
      }
    }

    const configUrl = new URL(`/video/${videoId}/config`, location.origin);
    for (const [key, value] of new URLSearchParams(location.search)) {
      configUrl.searchParams.append(key, value);
    }
    candidates.add(configUrl.href);
    diagnostics.vimeo.configCandidates = candidates.size;

    for (const candidate of candidates) {
      const requestDiagnostic = {
        endpoint: sanitizePageUrl(candidate),
        status: null,
        ok: false,
        error: null
      };
      diagnostics.vimeo.configRequests.push(requestDiagnostic);

      try {
        const response = await fetch(candidate, {
          credentials: "include",
          cache: "no-cache"
        });
        requestDiagnostic.status = response.status;
        requestDiagnostic.ok = response.ok;

        if (!response.ok) {
          continue;
        }

        const config = await response.json();
        if (config?.request?.files) {
          diagnostics.vimeo.configSource = "endpoint-do-player";
          return config;
        }
        requestDiagnostic.error = "Resposta sem request.files";
      } catch (error) {
        requestDiagnostic.error = error?.message || String(error);
        // Tenta o proximo endereco de configuracao disponivel no proprio player.
      }
    }

    return null;
  }

  function summarizeVimeoConfig(config, diagnostics) {
    if (!config?.request?.files) {
      diagnostics.vimeo.configFound = false;
      return;
    }

    const files = config.request.files;
    const progressive = Array.isArray(files.progressive) ? files.progressive : [];
    diagnostics.vimeo.configFound = true;
    diagnostics.vimeo.fileKeys = Object.keys(files).sort();
    diagnostics.vimeo.progressiveCount = progressive.length;
    diagnostics.vimeo.progressiveQualities = progressive
      .map((file) => file?.quality || (file?.height ? `${file.height}p` : "desconhecida"))
      .filter(Boolean);
    diagnostics.vimeo.hasHls = Boolean(files.hls);
    diagnostics.vimeo.hasDash = Boolean(files.dash);
    diagnostics.vimeo.hlsCdns = Object.keys(files.hls?.cdns || {}).sort();
    diagnostics.vimeo.dashCdns = Object.keys(files.dash?.cdns || {}).sort();
  }

  function createDiagnostics(media) {
    const isNativeVideo = media instanceof HTMLVideoElement;
    const isVideo = isNativeVideo || isVturbSmartPlayer(media);
    const isImage = media instanceof HTMLImageElement;
    return {
      extensionVersion: EXTENSION_VERSION,
      generatedAt: new Date().toISOString(),
      frame: {
        urlWithoutParameters: sanitizePageUrl(location.href),
        referrerWithoutParameters: sanitizePageUrl(document.referrer),
        isTopFrame: window === window.top
      },
      media: {
        kind: isImage ? "image" : "video",
        source: describeMediaUrl(getMediaUrl(media))
      },
      video: isVideo ? {
        source: describeMediaUrl(getMediaUrl(media)),
        playerType: isVturbSmartPlayer(media) ? "vturb-smartplayer" : "html-video",
        readyState: isNativeVideo ? media.readyState : null,
        networkState: isNativeVideo ? media.networkState : null,
        durationSeconds: Number.isFinite(media.duration) ? Number(media.duration.toFixed(3)) : null,
        width: isNativeVideo ? media.videoWidth : Math.round(media.getBoundingClientRect().width),
        height: isNativeVideo ? media.videoHeight : Math.round(media.getBoundingClientRect().height),
        hasSrcObject: Boolean(media.srcObject)
      } : null,
      image: isImage ? {
        source: describeMediaUrl(getMediaUrl(media)),
        naturalWidth: media.naturalWidth || null,
        naturalHeight: media.naturalHeight || null,
        renderedWidth: Math.round(media.getBoundingClientRect().width) || null,
        renderedHeight: Math.round(media.getBoundingClientRect().height) || null
      } : null,
      vimeo: {
        detected: false,
        videoId: location.pathname.match(/^\/video\/(\d+)/)?.[1] || null,
        configSource: null,
        configFound: false,
        configCandidates: 0,
        configRequests: [],
        fileKeys: [],
        progressiveCount: 0,
        progressiveQualities: [],
        hasHls: false,
        hasDash: false,
        hlsCdns: [],
        dashCdns: []
      },
      resolvedSource: null,
      downloadError: null,
      download: null,
      segmented: null,
      directMedia: null,
      failure: null,
      execution: {
        startedAt: new Date().toISOString(),
        startedMonotonicMilliseconds: performance.now(),
        currentStage: "criado",
        elapsedMilliseconds: 0,
        steps: []
      },
      resources: summarizeMediaResources()
    };
  }

  function sanitizePageUrl(value) {
    if (!value) {
      return null;
    }

    try {
      const url = new URL(value, location.href);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return "invalida";
    }
  }

  function describeMediaUrl(value) {
    if (!value) {
      return null;
    }

    if (value.startsWith("blob:")) {
      return { scheme: "blob", host: null, extension: null, hasParameters: false };
    }

    if (value.startsWith("data:")) {
      return { scheme: "data", host: null, extension: null, hasParameters: false };
    }

    try {
      const url = new URL(value, location.href);
      const extension = url.pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() || null;
      return {
        scheme: url.protocol.replace(":", ""),
        host: url.host,
        extension,
        hasParameters: Boolean(url.search)
      };
    } catch {
      return { scheme: "invalida", host: null, extension: null, hasParameters: false };
    }
  }

  function summarizeMediaResources() {
    const groups = new Map();
    const mediaPattern = /vimeo|\.m3u8(?:$|\?)|\.mpd(?:$|\?)|\.m4s(?:$|\?)|\.ts(?:$|\?)|\.mp4(?:$|\?)|segment|playlist/i;

    for (const entry of performance.getEntriesByType("resource")) {
      if (!mediaPattern.test(entry.name)) {
        continue;
      }

      try {
        const url = new URL(entry.name);
        const extension = url.pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() || "sem-extensao";
        const key = `${url.host}|${extension}|${entry.initiatorType || "desconhecido"}`;
        const current = groups.get(key) || {
          host: url.host,
          type: extension,
          initiator: entry.initiatorType || "desconhecido",
          count: 0
        };
        current.count += 1;
        groups.set(key, current);
      } catch {
        // Ignora entradas de performance que nao sejam URLs validas.
      }
    }

    return Array.from(groups.values())
      .sort((first, second) => second.count - first.count)
      .slice(0, 30);
  }

  function buildDiagnosticReport(message, diagnostics) {
    return [
      "CTX Baixar Videos - diagnostico",
      `Versao: ${EXTENSION_VERSION}`,
      `Erro: ${message}`,
      "Privacidade: URLs assinadas, valores de parametros, cookies, tokens e caminhos locais nao foram incluidos.",
      "Incluido para correcao: etapas executadas, codigos HTTP/Chrome, tamanhos, duracoes, tipos de midia e contagens de partes.",
      "",
      JSON.stringify(diagnostics, null, 2)
    ].join("\n");
  }

  function findEmbeddedVimeoConfig() {
    const jsonScripts = document.querySelectorAll('script[type="application/json"]');

    for (const script of jsonScripts) {
      try {
        const value = JSON.parse(script.textContent || "null");
        const config = findConfigObject(value, 0);
        if (config) {
          return config;
        }
      } catch {
        // Alguns scripts JSON da pagina podem nao conter configuracao do player.
      }
    }

    return null;
  }

  function findConfigObject(value, depth) {
    if (!value || typeof value !== "object" || depth > 6) {
      return null;
    }

    if (value?.request?.files) {
      return value;
    }

    for (const child of Object.values(value)) {
      const config = findConfigObject(child, depth + 1);
      if (config) {
        return config;
      }
    }

    return null;
  }

  function getMediaUrl(media) {
    if (isVturbSmartPlayer(media)) {
      return "blob:ctx-vturb-smartplayer";
    }
    const source = media.currentSrc
      || media.src
      || media.querySelector?.("source[src]")?.src
      || "";

    return source.trim();
  }

  function isSegmentedStream(url) {
    try {
      const pathname = new URL(url, location.href).pathname.toLowerCase();
      return STREAMING_EXTENSIONS.some((extension) => pathname.endsWith(extension));
    } catch {
      return false;
    }
  }

  async function downloadLocalUrl(url, video) {
    if (url.startsWith("data:")) {
      triggerAnchorDownload(url, getSuggestedFilename(url, video));
      return;
    }

    const response = await fetch(url);
    const blob = await response.blob();
    if (!blob.size) {
      throw new Error("O video local esta vazio.");
    }

    const objectUrl = URL.createObjectURL(blob);
    const filename = getSuggestedFilename(url, video, blob.type);
    triggerAnchorDownload(objectUrl, filename);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }

  async function recordVideoLocally(video, diagnostics) {
    if (typeof MediaRecorder === "undefined") {
      throw new Error("Este Chrome nao oferece o gravador local MediaRecorder.");
    }

    const captureStream = video.captureStream || video.mozCaptureStream;
    if (typeof captureStream !== "function") {
      throw new Error("Este player nao permite capturar o fluxo reproduzido.");
    }

    if (video.mediaKeys) {
      throw new Error("O video utiliza DRM e nao pode ser gravado pela extensao.");
    }

    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error("Nao foi possivel determinar a duracao do video.");
    }

    const mimeType = getRecorderMimeType();
    const originalState = {
      currentTime: video.currentTime,
      paused: video.paused,
      loop: video.loop,
      playbackRate: video.playbackRate
    };
    let stream = null;
    let recorder = null;
    let completed = false;
    let timeUpdateHandler = null;
    let endedHandler = null;

    diagnostics.recording = {
      attempted: true,
      completed: false,
      mimeType: mimeType || "padrao-do-chrome",
      durationSeconds: Number(video.duration.toFixed(3)),
      audioTracks: 0,
      videoTracks: 0,
      outputBytes: 0
    };

    try {
      video.pause();
      video.loop = false;
      video.playbackRate = 1;

      if (video.currentTime > 0.05) {
        const seeked = waitForMediaEvent(video, "seeked", 15_000);
        video.currentTime = 0;
        await seeked;
      }

      stream = captureStream.call(video);
      diagnostics.recording.audioTracks = stream.getAudioTracks().length;
      diagnostics.recording.videoTracks = stream.getVideoTracks().length;

      if (stream.getVideoTracks().length === 0) {
        throw new Error("O player nao liberou uma faixa de video para gravacao.");
      }

      if (stream.getAudioTracks().length === 0) {
        throw new Error("O player nao liberou a faixa de audio para gravacao.");
      }

      const recorderOptions = mimeType ? { mimeType } : undefined;
      recorder = new MediaRecorder(stream, recorderOptions);
      const chunks = [];

      const stopped = new Promise((resolve, reject) => {
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data?.size) {
            chunks.push(event.data);
          }
        });
        recorder.addEventListener("stop", resolve, { once: true });
        recorder.addEventListener("error", (event) => {
          reject(event.error || new Error("Falha do gravador local."));
        }, { once: true });
      });

      endedHandler = () => {
        if (recorder.state !== "inactive") {
          recorder.stop();
        }
      };
      timeUpdateHandler = () => updateRecordingProgress(video);
      video.addEventListener("ended", endedHandler, { once: true });
      video.addEventListener("timeupdate", timeUpdateHandler);

      showPersistentStatus("Preparando gravacao local... mantenha esta aba aberta.");
      recorder.start(1_000);

      try {
        await video.play();
      } catch {
        throw new Error("Clique em Play no Vimeo e tente novamente.");
      }

      updateRecordingProgress(video);
      await stopped;

      const outputType = recorder.mimeType || mimeType || "video/webm";
      const output = new Blob(chunks, { type: outputType });
      if (output.size < 1_024) {
        throw new Error("A gravacao terminou sem dados suficientes.");
      }

      const objectUrl = URL.createObjectURL(output);
      const videoId = location.pathname.match(/^\/video\/(\d+)/)?.[1] || "vimeo";
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      triggerAnchorDownload(objectUrl, `vimeo-${videoId}-${timestamp}.webm`);
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);

      diagnostics.recording.completed = true;
      diagnostics.recording.outputBytes = output.size;
      completed = true;
    } finally {
      if (timeUpdateHandler) {
        video.removeEventListener("timeupdate", timeUpdateHandler);
      }
      if (endedHandler) {
        video.removeEventListener("ended", endedHandler);
      }
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }

      video.loop = originalState.loop;
      video.playbackRate = originalState.playbackRate;

      if (!completed) {
        video.pause();
        try {
          video.currentTime = originalState.currentTime;
          if (!originalState.paused) {
            await video.play();
          }
        } catch {
          // O player pode impedir a restauracao depois de uma falha de captura.
        }
      }
    }
  }

  function getRecorderMimeType() {
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm"
    ];

    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
  }

  function waitForMediaEvent(media, eventName, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error(`Tempo excedido aguardando ${eventName}.`));
      }, timeoutMs);

      const handleEvent = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error("O player apresentou um erro durante a preparacao."));
      };
      const cleanup = () => {
        window.clearTimeout(timeout);
        media.removeEventListener(eventName, handleEvent);
        media.removeEventListener("error", handleError);
      };

      media.addEventListener(eventName, handleEvent, { once: true });
      media.addEventListener("error", handleError, { once: true });
    });
  }

  function updateRecordingProgress(video) {
    const elapsed = Math.max(0, video.currentTime);
    const total = video.duration;
    const percentage = Math.min(100, Math.floor((elapsed / total) * 100));
    button.title = `Gravando ${percentage}%`;
    button.setAttribute("aria-label", `Gravando ${percentage}%`);
    statusMessage.textContent = `Gravando localmente: ${formatTime(elapsed)} de ${formatTime(total)}. Mantenha esta aba aberta.`;
    status.classList.remove("error");
    status.classList.add("visible");
    updatePosition();
  }

  function formatTime(seconds) {
    const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
    const minutes = Math.floor(safeSeconds / 60);
    const remainder = String(safeSeconds % 60).padStart(2, "0");
    return `${minutes}:${remainder}`;
  }

  function showPersistentStatus(message) {
    window.clearTimeout(resetTimer);
    statusMessage.textContent = message;
    status.classList.remove("error");
    status.classList.add("visible");
    updatePosition();
  }

  function triggerAnchorDownload(url, filename) {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename || `video-${Date.now()}`;
    anchor.style.display = "none";
    (document.body || document.documentElement).appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  function getSuggestedFilename(url, media, explicitMimeType = "") {
    let candidate = "";
    const isImage = media instanceof HTMLImageElement;
    const allowedExtensions = isImage ? IMAGE_EXTENSIONS : VIDEO_EXTENSIONS;

    try {
      if (url.startsWith("http:" ) || url.startsWith("https:")) {
        candidate = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
      }
    } catch {
      candidate = "";
    }

    candidate = sanitizeFilename(candidate);
    const candidateExtension = candidate.includes(".") ? candidate.split(".").pop().toLowerCase() : "";
    if (candidate && allowedExtensions.includes(candidateExtension)) {
      return candidate;
    }

    const mimeType = explicitMimeType
      || media.getAttribute("type")
      || media.querySelector?.("source[type]")?.getAttribute("type")
      || "";
    const extension = extensionFromMimeType(mimeType, isImage ? "image" : "video");
    const prefix = isImage ? "imagem" : "video";
    return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`;
  }

  function extensionFromMimeType(mimeType, kind = "video") {
    const normalized = mimeType.toLowerCase().split(";")[0].trim();
    const extensions = {
      "video/mp4": "mp4",
      "video/webm": "webm",
      "video/ogg": "ogv",
      "video/quicktime": "mov",
      "video/x-m4v": "m4v",
      "video/x-msvideo": "avi",
      "video/x-matroska": "mkv",
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/gif": "gif",
      "image/avif": "avif",
      "image/bmp": "bmp",
      "image/svg+xml": "svg"
    };

    return extensions[normalized] || (kind === "image" ? "jpg" : "mp4");
  }

  function sanitizeFilename(value) {
    return value
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim()
      .slice(0, 180);
  }

  function sendDownloadMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response);
      });
    });
  }

  async function monitorChromeDownload(downloadId, diagnostics) {
    const startedAt = performance.now();
    let consecutiveStatusErrors = 0;
    markDiagnosticStep(diagnostics, "monitoramento-do-chrome", "iniciado", { downloadId });

    while (performance.now() - startedAt < DOWNLOAD_MONITOR_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 800));

      let response;
      try {
        response = await sendDownloadMessage({
          type: DOWNLOAD_STATUS_MESSAGE,
          downloadId
        });
      } catch (error) {
        consecutiveStatusErrors += 1;
        if (consecutiveStatusErrors < 3) continue;
        diagnostics.download.monitorResult = "status-indisponivel";
        diagnostics.download.statusError = error.message;
        markDiagnosticStep(diagnostics, "monitoramento-do-chrome", "status-indisponivel", {
          error: error.message
        });
        return { state: "unknown", error: error.message };
      }

      if (!response?.ok || !response.download) {
        consecutiveStatusErrors += 1;
        if (consecutiveStatusErrors < 3) continue;
        const error = response?.error || "Status do download indisponivel.";
        diagnostics.download.monitorResult = "status-indisponivel";
        diagnostics.download.statusError = error;
        markDiagnosticStep(diagnostics, "monitoramento-do-chrome", "status-indisponivel", { error });
        return { state: "unknown", error };
      }

      consecutiveStatusErrors = 0;
      diagnostics.download.item = response.download;

      if (response.download.state === "complete") {
        diagnostics.download.monitorResult = "concluido";
        markDiagnosticStep(diagnostics, "monitoramento-do-chrome", "concluido", {
          bytesReceived: response.download.bytesReceived,
          totalBytes: response.download.totalBytes,
          mime: response.download.mime
        });
        return response.download;
      }

      if (response.download.state === "interrupted") {
        diagnostics.download.monitorResult = "interrompido";
        markDiagnosticStep(diagnostics, "monitoramento-do-chrome", "interrompido", {
          error: response.download.error,
          bytesReceived: response.download.bytesReceived,
          totalBytes: response.download.totalBytes
        });
        return response.download;
      }
    }

    diagnostics.download.monitorResult = "continua-em-andamento";
    markDiagnosticStep(diagnostics, "monitoramento-do-chrome", "tempo-limite", {
      waitedMilliseconds: DOWNLOAD_MONITOR_TIMEOUT_MS,
      lastState: diagnostics.download.item?.state || null,
      bytesReceived: diagnostics.download.item?.bytesReceived || 0,
      totalBytes: diagnostics.download.item?.totalBytes || null
    });
    return diagnostics.download.item || { state: "in_progress", error: null };
  }

  function markDiagnosticStep(diagnostics, stage, statusValue, details = {}) {
    if (!diagnostics?.execution) return;
    const elapsedMilliseconds = Math.max(0, Math.round(
      performance.now() - diagnostics.execution.startedMonotonicMilliseconds
    ));
    diagnostics.execution.currentStage = stage;
    diagnostics.execution.elapsedMilliseconds = elapsedMilliseconds;
    diagnostics.execution.steps.push({
      stage,
      status: statusValue,
      elapsedMilliseconds,
      ...details
    });
  }

  function formatChromeDownloadError(code) {
    const descriptions = {
      SERVER_FORBIDDEN: "O servidor recusou a URL do video (403). A assinatura pode ter expirado; de Play novamente e tente em seguida.",
      SERVER_UNAUTHORIZED: "O servidor exigiu uma autenticacao que nao acompanhou o download.",
      SERVER_BAD_CONTENT: "O servidor retornou um arquivo invalido ou incompleto.",
      SERVER_FAILED: "O servidor de video falhou durante o download.",
      NETWORK_FAILED: "A conexao falhou durante o download.",
      NETWORK_TIMEOUT: "A conexao com o servidor de video expirou.",
      NETWORK_DISCONNECTED: "A conexao foi interrompida durante o download.",
      FILE_FAILED: "O Chrome nao conseguiu gravar o arquivo no computador.",
      FILE_NO_SPACE: "Nao ha espaco suficiente para salvar o video.",
      FILE_ACCESS_DENIED: "O Chrome nao tem permissao para gravar no destino escolhido.",
      USER_CANCELED: "O download foi cancelado.",
      CRASH: "O processo de download do Chrome foi encerrado inesperadamente."
    };
    return descriptions[code] || `O Chrome interrompeu o download (${code || "motivo desconhecido"}).`;
  }

  function setDownloading(value) {
    isDownloading = value;
    button.disabled = value;
    const label = value ? "Baixando..." : getMediaButtonLabel(activeMedia);
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  function updateSegmentedProgress(progress) {
    if (progress.message) {
      button.title = "Preparando...";
      button.setAttribute("aria-label", "Preparando...");
      showPersistentStatus(progress.message);
      return;
    }

    const percentage = Number.isFinite(progress.percentage) ? progress.percentage : 0;
    button.title = `Baixando ${percentage}%`;
    button.setAttribute("aria-label", `Baixando ${percentage}%`);
    showPersistentStatus(`Baixando partes do video: ${progress.completed} de ${progress.total} (${percentage}%).`);
  }

  async function handleCopyError(event) {
    event.preventDefault();
    event.stopPropagation();
    cancelHide();

    const copied = lastErrorReport ? await copyText(lastErrorReport) : false;
    copyErrorButton.textContent = copied ? "Copiado!" : "Selecione o texto";

    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      status.classList.remove("visible");
    }, 5_000);
  }

  async function copyText(value) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        // Usa o metodo compativel abaixo quando a pagina bloqueia a API moderna.
      }
    }

    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    (document.body || document.documentElement).appendChild(textarea);
    textarea.select();

    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }

    textarea.remove();
    return copied;
  }

  function showStatus(message, isError) {
    window.clearTimeout(resetTimer);
    statusMessage.textContent = message;
    copyErrorButton.textContent = "Copiar diagnostico";
    status.classList.toggle("error", isError);
    status.classList.add("visible");
    updatePosition();

    resetTimer = window.setTimeout(() => {
      status.classList.remove("visible");
    }, isError ? 30_000 : 2_500);
  }
})();
