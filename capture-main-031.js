(() => {
  "use strict";

  if (window.__ctxMediaCaptureInstalled) {
    return;
  }
  window.__ctxMediaCaptureInstalled = true;

  const EVENT_NAME = "__ctx_media_resource";
  const INSTAGRAM_MEDIA_EVENT = "__ctx_instagram_media";
  const BYTES_REQUEST_EVENT = "__ctx_media_bytes_request";
  const BYTES_RESPONSE_MARKER = "__ctx_media_bytes_response";
  const MEDIA_PATTERN = /(?:\.mp4|\.m3u8|\.mpd|\.m4s|\.ts|\/playlist\.json)(?:[?#]|$)/i;
  const mediaByteCache = new Map();
  const mediaRequestCache = new Map();
  const mediaTemplateKeys = new Set();
  const mediaTransportByKey = new Map();
  const mediaOrigins = new Set();
  const playlistAllowedUrls = new Set();
  const SHOULD_INSTALL_NETWORK_HOOKS = shouldInstallNetworkHooks();

  function reportMediaUrl(value, source, responseDetails = null) {
    try {
      const candidate = value instanceof Request
        ? value.url
        : typeof value === "string"
          ? value
          : value?.url;

      if (!candidate || !/^https?:/i.test(candidate) || !MEDIA_PATTERN.test(candidate)) {
        return;
      }

      rememberMediaTemplate(candidate);

      document.dispatchEvent(new CustomEvent(EVENT_NAME, {
        detail: JSON.stringify({
          url: candidate,
          source,
          capturedAt: Date.now(),
          response: responseDetails
        })
      }));
    } catch {
      // A captura nunca deve interferir no player da pagina.
    }
  }

  const originalFetch = window.fetch;
  function ctxCapturedFetch(...args) {
    reportMediaUrl(args[0], "fetch-request");
    rememberMediaRequest(args);
    const request = Reflect.apply(originalFetch, this, args);
    request.then((response) => {
      reportMediaUrl(response.url || args[0], "fetch-response", describeResponse(response));
      rememberMediaResponse(response.url || getRequestUrl(args[0]), response);
      captureInstagramMediaResponse(response);
    }, () => {
      reportMediaUrl(args[0], "fetch-error", { failed: true });
    });
    return request;
  }
  if (SHOULD_INSTALL_NETWORK_HOOKS) {
    window.fetch = ctxCapturedFetch;
  }

  document.addEventListener(BYTES_REQUEST_EVENT, async (event) => {
    let request;
    try {
      request = JSON.parse(event.detail);
    } catch {
      return;
    }

    if (!request?.requestId || !Array.isArray(request.urls) || request.urls.length > 100) return;

    for (let index = 0; index < request.urls.length; index += 1) {
      const url = request.urls[index];
      try {
        if (!isSupportedMediaUrl(url) || !canReadObservedMedia(url)) {
          throw new Error("MIDIA_NAO_OBSERVADA_PELO_PLAYER");
        }
        const buffer = await getMediaBytes(url);
        const transferable = buffer.slice(0);
        window.postMessage({
          marker: BYTES_RESPONSE_MARKER,
          requestId: request.requestId,
          index,
          ok: true,
          buffer: transferable
        }, "*", [transferable]);
      } catch (error) {
        window.postMessage({
          marker: BYTES_RESPONSE_MARKER,
          requestId: request.requestId,
          index,
          ok: false,
          error: error?.message || "FALHA_AO_RECUPERAR_PARTE"
        }, "*");
      }
    }
  });

  function rememberMediaRequest(args) {
    const url = getRequestUrl(args[0]);
    if (!isSupportedMediaUrl(url)) return;
    rememberMediaTemplate(url, "fetch");
    try {
      const request = new Request(args[0], args[1]);
      mediaRequestCache.delete(url);
      mediaRequestCache.set(url, request);
      trimCache(mediaRequestCache, 250);
    } catch {
      // A resposta observada ainda podera ser reutilizada mesmo sem o Request.
    }
  }

  function rememberMediaResponse(url, response) {
    if (!isSupportedMediaUrl(url) || !response?.ok) return;
    rememberMediaTemplate(url);
    if (!shouldCacheMediaBytes(url)) return;
    try {
      const bytesPromise = response.clone().arrayBuffer();
      mediaByteCache.delete(url);
      mediaByteCache.set(url, bytesPromise);
      trimCache(mediaByteCache, 250);
      bytesPromise.catch(() => mediaByteCache.delete(url));
      learnPlaylistMediaUrls(url, bytesPromise);
    } catch {
      // Alguns tipos de resposta nao podem ser clonados.
    }
  }

  function captureInstagramMediaResponse(response) {
    try {
      if (!response?.ok || !isInstagramMetadataEndpoint(response.url)) return;
      const contentType = response.headers.get("content-type") || "";
      if (!/json/i.test(contentType)) return;
      response.clone().text().then((text) => {
        if (!text || text.length > 10_000_000) return;
        try {
          publishInstagramMedia(JSON.parse(text));
        } catch {
          // Respostas que nao sejam JSON de midia sao ignoradas.
        }
      }).catch(() => {});
    } catch {
      // A inspecao nunca deve interferir na resposta original da pagina.
    }
  }

  async function getMediaBytes(url) {
    const cached = mediaByteCache.get(url);
    if (cached) return cached;

    const request = mediaRequestCache.get(url);
    if (request) {
      const response = await Reflect.apply(originalFetch, window, [request.clone()]);
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      return response.arrayBuffer();
    }

    const transport = mediaTransportByKey.get(getMediaTemplateKey(url));
    const attempts = transport === "xhr"
      ? [getMediaBytesWithXhr, getMediaBytesWithFetch]
      : [getMediaBytesWithFetch, getMediaBytesWithXhr];
    let lastError = null;
    for (const attempt of attempts) {
      try {
        return await attempt(url);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("FALHA_AO_REPETIR_REQUISICAO_DO_PLAYER");
  }

  async function getMediaBytesWithFetch(url) {
    const response = await Reflect.apply(originalFetch, window, [url, {
      credentials: "same-origin",
      cache: "no-cache"
    }]);
    if (!response.ok) throw new Error(`FETCH_HTTP_${response.status}`);
    return response.arrayBuffer();
  }

  function getMediaBytesWithXhr(url) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.responseType = "arraybuffer";
      xhr.withCredentials = false;
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 400 && Number.isFinite(xhr.response?.byteLength)) {
          resolve(xhr.response);
        } else {
          reject(new Error(`XHR_HTTP_${xhr.status || 0}`));
        }
      };
      xhr.onerror = () => reject(new Error("XHR_FALHA_DE_REDE"));
      xhr.ontimeout = () => reject(new Error("XHR_TEMPO_ESGOTADO"));
      xhr.timeout = 20_000;
      xhr.send();
    });
  }

  function getRequestUrl(value) {
    return value instanceof Request ? value.url : typeof value === "string" ? value : value?.url || "";
  }

  function isInstagramRangeUrl(value) {
    try {
      const url = new URL(value);
      return /(?:^|\.)(?:fbcdn\.net|cdninstagram\.com)$/i.test(url.hostname)
        && /\.mp4$/i.test(url.pathname)
        && url.searchParams.has("bytestart")
        && url.searchParams.has("byteend");
    } catch {
      return false;
    }
  }

  function isSupportedMediaUrl(value) {
    try {
      const url = new URL(value);
      return /^https?:$/i.test(url.protocol)
        && (MEDIA_PATTERN.test(url.href) || playlistAllowedUrls.has(url.href));
    } catch {
      return false;
    }
  }

  function shouldCacheMediaBytes(value) {
    if (isInstagramRangeUrl(value)) return true;
    try {
      const url = new URL(value);
      return /(?:\.m3u8|\.mpd)$/i.test(url.pathname) || /\/playlist\.json$/i.test(url.pathname);
    } catch {
      return false;
    }
  }

  function getMediaTemplateKey(value) {
    try {
      const url = new URL(value);
      const match = url.pathname.match(/(\.m3u8|\.m4s|\.ts|\.mp4|\.mpd)$/i);
      const kind = match?.[1]?.toLowerCase() || (/\/playlist\.json$/i.test(url.pathname) ? "playlist-json" : null);
      return kind ? `${url.origin}|${kind}` : null;
    } catch {
      return null;
    }
  }

  function rememberMediaTemplate(value, transport = null) {
    try {
      mediaOrigins.add(new URL(value).origin);
    } catch {
      return;
    }
    const key = getMediaTemplateKey(value);
    if (key) {
      mediaTemplateKeys.add(key);
      if (transport) mediaTransportByKey.set(key, transport);
    }
  }

  function canReadObservedMedia(value) {
    try {
      const url = new URL(value);
      return playlistAllowedUrls.has(url.href)
        || mediaByteCache.has(url.href)
        || mediaRequestCache.has(url.href)
        || mediaTemplateKeys.has(getMediaTemplateKey(url.href))
        || (MEDIA_PATTERN.test(url.href) && mediaOrigins.has(url.origin));
    } catch {
      return false;
    }
  }

  function isInstagramMetadataEndpoint(value) {
    try {
      const url = new URL(value, location.href);
      return /(?:^|\.)instagram\.com$/i.test(url.hostname)
        && /(?:\/api\/graphql|\/graphql\/query|\/api\/v1\/)/i.test(url.pathname);
    } catch {
      return false;
    }
  }

  function shouldInstallNetworkHooks() {
    try {
      const host = location.hostname.toLowerCase();
      return /(?:^|\.)(?:instagram\.com|facebook\.com|fbcdn\.net|cdninstagram\.com|vimeo\.com|vimeocdn\.com|pandavideo\.com|pandavideo\.com\.br|youtube\.com|youtu\.be|googlevideo\.com|tiktok\.com|tiktokcdn\.com|hotmart\.com|memberkit\.com\.br|wistia\.com|wistia\.net|loom\.com|bunnycdn\.com|caduneiva\.com|converteai\.net|vturb\.com)$/i.test(host);
    } catch {
      return false;
    }
  }

  function publishInstagramMedia(root) {
    const stack = [root];
    const items = [];
    let inspected = 0;
    while (stack.length && inspected < 100_000 && items.length < 50) {
      const value = stack.pop();
      inspected += 1;
      if (!value || typeof value !== "object") continue;
      const code = typeof value.code === "string"
        ? value.code
        : typeof value.shortcode === "string"
          ? value.shortcode
          : null;
      if (code && Array.isArray(value.video_versions)) {
        const versions = value.video_versions
          .map((version) => sanitizeInstagramVersion(version))
          .filter(Boolean);
        if (versions.length) items.push({ code, versions });
      }
      for (const child of Object.values(value)) {
        if (child && typeof child === "object") stack.push(child);
      }
    }
    if (!items.length) return;
    document.dispatchEvent(new CustomEvent(INSTAGRAM_MEDIA_EVENT, {
      detail: JSON.stringify({ capturedAt: Date.now(), items })
    }));
  }

  function sanitizeInstagramVersion(version) {
    try {
      const url = new URL(version?.url);
      if (url.protocol !== "https:"
        || !/(?:^|\.)(?:fbcdn\.net|cdninstagram\.com)$/i.test(url.hostname)
        || !/\.mp4$/i.test(url.pathname)) {
        return null;
      }
      return {
        url: url.href,
        width: Number(version.width) || 0,
        height: Number(version.height) || 0,
        type: Number(version.type) || null
      };
    } catch {
      return null;
    }
  }

  function learnPlaylistMediaUrls(playlistUrl, bytesPromise) {
    try {
      if (!/\/playlist\.json(?:[?#]|$)/i.test(playlistUrl)) return;
      bytesPromise.then((buffer) => {
        let playlist;
        try {
          playlist = JSON.parse(new TextDecoder().decode(buffer));
        } catch {
          return;
        }
        const rootBase = new URL(playlist.base_url || "./", playlistUrl);
        for (const track of [...(playlist.video || []), ...(playlist.audio || [])]) {
          const trackBase = new URL(track?.base_url || "./", rootBase);
          if (track?.init_segment_url) rememberPlaylistUrl(track.init_segment_url, trackBase);
          for (const segment of track?.segments || []) {
            if (segment?.url) rememberPlaylistUrl(segment.url, trackBase);
          }
        }
      }).catch(() => {});
    } catch {
      // Uma playlist invalida nao deve interferir no player.
    }
  }

  function rememberPlaylistUrl(value, baseUrl) {
    try {
      const url = new URL(value, baseUrl);
      if (!/^https?:$/i.test(url.protocol)) return;
      playlistAllowedUrls.add(url.href);
      mediaOrigins.add(url.origin);
      while (playlistAllowedUrls.size > 5_000) {
        playlistAllowedUrls.delete(playlistAllowedUrls.values().next().value);
      }
    } catch {
      // Ignora URLs invalidas informadas pela playlist.
    }
  }

  function rememberXhrBytes(url, xhr) {
    if (!isSupportedMediaUrl(url) || xhr.status < 200 || xhr.status >= 400) return;
    rememberMediaTemplate(url);
    if (!shouldCacheMediaBytes(url)) return;
    try {
      let bytesPromise = null;
      if (xhr.response instanceof ArrayBuffer) {
        bytesPromise = Promise.resolve(xhr.response.slice(0));
      } else if (xhr.response instanceof Blob) {
        bytesPromise = xhr.response.arrayBuffer();
      } else if (typeof xhr.responseText === "string") {
        bytesPromise = Promise.resolve(new TextEncoder().encode(xhr.responseText).buffer);
      }
      if (!bytesPromise) return;
      mediaByteCache.delete(url);
      mediaByteCache.set(url, bytesPromise);
      trimCache(mediaByteCache, 250);
      bytesPromise.catch(() => mediaByteCache.delete(url));
      learnPlaylistMediaUrls(url, bytesPromise);
    } catch {
      // responseText pode lancar quando o responseType nao for texto.
    }
  }

  function trimCache(cache, maximumEntries) {
    while (cache.size > maximumEntries) cache.delete(cache.keys().next().value);
  }

  const originalXhrOpen = XMLHttpRequest.prototype.open;
  function ctxCapturedXhrOpen(method, url, ...args) {
    reportMediaUrl(url, "xhr-request");
    const requestedUrl = (() => {
      try { return new URL(String(url), location.href).href; } catch { return String(url); }
    })();
    rememberMediaTemplate(requestedUrl, "xhr");
    this.addEventListener("loadend", () => {
      const responseUrl = this.responseURL || requestedUrl;
      reportMediaUrl(responseUrl, "xhr-response", describeXhr(this));
      rememberXhrBytes(responseUrl, this);
      captureInstagramMediaXhr(responseUrl, this);
    }, { once: true });
    return Reflect.apply(originalXhrOpen, this, [method, url, ...args]);
  }
  if (SHOULD_INSTALL_NETWORK_HOOKS) {
    XMLHttpRequest.prototype.open = ctxCapturedXhrOpen;
  }

  function captureInstagramMediaXhr(url, xhr) {
    try {
      if (!isInstagramMetadataEndpoint(url) || xhr.status < 200 || xhr.status >= 400) return;
      let value = null;
      if (xhr.responseType === "json") {
        value = xhr.response;
      } else if (!xhr.responseType || xhr.responseType === "text") {
        const text = xhr.responseText;
        if (!text || text.length > 10_000_000) return;
        value = JSON.parse(text);
      }
      if (value) publishInstagramMedia(value);
    } catch {
      // Respostas XHR que nao contenham JSON de midia sao ignoradas.
    }
  }

  function describeResponse(response) {
    return {
      status: response.status || null,
      ok: Boolean(response.ok),
      contentType: response.headers.get("content-type"),
      contentLength: toSafeNumber(response.headers.get("content-length"))
    };
  }

  function describeXhr(xhr) {
    let contentType = null;
    let contentLength = null;
    try {
      const headers = parseExposedXhrHeaders(xhr.getAllResponseHeaders?.() || "");
      contentType = headers.get("content-type") || null;
      contentLength = toSafeNumber(headers.get("content-length"));
    } catch {
      // Alguns players impedem a leitura dos cabecalhos de resposta.
    }
    return {
      status: xhr.status || null,
      ok: xhr.status >= 200 && xhr.status < 400,
      contentType,
      contentLength
    };
  }

  function parseExposedXhrHeaders(value) {
    const headers = new Map();
    for (const line of String(value || "").split(/\r?\n/)) {
      const separator = line.indexOf(":");
      if (separator <= 0) continue;
      const name = line.slice(0, separator).trim().toLowerCase();
      const headerValue = line.slice(separator + 1).trim();
      if (name) headers.set(name, headerValue);
    }
    return headers;
  }

  function toSafeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }
})();
