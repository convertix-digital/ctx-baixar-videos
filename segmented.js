(() => {
  "use strict";

  const DASH_PLAYLIST_PATTERN = /vimeocdn\.com.*\/playlist\.json(?:[?#]|$)/i;
  const HLS_PLAYLIST_PATTERN = /\.m3u8(?:[?#]|$)/i;
  const DOWNLOAD_CONCURRENCY = 6;
  const TEMP_PREFIX = "ctx-video-temp-";
  const CAPTURE_EVENT = "__ctx_media_resource";
  const INSTAGRAM_MEDIA_EVENT = "__ctx_instagram_media";
  const BYTES_REQUEST_EVENT = "__ctx_media_bytes_request";
  const BYTES_RESPONSE_MARKER = "__ctx_media_bytes_response";
  const SAVE_REQUEST_MARKER = "__ctx_top_save_request";
  const SAVE_RESPONSE_MARKER = "__ctx_top_save_response";
  const REGISTER_BACKGROUND_SAVE_HANDLE_MESSAGE = "REGISTER_BACKGROUND_SAVE_HANDLE";
  const SAVE_PICKER_ID = "ctx-video-download";
  const IS_EXTENSION_PAGE = typeof location !== "undefined" && location.protocol === "chrome-extension:";
  const capturedResources = [];
  const capturedInstagramMedia = new Map();

  if (window === window.top) {
    window.addEventListener("message", handleTopLevelSaveRequest);
  }

  document.addEventListener(CAPTURE_EVENT, (event) => {
    try {
      const resource = JSON.parse(event.detail);
      if (!resource?.url || !/^https?:/i.test(resource.url)) return;
      capturedResources.push(resource);
      if (capturedResources.length > 1_000) capturedResources.splice(0, 250);
    } catch {
      // Ignora eventos que nao tenham sido gerados pelo capturador da extensao.
    }
  });

  document.addEventListener(INSTAGRAM_MEDIA_EVENT, (event) => {
    try {
      const payload = JSON.parse(event.detail);
      for (const item of payload?.items || []) {
        if (!item?.code || !Array.isArray(item.versions)) continue;
        const versions = item.versions.filter((version) => isInstagramDirectUrl(version?.url));
        if (!versions.length) continue;
        capturedInstagramMedia.delete(item.code);
        capturedInstagramMedia.set(item.code, {
          code: item.code,
          video_versions: versions,
          capturedAt: payload.capturedAt || Date.now()
        });
      }
      while (capturedInstagramMedia.size > 50) {
        capturedInstagramMedia.delete(capturedInstagramMedia.keys().next().value);
      }
    } catch {
      // Ignora metadados que nao tenham sido publicados pelo capturador.
    }
  });

  function hasSegmentedSources() {
    return getResourceUrls().some((url) => (
      DASH_PLAYLIST_PATTERN.test(url)
      || HLS_PLAYLIST_PATTERN.test(url)
      || isInstagramRangeUrl(url)
    ));
  }

  function hasBackgroundCompatibleSources() {
    return getResourceUrls().some((url) => (
      DASH_PLAYLIST_PATTERN.test(url) || HLS_PLAYLIST_PATTERN.test(url)
    ));
  }

  function canRunInBackground(source) {
    return !source?.instagramPlan && hasBackgroundCompatibleSources();
  }

  function getSegmentedResourceSnapshot() {
    return getResourceUrls()
      .filter((url) => DASH_PLAYLIST_PATTERN.test(url) || HLS_PLAYLIST_PATTERN.test(url))
      .slice(-50);
  }

  function replaceCapturedResources(resources) {
    capturedResources.length = 0;
    for (const value of Array.isArray(resources) ? resources : []) {
      try {
        const url = new URL(value);
        if (url.protocol !== "https:"
          || (!DASH_PLAYLIST_PATTERN.test(url.href) && !HLS_PLAYLIST_PATTERN.test(url.href))) {
          continue;
        }
        capturedResources.push({
          url: url.href,
          source: "contexto-transferido",
          capturedAt: Date.now()
        });
      } catch {
        // Ignora recursos que nao sejam playlists HTTPS validas.
      }
    }
  }

  function shouldDownloadSegmented(source, detectedBeforeResolution) {
    if (source?.segmented === true) return true;
    try {
      const url = new URL(source?.url, location.href);
      if (/^https?:$/i.test(url.protocol) && /\.(?:mp4|webm|ogv|ogg|mov|m4v|avi|mkv)$/i.test(url.pathname)) {
        return false;
      }
      if (/\.(?:m3u8|mpd)$/i.test(url.pathname)) return true;
    } catch {
      // Uma fonte blob continua dependendo da deteccao feita antes da resolucao.
    }
    return Boolean(detectedBeforeResolution);
  }

  function prepareSaveHandle() {
    if (!hasSegmentedSources()) {
      return null;
    }

    const { suggestedName, extension, mime } = getSaveSuggestion();

    if (window !== window.top) {
      return requestTopLevelSaveWriter({ suggestedName, extension, mime });
    }

    if (typeof window.showSaveFilePicker !== "function") {
      return null;
    }

    try {
      return window.showSaveFilePicker({
        id: SAVE_PICKER_ID,
        suggestedName,
        types: [{ description: "Arquivo de video", accept: { [mime]: [`.${extension}`] } }]
      }).then(
        (handle) => ({ handle, error: null }),
        (error) => ({ handle: null, error })
      );
    } catch (error) {
      return Promise.resolve({ handle: null, error });
    }
  }

  function prepareBackgroundSaveHandle() {
    if (!hasSegmentedSources()) return null;

    const { suggestedName, extension, mime } = getSaveSuggestion();

    if (window !== window.top) {
      return requestTopLevelSaveWriter({ suggestedName, extension, mime, background: true });
    }

    if (typeof window.showSaveFilePicker !== "function") {
      return Promise.resolve({
        handleToken: null,
        error: new Error("Este Chrome nao oferece o seletor necessario para escolher o arquivo antes do download.")
      });
    }

    try {
      const handlePromise = window.showSaveFilePicker({
        id: SAVE_PICKER_ID,
        suggestedName,
        types: [{ description: "Arquivo de video", accept: { [mime]: [`.${extension}`] } }]
      });
      return handlePromise.then(async (handle) => {
        const response = await registerBackgroundSaveHandle(handle);
        return response?.ok
          ? { handleToken: response.handleToken, error: null }
          : { handleToken: null, error: new Error(response?.error || "O arquivo escolhido nao foi registrado.") };
      }, (error) => ({ handleToken: null, error }));
    } catch (error) {
      return Promise.resolve({ handleToken: null, error });
    }
  }

  function getSaveSuggestion() {
    const resources = getResourceUrls();
    const isDash = resources.some((url) => DASH_PLAYLIST_PATTERN.test(url) || isInstagramRangeUrl(url));
    const hasTs = resources.some((url) => /\.ts(?:[?#]|$)/i.test(url));
    const extension = isDash ? "mp4" : hasTs ? "ts" : "mp4";
    const mime = extension === "ts" ? "video/mp2t" : "video/mp4";
    const suggestedName = `video-${Date.now()}.${extension}`;
    return { suggestedName, extension, mime };
  }

  function requestTopLevelSaveWriter({ suggestedName, extension, mime, background = false }) {
    const requestId = crypto.randomUUID();
    const channel = new MessageChannel();

    return new Promise((resolve) => {
      let timeout = setTimeout(() => {
        channel.port1.close();
        resolve({ remoteWriter: null, error: new Error("O seletor de arquivo da pagina principal nao respondeu.") });
      }, 8_000);

      channel.port1.onmessage = (event) => {
        const message = event.data;
        if (message?.marker !== SAVE_RESPONSE_MARKER || message.requestId !== requestId) return;
        if (message.status === "picker-opened") {
          clearTimeout(timeout);
          timeout = setTimeout(() => {
            channel.port1.close();
            const error = new Error("O tempo para escolher o arquivo terminou.");
            error.name = "TimeoutError";
            resolve({ remoteWriter: null, error });
          }, 5 * 60 * 1_000);
          return;
        }
        clearTimeout(timeout);
        if (message.status === "ready") {
          if (message.handleToken) {
            channel.port1.close();
            resolve({ handleToken: message.handleToken, error: null });
          } else {
            resolve({ remoteWriter: createRemoteSaveWriter(channel.port1, requestId), error: null });
          }
        } else {
          channel.port1.close();
          const error = new Error(message.message || "Nao foi possivel abrir o seletor de arquivo.");
          error.name = message.name || "Error";
          resolve({ remoteWriter: null, error });
        }
      };

      window.top.postMessage({
        marker: SAVE_REQUEST_MARKER,
        requestId,
        suggestedName,
        extension,
        mime,
        background
      }, "*", [channel.port2]);
    });
  }

  async function handleTopLevelSaveRequest(event) {
    const request = event.data;
    const port = event.ports?.[0];
    if (window !== window.top
      || request?.marker !== SAVE_REQUEST_MARKER
      || !request.requestId
      || !port) return;

    if (!navigator.userActivation?.isActive || typeof window.showSaveFilePicker !== "function") {
      port.postMessage({
        marker: SAVE_RESPONSE_MARKER,
        requestId: request.requestId,
        status: "error",
        name: "NotAllowedError",
        message: "O Chrome nao permitiu abrir o seletor de arquivo na pagina principal."
      });
      return;
    }

    const extension = ["mp4", "ts"].includes(request.extension) ? request.extension : "mp4";
    const mime = extension === "ts" ? "video/mp2t" : "video/mp4";
    const suggestedName = typeof request.suggestedName === "string" && request.suggestedName.endsWith(`.${extension}`)
      ? request.suggestedName
      : `video-${Date.now()}.${extension}`;

    try {
      port.postMessage({
        marker: SAVE_RESPONSE_MARKER,
        requestId: request.requestId,
        status: "picker-opened"
      });
      const handle = await window.showSaveFilePicker({
        id: SAVE_PICKER_ID,
        suggestedName,
        types: [{ description: "Arquivo de video", accept: { [mime]: [`.${extension}`] } }]
      });
      if (request.background === true) {
        const response = await registerBackgroundSaveHandle(handle);
        if (!response?.ok || !response.handleToken) {
          throw new Error(response?.error || "O arquivo escolhido nao foi registrado.");
        }
        port.postMessage({
          marker: SAVE_RESPONSE_MARKER,
          requestId: request.requestId,
          status: "ready",
          handleToken: response.handleToken
        });
        port.close();
        return;
      }
      const writable = await handle.createWritable();
      port.postMessage({ marker: SAVE_RESPONSE_MARKER, requestId: request.requestId, status: "ready" });
      serveRemoteSaveWriter(port, request.requestId, writable);
    } catch (error) {
      port.postMessage({
        marker: SAVE_RESPONSE_MARKER,
        requestId: request.requestId,
        status: "error",
        name: error?.name || "Error",
        message: error?.name === "AbortError"
          ? "A escolha do arquivo foi cancelada."
          : "Nao foi possivel criar o arquivo no local escolhido."
      });
    }
  }

  function registerBackgroundSaveHandle(handle) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: REGISTER_BACKGROUND_SAVE_HANDLE_MESSAGE,
        handle
      }, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    });
  }

  function serveRemoteSaveWriter(port, requestId, writable) {
    let queue = Promise.resolve();
    port.onmessage = (event) => {
      const message = event.data;
      if (message?.marker !== SAVE_REQUEST_MARKER || message.requestId !== requestId || !message.callId) return;
      queue = queue.then(async () => {
        if (message.command === "write" && message.buffer instanceof ArrayBuffer) {
          await writable.write(new Uint8Array(message.buffer));
        } else if (message.command === "close") {
          await writable.close();
        } else if (message.command === "abort") {
          await writable.abort().catch(() => {});
        } else {
          throw new Error("Comando de gravacao invalido.");
        }
        port.postMessage({ marker: SAVE_RESPONSE_MARKER, requestId, callId: message.callId, status: "ok" });
        if (message.command === "close" || message.command === "abort") port.close();
      }).catch((error) => {
        port.postMessage({
          marker: SAVE_RESPONSE_MARKER,
          requestId,
          callId: message.callId,
          status: "error",
          message: error?.message || "Falha ao gravar o arquivo."
        });
      });
    };
  }

  function createRemoteSaveWriter(port, requestId) {
    const pending = new Map();
    port.onmessage = (event) => {
      const message = event.data;
      if (message?.marker !== SAVE_RESPONSE_MARKER || message.requestId !== requestId || !message.callId) return;
      const operation = pending.get(message.callId);
      if (!operation) return;
      clearTimeout(operation.timeout);
      pending.delete(message.callId);
      if (message.status === "ok") operation.resolve();
      else operation.reject(new Error(message.message || "Falha ao gravar o arquivo."));
    };

    function call(command, bytes = null) {
      const callId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(callId);
          reject(new Error("A gravacao do arquivo demorou demais para responder."));
        }, command === "write" ? 30_000 : 120_000);
        pending.set(callId, { resolve, reject, timeout });
        if (bytes) {
          const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
            ? bytes.buffer
            : bytes.slice().buffer;
          port.postMessage({ marker: SAVE_REQUEST_MARKER, requestId, callId, command, buffer }, [buffer]);
        } else {
          port.postMessage({ marker: SAVE_REQUEST_MARKER, requestId, callId, command });
        }
      });
    }

    return {
      write: (bytes) => call("write", bytes),
      close: () => call("close"),
      abort: () => call("abort").catch(() => {})
    };
  }

  async function downloadSegmented({ source, videoId, diagnostics, onProgress, saveHandlePromise }) {
    const resources = getResourceUrls();
    const dashCandidates = resources.filter((url) => DASH_PLAYLIST_PATTERN.test(url)).reverse();
    const hlsCandidates = resources.filter((url) => HLS_PLAYLIST_PATTERN.test(url)).reverse();

    diagnostics.segmented = {
      detected: true,
      type: source?.instagramPlan ? "instagram-dash" : dashCandidates.length ? "vimeo-dash" : hlsCandidates.length ? "hls" : null,
      playlistCandidates: dashCandidates.length || hlsCandidates.length,
      playlistFetched: false,
      encrypted: false,
      videoQuality: null,
      videoSegments: 0,
      audioSegments: 0,
      outputMode: null,
      outputBytes: 0,
      stage: "detectando-playlist"
    };

    if (source?.instagramPlan) {
      return downloadInstagramDash({
        plan: source.instagramPlan,
        filename: source.filename,
        diagnostics,
        onProgress,
        saveHandlePromise
      });
    }

    if (dashCandidates.length) {
      return downloadVimeoDash({ dashCandidates, videoId, diagnostics, onProgress, saveHandlePromise });
    }

    if (hlsCandidates.length) {
      return downloadHls({ hlsCandidates, videoId, diagnostics, onProgress, saveHandlePromise });
    }

    throw new Error("Inicie o video por alguns segundos para a playlist aparecer e tente novamente.");
  }

  async function downloadVimeoDash({ dashCandidates, videoId, diagnostics, onProgress, saveHandlePromise }) {
    onProgress({ phase: "playlist", message: "Lendo playlist DASH do Vimeo..." });
    diagnostics.segmented.stage = "lendo-playlist-dash";
    diagnostics.segmented.playlistAttempts = [];
    const { playlist, playlistUrl } = await findDashPlaylist(dashCandidates, diagnostics);
    diagnostics.segmented.playlistFetched = true;

    const video = [...playlist.video]
      .filter((track) => track?.mime_type === "video/mp4" && /^avc1/i.test(track.codecs || ""))
      .sort((first, second) => (second.height || 0) - (first.height || 0))[0];
    const audio = playlist.audio?.find((track) => track?.audio_primary)
      || [...(playlist.audio || [])].sort((first, second) => (second.bitrate || 0) - (first.bitrate || 0))[0];

    if (!video || !audio) {
      throw new Error("A playlist DASH nao contem trilhas MP4 H.264 e AAC compativeis.");
    }

    const videoInit = await getTrackInit(video, playlist, playlistUrl, fetchDashBytes);
    const audioInit = await getTrackInit(audio, playlist, playlistUrl, fetchDashBytes);
    if (containsAscii(videoInit, "pssh") || containsAscii(audioInit, "pssh")) {
      diagnostics.segmented.encrypted = true;
      throw new Error("O fluxo DASH utiliza DRM e nao pode ser processado.");
    }

    const duration = Math.max(video.duration || 0, audio.duration || 0);
    const combinedInit = mergeInitSegments(videoInit, audioInit, duration);
    const rootBase = new URL(playlist.base_url || "./", playlistUrl);
    const videoBase = new URL(video.base_url || "./", rootBase);
    const audioBase = new URL(audio.base_url || "./", rootBase);
    const descriptors = [];
    const segmentCount = Math.max(video.segments?.length || 0, audio.segments?.length || 0);
    let sequence = 1;

    for (let index = 0; index < segmentCount; index += 1) {
      if (video.segments?.[index]) {
        descriptors.push({
          url: new URL(video.segments[index].url, videoBase).href,
          trackId: 1,
          sequence: sequence++
        });
      }
      if (audio.segments?.[index]) {
        descriptors.push({
          url: new URL(audio.segments[index].url, audioBase).href,
          trackId: 2,
          sequence: sequence++
        });
      }
    }

    diagnostics.segmented.videoQuality = video.height ? `${video.height}p` : video.quality || null;
    diagnostics.segmented.videoSegments = video.segments?.length || 0;
    diagnostics.segmented.audioSegments = audio.segments?.length || 0;

    const filename = `vimeo-${videoId || playlist.clip_id || "video"}-${video.height || "hd"}p.mp4`;
    diagnostics.segmented.stage = "preparando-arquivo";
    const output = await createOutput(filename, saveHandlePromise, diagnostics);

    try {
      await output.write(combinedInit);
      diagnostics.segmented.stage = "baixando-segmentos";
      await downloadOrdered(
        descriptors,
        output,
        onProgress,
        (bytes, descriptor) => patchFragment(bytes, descriptor.trackId, descriptor.sequence),
        async (descriptor, index) => {
          try {
            return await fetchDashBytes(descriptor.url);
          } catch (error) {
            diagnostics.segmented.segmentFailure = {
              index,
              host: safeHost(descriptor.url),
              name: error?.name || "Error",
              message: error?.message || "Falha ao baixar fragmento DASH"
            };
            throw error;
          }
        }
      );
      const result = await output.finish(filename, "video/mp4");
      diagnostics.segmented.stage = "concluido";
      return result;
    } catch (error) {
      await output.abort();
      throw error;
    }
  }

  async function downloadInstagramDash({ plan, filename, diagnostics, onProgress, saveHandlePromise }) {
    const videoRanges = plan.video.contiguousRanges;
    const audioRanges = plan.audio.contiguousRanges;
    const descriptors = [
      ...videoRanges.map((range) => ({ ...range, type: "video" })),
      ...audioRanges.map((range) => ({ ...range, type: "audio" }))
    ];

    diagnostics.segmented.playlistFetched = true;
    diagnostics.segmented.videoQuality = plan.video.quality ? `q${plan.video.quality}` : null;
    diagnostics.segmented.videoSegments = videoRanges.length;
    diagnostics.segmented.audioSegments = audioRanges.length;
    diagnostics.segmented.stage = "recuperando-partes-do-player";
    onProgress({ phase: "playlist", message: "Recuperando video e audio carregados pelo Instagram..." });

    const byteParts = await requestCapturedMediaBytes(descriptors.map((descriptor) => descriptor.url), (completed) => {
      onProgress({
        phase: "download",
        completed,
        total: descriptors.length,
        percentage: Math.floor((completed / descriptors.length) * 70)
      });
    });

    descriptors.forEach((descriptor, index) => {
      const expectedLength = descriptor.end - descriptor.start + 1;
      if (byteParts[index].byteLength !== expectedLength) {
        throw new Error(`Parte do Instagram com tamanho inesperado (${byteParts[index].byteLength}/${expectedLength} bytes).`);
      }
    });

    const videoBytes = concatBytes(byteParts.slice(0, videoRanges.length));
    const audioBytes = concatBytes(byteParts.slice(videoRanges.length));
    const videoTrack = splitFragmentedTrack(videoBytes);
    const audioTrack = splitFragmentedTrack(audioBytes);
    if (containsAscii(videoTrack.init, "pssh") || containsAscii(audioTrack.init, "pssh")) {
      diagnostics.segmented.encrypted = true;
      throw new Error("O Reel utiliza DRM e nao pode ser processado.");
    }

    const combinedInit = mergeInitSegments(videoTrack.init, audioTrack.init, plan.durationSeconds);
    const videoTimescale = getTrackTimescale(videoTrack.init);
    const audioTimescale = getTrackTimescale(audioTrack.init);
    const fragments = [
      ...videoTrack.fragments.map((bytes) => ({
        bytes,
        trackId: 1,
        decodeTimeSeconds: getFragmentDecodeTime(bytes) / videoTimescale
      })),
      ...audioTrack.fragments.map((bytes) => ({
        bytes,
        trackId: 2,
        decodeTimeSeconds: getFragmentDecodeTime(bytes) / audioTimescale
      }))
    ].sort((first, second) => (
      first.decodeTimeSeconds - second.decodeTimeSeconds
      || first.trackId - second.trackId
    ));

    if (!videoTrack.fragments.length || !audioTrack.fragments.length) {
      throw new Error("As trilhas do Instagram nao continham fragmentos MP4 completos.");
    }

    diagnostics.segmented.stage = "montando-video-e-audio";
    diagnostics.segmented.instagram = {
      videoBytes: videoBytes.byteLength,
      audioBytes: audioBytes.byteLength,
      videoFragments: videoTrack.fragments.length,
      audioFragments: audioTrack.fragments.length,
      videoTimescale,
      audioTimescale
    };
    onProgress({ phase: "playlist", message: "Unindo video e audio do Instagram..." });

    const output = await createOutput(filename, saveHandlePromise, diagnostics);
    try {
      await output.write(combinedInit);
      for (let index = 0; index < fragments.length; index += 1) {
        await output.write(patchFragment(fragments[index].bytes, fragments[index].trackId, index + 1));
        onProgress({
          phase: "download",
          completed: descriptors.length + index + 1,
          total: descriptors.length + fragments.length,
          percentage: 70 + Math.floor(((index + 1) / fragments.length) * 30)
        });
      }
      const result = await output.finish(filename, "video/mp4");
      diagnostics.segmented.stage = "concluido";
      return result;
    } catch (error) {
      await output.abort();
      throw error;
    }
  }

  function requestCapturedMediaBytes(urls, onPart, timeoutMilliseconds = 20_000) {
    if (IS_EXTENSION_PAGE) {
      return Promise.reject(new Error("O contexto em segundo plano usa acesso direto da extensao."));
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const results = new Array(urls.length);
      let completed = 0;
      const timeout = setTimeout(() => finish(new Error("O contexto do player demorou demais para responder.")), timeoutMilliseconds);

      function handleMessage(event) {
        const message = event.data;
        if (event.source !== window
          || message?.marker !== BYTES_RESPONSE_MARKER
          || message.requestId !== requestId
          || !Number.isInteger(message.index)
          || message.index < 0
          || message.index >= urls.length
          || results[message.index]) return;

        if (!message.ok || !(message.buffer instanceof ArrayBuffer)) {
          finish(new Error(`Nao foi possivel recuperar a midia observada pelo player (${message.error || "erro desconhecido"}).`));
          return;
        }

        results[message.index] = new Uint8Array(message.buffer);
        completed += 1;
        onPart?.(completed);
        if (completed === urls.length) finish(null, results);
      }

      function finish(error, value) {
        clearTimeout(timeout);
        window.removeEventListener("message", handleMessage);
        if (error) reject(error);
        else resolve(value);
      }

      window.addEventListener("message", handleMessage);
      document.dispatchEvent(new CustomEvent(BYTES_REQUEST_EVENT, {
        detail: JSON.stringify({ requestId, urls })
      }));
    });
  }

  function splitFragmentedTrack(data) {
    const boxes = readBoxes(data);
    const initBoxes = boxes.filter((box) => box.type === "ftyp" || box.type === "moov");
    if (!initBoxes.some((box) => box.type === "ftyp") || !initBoxes.some((box) => box.type === "moov")) {
      throw new Error("Cabecalho MP4 do Instagram incompleto.");
    }

    const fragments = [];
    let current = [];
    for (const box of boxes) {
      if (box.type === "moof") {
        if (current.length) current = [];
        current.push(cloneBox(data, box));
      } else if (box.type === "mdat" && current.length) {
        current.push(cloneBox(data, box));
        fragments.push(concatBytes(current));
        current = [];
      }
    }

    return {
      init: concatBytes(initBoxes.map((box) => cloneBox(data, box))),
      fragments
    };
  }

  function getTrackTimescale(init) {
    const moov = requireBox(readBoxes(init), "moov");
    const trak = requireBox(readBoxes(init, moov.start + moov.headerSize, moov.end), "trak");
    const mdia = requireBox(readBoxes(init, trak.start + trak.headerSize, trak.end), "mdia");
    const mdhd = requireBox(readBoxes(init, mdia.start + mdia.headerSize, mdia.end), "mdhd");
    return readFullBoxTimescale(init, mdhd);
  }

  function getFragmentDecodeTime(fragment) {
    const moof = requireBox(readBoxes(fragment), "moof");
    const traf = requireBox(readBoxes(fragment, moof.start + moof.headerSize, moof.end), "traf");
    const tfdt = requireBox(readBoxes(fragment, traf.start + traf.headerSize, traf.end), "tfdt");
    const version = fragment[tfdt.start + 8];
    return version === 1
      ? readUint32(fragment, tfdt.start + 12) * 2 ** 32 + readUint32(fragment, tfdt.start + 16)
      : readUint32(fragment, tfdt.start + 12);
  }

  async function downloadHls({ hlsCandidates, videoId, diagnostics, onProgress, saveHandlePromise }) {
    onProgress({ phase: "playlist", message: "Lendo playlist HLS..." });
    diagnostics.segmented.stage = "lendo-playlist-hls";
    diagnostics.segmented.playlistAttempts = [];
    const manifest = await findBestHlsManifest(hlsCandidates, diagnostics);
    diagnostics.segmented.playlistFetched = true;
    diagnostics.segmented.videoQuality = manifest.quality;

    if (manifest.audio) {
      return downloadSeparateHlsTracks({ manifest, videoId, diagnostics, onProgress, saveHandlePromise });
    }

    const media = parseHlsMediaPlaylist(manifest.text, manifest.url);
    if (media.encryptionMethod && media.encryptionMethod !== "NONE") {
      diagnostics.segmented.encrypted = true;
      throw new Error(`A playlist HLS utiliza criptografia ${media.encryptionMethod}.`);
    }
    if (!media.segments.length) {
      throw new Error("A playlist HLS nao contem segmentos de video.");
    }

    const isFmp4 = Boolean(media.init) || media.segments.some((segment) => /\.m4s(?:[?#]|$)/i.test(segment.url));
    if (isFmp4 && !media.init) {
      throw new Error("A playlist HLS fragmentada nao informou o segmento de inicializacao.");
    }

    const extension = isFmp4 ? "mp4" : "ts";
    const mime = isFmp4 ? "video/mp4" : "video/mp2t";
    const filename = `video-hls-${Date.now()}.${extension}`;
    diagnostics.segmented.videoSegments = media.segments.length;
    diagnostics.segmented.stage = "preparando-arquivo";
    const output = await createOutput(filename, saveHandlePromise, diagnostics);

    try {
      if (media.init) {
        const initBytes = await fetchHlsBytes(media.init.url, media.init.range);
        if (containsAscii(initBytes, "pssh")) {
          diagnostics.segmented.encrypted = true;
          throw new Error("O fluxo HLS utiliza DRM e nao pode ser processado.");
        }
        await output.write(initBytes);
      }

      diagnostics.segmented.stage = "baixando-segmentos";
      await downloadOrdered(
        media.segments,
        output,
        onProgress,
        (bytes) => bytes,
        async (descriptor, index) => {
          try {
            return await fetchHlsBytes(descriptor.url, descriptor.range);
          } catch (error) {
            diagnostics.segmented.segmentFailure = {
              index,
              host: safeHost(descriptor.url),
              hasRange: Boolean(descriptor.range),
              name: error?.name || "Error",
              message: error?.message || "Falha ao baixar segmento HLS"
            };
            throw error;
          }
        }
      );
      const result = await output.finish(filename, mime);
      diagnostics.segmented.stage = "concluido";
      return result;
    } catch (error) {
      await output.abort();
      throw error;
    }
  }

  async function downloadSeparateHlsTracks({ manifest, videoId, diagnostics, onProgress, saveHandlePromise }) {
    const videoMedia = parseHlsMediaPlaylist(manifest.text, manifest.url);
    const audioMedia = parseHlsMediaPlaylist(manifest.audio.text, manifest.audio.url);
    const encryptionMethod = videoMedia.encryptionMethod || audioMedia.encryptionMethod;
    if (encryptionMethod && encryptionMethod !== "NONE") {
      diagnostics.segmented.encrypted = true;
      throw new Error(`A playlist HLS utiliza criptografia ${encryptionMethod}.`);
    }
    if (!videoMedia.segments.length || !audioMedia.segments.length) {
      throw new Error("As playlists HLS separadas nao contem partes suficientes de video e audio.");
    }
    if (!videoMedia.init || !audioMedia.init) {
      throw new Error("Este HLS separa audio e video em um formato que nao e MP4 fragmentado.");
    }

    diagnostics.segmented.type = "hls-audio-video";
    diagnostics.segmented.videoSegments = videoMedia.segments.length;
    diagnostics.segmented.audioSegments = audioMedia.segments.length;
    diagnostics.segmented.stage = "baixando-cabecalhos-hls";
    onProgress({ phase: "playlist", message: "Preparando as trilhas de video e audio..." });

    const [videoInit, audioInit] = await Promise.all([
      fetchHlsBytes(videoMedia.init.url, videoMedia.init.range),
      fetchHlsBytes(audioMedia.init.url, audioMedia.init.range)
    ]);
    if (containsAscii(videoInit, "pssh") || containsAscii(audioInit, "pssh")) {
      diagnostics.segmented.encrypted = true;
      throw new Error("O fluxo HLS utiliza DRM e nao pode ser processado.");
    }

    const durationSeconds = Math.max(videoMedia.totalDuration, audioMedia.totalDuration);
    const combinedInit = mergeInitSegments(videoInit, audioInit, durationSeconds);
    const descriptors = [];
    const segmentCount = Math.max(videoMedia.segments.length, audioMedia.segments.length);
    let sequence = 1;
    for (let index = 0; index < segmentCount; index += 1) {
      if (videoMedia.segments[index]) {
        descriptors.push({ ...videoMedia.segments[index], trackId: 1, sequence: sequence++, mediaType: "video" });
      }
      if (audioMedia.segments[index]) {
        descriptors.push({ ...audioMedia.segments[index], trackId: 2, sequence: sequence++, mediaType: "audio" });
      }
    }

    const quality = manifest.quality || "hd";
    const filename = `vimeo-${videoId || "video"}-${quality}.mp4`;
    diagnostics.segmented.stage = "preparando-arquivo";
    const output = await createOutput(filename, saveHandlePromise, diagnostics);
    try {
      await output.write(combinedInit);
      diagnostics.segmented.stage = "baixando-e-unindo-hls";
      await downloadOrdered(
        descriptors,
        output,
        onProgress,
        (bytes, descriptor) => patchFragment(bytes, descriptor.trackId, descriptor.sequence),
        async (descriptor, index) => {
          try {
            return await fetchHlsBytes(descriptor.url, descriptor.range);
          } catch (error) {
            diagnostics.segmented.segmentFailure = {
              index,
              mediaType: descriptor.mediaType,
              host: safeHost(descriptor.url),
              hasRange: Boolean(descriptor.range),
              name: error?.name || "Error",
              message: error?.message || "Falha ao baixar parte HLS"
            };
            throw error;
          }
        }
      );
      const result = await output.finish(filename, "video/mp4");
      diagnostics.segmented.stage = "concluido";
      return result;
    } catch (error) {
      await output.abort();
      throw error;
    }
  }

  async function findDashPlaylist(candidates, diagnostics) {
    let lastError = null;
    for (const candidate of candidates) {
      try {
        const result = await fetchObservedText(candidate, 8_000);
        const playlist = JSON.parse(result.text);
        diagnostics.segmented.playlistAttempts.push({
          host: safeHost(candidate),
          status: "ok",
          method: result.method,
          bytes: result.bytes,
          videoTracks: Array.isArray(playlist.video) ? playlist.video.length : 0,
          audioTracks: Array.isArray(playlist.audio) ? playlist.audio.length : 0
        });
        if (Array.isArray(playlist.video) && Array.isArray(playlist.audio)) {
          return { playlist, playlistUrl: candidate };
        }
      } catch (error) {
        const host = safeHost(candidate);
        diagnostics.segmented.playlistAttempts.push({
          host,
          status: "falhou",
          name: error?.name || "Error",
          message: error?.message || "Falha ao ler playlist DASH"
        });
        lastError = new Error(`${error?.message || "Falha de rede"} em ${host}`);
      }
    }
    throw new Error(`Nao foi possivel ler a playlist DASH${lastError ? `: ${lastError.message}` : "."}`);
  }

  async function findBestHlsManifest(candidates, diagnostics) {
    const fetched = [];
    let master = null;

    for (const candidate of candidates.slice(0, 12)) {
      try {
        const result = await fetchHlsText(candidate);
        const text = result.text;
        diagnostics.segmented.playlistAttempts.push({
          host: safeHost(candidate),
          status: "ok",
          method: result.method,
          bytes: result.bytes,
          kind: text.includes("#EXT-X-STREAM-INF") ? "master" : "media",
          segments: countHlsSegments(text)
        });
        if (!text.includes("#EXTM3U")) continue;
        if (text.includes("#EXT-X-STREAM-INF")) {
          master = { text, url: candidate };
          break;
        }
        fetched.push({ text, url: candidate });
      } catch (error) {
        diagnostics.segmented.playlistAttempts.push({
          host: safeHost(candidate),
          status: "falhou",
          name: error?.name || "Error",
          message: error?.message || "Falha ao ler playlist HLS"
        });
        // Tenta outra playlist observada pelo player.
      }
    }

    if (master) {
      const variants = parseHlsMasterPlaylist(master.text, master.url);
      const best = variants.sort((first, second) => second.score - first.score)[0];
      if (!best) throw new Error("A playlist mestre HLS nao contem variantes.");
      const selected = await fetchHlsText(best.url);
      diagnostics.segmented.playlistAttempts.push({
        host: safeHost(best.url),
        status: "ok",
        method: selected.method,
        bytes: selected.bytes,
        kind: "variante-selecionada",
        segments: countHlsSegments(selected.text)
      });
      let audio = null;
      if (best.audioUri) {
        const selectedAudio = await fetchHlsText(best.audioUri);
        diagnostics.segmented.playlistAttempts.push({
          host: safeHost(best.audioUri),
          status: "ok",
          method: selectedAudio.method,
          bytes: selectedAudio.bytes,
          kind: "audio-selecionado",
          segments: countHlsSegments(selectedAudio.text)
        });
        audio = { text: selectedAudio.text, url: best.audioUri };
      }
      return {
        text: selected.text,
        url: best.url,
        quality: best.quality,
        audio
      };
    }

    const bestMedia = fetched.sort((first, second) => countHlsSegments(second.text) - countHlsSegments(first.text))[0];
    if (!bestMedia) throw new Error("Nao foi possivel ler nenhuma playlist HLS observada pelo player.");
    return { ...bestMedia, quality: inferQualityFromUrl(bestMedia.url) };
  }

  function parseHlsMasterPlaylist(text, baseUrl) {
    const lines = text.split(/\r?\n/).map((line) => line.trim());
    const audioGroups = new Map();

    for (const line of lines) {
      if (!line.startsWith("#EXT-X-MEDIA:")) continue;
      const attributes = parseAttributeList(line.slice(line.indexOf(":") + 1));
      if (attributes.TYPE === "AUDIO" && attributes["GROUP-ID"] && attributes.URI) {
        const group = audioGroups.get(attributes["GROUP-ID"]) || [];
        group.push({
          url: new URL(attributes.URI, baseUrl).href,
          preferred: attributes.DEFAULT === "YES" ? 2 : attributes.AUTOSELECT === "YES" ? 1 : 0
        });
        audioGroups.set(attributes["GROUP-ID"], group);
      }
    }

    const variants = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
      const attributes = parseAttributeList(line.slice(line.indexOf(":") + 1));
      const uri = lines.slice(index + 1).find((candidate) => candidate && !candidate.startsWith("#"));
      if (!uri) continue;
      const resolution = (attributes.RESOLUTION || "0x0").split("x").map(Number);
      const bandwidth = Number(attributes.BANDWIDTH) || 0;
      const audioRenditions = attributes.AUDIO ? audioGroups.get(attributes.AUDIO) || [] : [];
      const audio = [...audioRenditions].sort((first, second) => second.preferred - first.preferred)[0];
      variants.push({
        url: new URL(uri, baseUrl).href,
        audioUri: audio?.url || null,
        quality: resolution[1] ? `${resolution[1]}p` : null,
        score: (resolution[0] || 0) * (resolution[1] || 0) * 1_000_000 + bandwidth
      });
    }
    return variants;
  }

  function parseHlsMediaPlaylist(text, baseUrl) {
    const lines = text.split(/\r?\n/).map((line) => line.trim());
    const segments = [];
    let encryptionMethod = null;
    let pendingRange = null;
    let pendingDuration = null;
    let previousRangeEnd = 0;
    let init = null;
    let totalDuration = 0;

    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith("#EXT-X-KEY:")) {
        encryptionMethod = parseAttributeList(line.slice(line.indexOf(":") + 1)).METHOD || null;
        continue;
      }
      if (line.startsWith("#EXT-X-MAP:")) {
        const attributes = parseAttributeList(line.slice(line.indexOf(":") + 1));
        if (attributes.URI) {
          init = {
            url: new URL(attributes.URI, baseUrl).href,
            range: parseByteRange(attributes.BYTERANGE, 0)
          };
        }
        continue;
      }
      if (line.startsWith("#EXT-X-BYTERANGE:")) {
        pendingRange = line.slice(line.indexOf(":") + 1);
        continue;
      }
      if (line.startsWith("#EXTINF:")) {
        pendingDuration = Number.parseFloat(line.slice(line.indexOf(":") + 1)) || 0;
        continue;
      }
      if (line.startsWith("#")) continue;

      const range = parseByteRange(pendingRange, previousRangeEnd);
      if (range) previousRangeEnd = range.end + 1;
      segments.push({
        url: new URL(line, baseUrl).href,
        range,
        duration: pendingDuration || 0,
        startTime: totalDuration
      });
      totalDuration += pendingDuration || 0;
      pendingRange = null;
      pendingDuration = null;
    }

    return { segments, init, encryptionMethod, totalDuration };
  }

  function parseAttributeList(value) {
    const attributes = {};
    const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
    let match;
    while ((match = pattern.exec(value))) {
      attributes[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, "");
    }
    return attributes;
  }

  function parseByteRange(value, defaultStart) {
    if (!value) return null;
    const match = String(value).replace(/^"|"$/g, "").match(/^(\d+)(?:@(\d+))?$/);
    if (!match) return null;
    const length = Number(match[1]);
    const start = match[2] ? Number(match[2]) : defaultStart;
    return { start, end: start + length - 1 };
  }

  async function downloadOrdered(
    descriptors,
    output,
    onProgress,
    transform,
    fetcher = (descriptor) => fetchBytes(descriptor.url, descriptor.range)
  ) {
    let completed = 0;

    for (let offset = 0; offset < descriptors.length; offset += DOWNLOAD_CONCURRENCY) {
      const batch = descriptors.slice(offset, offset + DOWNLOAD_CONCURRENCY);
      const buffers = await Promise.all(batch.map((descriptor, index) => fetcher(descriptor, offset + index)));

      for (let index = 0; index < batch.length; index += 1) {
        await output.write(transform(buffers[index], batch[index]));
        completed += 1;
        onProgress({
          phase: "download",
          completed,
          total: descriptors.length,
          percentage: Math.floor((completed / descriptors.length) * 100)
        });
      }
    }
  }

  async function createOutput(filename, saveHandlePromise, diagnostics) {
    let pickerResult = null;
    if (saveHandlePromise) pickerResult = await saveHandlePromise;

    if (pickerResult?.remoteWriter) {
      diagnostics.segmented.outputMode = "arquivo-escolhido-na-pagina-principal";
      return makeRemoteOutputWriter(pickerResult.remoteWriter, diagnostics);
    }

    if (pickerResult?.handle) {
      const writable = await pickerResult.handle.createWritable();
      diagnostics.segmented.outputMode = "arquivo-escolhido";
      return makeOutputWriter(writable, null, null, diagnostics, true);
    }

    if (pickerResult?.error?.name === "AbortError") {
      throw new Error("A escolha do arquivo foi cancelada.");
    }

    if (pickerResult?.error) {
      diagnostics.segmented.savePickerFallback = {
        name: pickerResult.error.name || "Error",
        message: pickerResult.error.message || "Nao foi possivel abrir o seletor de arquivo."
      };
    }

    if (!navigator.storage?.getDirectory) {
      throw new Error("Este Chrome nao oferece armazenamento temporario para videos longos.");
    }

    const root = await navigator.storage.getDirectory();
    await cleanupOldTempFiles(root);
    const tempName = `${TEMP_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}.part`;
    const handle = await root.getFileHandle(tempName, { create: true });
    const writable = await handle.createWritable();
    diagnostics.segmented.outputMode = "disco-temporario-do-chrome";
    return makeOutputWriter(writable, root, { handle, tempName, filename }, diagnostics, false);
  }

  function makeRemoteOutputWriter(remoteWriter, diagnostics) {
    let bytesWritten = 0;
    let closed = false;
    return {
      async write(bytes) {
        await remoteWriter.write(bytes);
        bytesWritten += bytes.byteLength;
      },
      async finish(filename) {
        await remoteWriter.close();
        closed = true;
        diagnostics.segmented.outputBytes = bytesWritten;
        return { savedDirectly: true, filename, bytes: bytesWritten, cleanup: null };
      },
      async abort() {
        if (!closed) await remoteWriter.abort();
      }
    };
  }

  function makeOutputWriter(writable, root, meta, diagnostics, savedDirectly) {
    let bytesWritten = 0;
    let closed = false;

    return {
      async write(bytes) {
        await writable.write(bytes);
        bytesWritten += bytes.byteLength;
      },
      async finish(filename, mimeType) {
        await writable.close();
        closed = true;
        diagnostics.segmented.outputBytes = bytesWritten;
        if (savedDirectly) return { savedDirectly: true, filename, bytes: bytesWritten, cleanup: null };

        const file = await meta.handle.getFile();
        return {
          savedDirectly: false,
          filename,
          bytes: bytesWritten,
          file,
          mimeType,
          cleanup: async () => root.removeEntry(meta.tempName).catch(() => {})
        };
      },
      async abort() {
        if (!closed) await writable.abort().catch(() => {});
        if (root && meta) await root.removeEntry(meta.tempName).catch(() => {});
      }
    };
  }

  async function cleanupOldTempFiles(root) {
    try {
      for await (const [name] of root.entries()) {
        if (!name.startsWith(TEMP_PREFIX)) continue;
        const timestamp = Number(name.slice(TEMP_PREFIX.length).split("-")[0]);
        if (!timestamp || Date.now() - timestamp > 24 * 60 * 60 * 1_000) {
          await root.removeEntry(name).catch(() => {});
        }
      }
    } catch {
      // A limpeza nao deve impedir um novo download.
    }
  }

  async function getTrackInit(track, playlist, playlistUrl, fetcher = fetchBytes) {
    if (track.init_segment) return decodeBase64(track.init_segment);
    if (track.init_segment_url) {
      const rootBase = new URL(playlist.base_url || "./", playlistUrl);
      const trackBase = new URL(track.base_url || "./", rootBase);
      return fetcher(new URL(track.init_segment_url, trackBase).href);
    }
    throw new Error("A playlist DASH nao contem o segmento de inicializacao.");
  }

  async function fetchJson(url) {
    return JSON.parse(await fetchText(url));
  }

  async function fetchText(url) {
    const response = await fetchWithRetry(url);
    return response.text();
  }

  async function fetchHlsText(url) {
    return fetchObservedText(url, 8_000);
  }

  async function fetchObservedText(url, timeoutMilliseconds) {
    let playerError = null;
    try {
      const [bytes] = await requestCapturedMediaBytes([url], null, timeoutMilliseconds);
      return {
        text: new TextDecoder().decode(bytes),
        bytes: bytes.byteLength,
        method: "contexto-do-player"
      };
    } catch (error) {
      playerError = error;
    }

    try {
      const response = await fetchWithRetry(url);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        text: new TextDecoder().decode(bytes),
        bytes: bytes.byteLength,
        method: "contexto-da-extensao"
      };
    } catch (extensionError) {
      throw new Error(
        `Player: ${playerError?.message || "falha desconhecida"}; extensao: ${extensionError?.message || "falha desconhecida"}`
      );
    }
  }

  async function fetchHlsBytes(url, range = null) {
    return fetchObservedBytes(url, range, "HLS");
  }

  async function fetchDashBytes(url) {
    return fetchObservedBytes(url, null, "DASH");
  }

  async function fetchObservedBytes(url, range = null, label = "segmentada") {
    if (!range) {
      try {
        const [bytes] = await requestCapturedMediaBytes([url], null, 20_000);
        return bytes;
      } catch (playerError) {
        try {
          return await fetchBytes(url);
        } catch (extensionError) {
          throw new Error(
            `Parte ${label} indisponivel no player (${playerError?.message || "erro desconhecido"}) e na extensao (${extensionError?.message || "erro desconhecido"}).`
          );
        }
      }
    }
    return fetchBytes(url, range);
  }

  async function fetchBytes(url, range = null) {
    const headers = range ? { Range: `bytes=${range.start}-${range.end}` } : undefined;
    const response = await fetchWithRetry(url, headers);
    return new Uint8Array(await response.arrayBuffer());
  }

  async function fetchWithRetry(url, headers) {
    if (IS_EXTENSION_PAGE) assertSafeBackgroundMediaUrl(url);
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(url, {
          credentials: "include",
          cache: "no-cache",
          headers
        });
        if (response.ok) return response;
        lastError = new Error(`HTTP ${response.status} em ${new URL(url).host}`);
        if (response.status < 500 && response.status !== 429) break;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
    }
    throw lastError || new Error("Falha ao baixar parte do video.");
  }

  function assertSafeBackgroundMediaUrl(value) {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      throw new Error("O processo em segundo plano aceita apenas midia HTTPS.");
    }
    if (/^(?:localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(url.hostname)) {
      throw new Error("O processo em segundo plano recusou um endereco de rede local.");
    }
  }

  function safeHost(value) {
    try {
      return new URL(value).host;
    } catch {
      return "host-desconhecido";
    }
  }

  function getResourceUrls() {
    const observed = !IS_EXTENSION_PAGE && typeof performance?.getEntriesByType === "function"
      ? performance.getEntriesByType("resource").map((entry) => entry.name)
      : [];
    return [...new Set([
      ...observed,
      ...capturedResources.map((entry) => entry.url)
    ])];
  }

  function findInstagramMediaPlan(diagnostics, durationSeconds) {
    const observations = getMediaObservations();
    const tracks = new Map();

    observations.forEach((observation, order) => {
      const parsed = parseInstagramRange(observation.url);
      if (!parsed) return;
      const key = parsed.normalizedUrl;
      const track = tracks.get(key) || {
        normalizedUrl: key,
        host: parsed.host,
        assetId: parsed.assetId,
        type: parsed.type,
        quality: parsed.quality,
        durationSeconds: parsed.durationSeconds,
        bitrate: parsed.bitrate,
        ranges: new Map(),
        lastActivity: 0,
        lastOrder: 0
      };
      const rangeKey = `${parsed.start}-${parsed.end}`;
      track.ranges.set(rangeKey, {
        url: observation.url,
        start: parsed.start,
        end: parsed.end
      });
      track.lastActivity = Math.max(track.lastActivity, observation.capturedAt || 0);
      track.lastOrder = Math.max(track.lastOrder, order);
      tracks.set(key, track);
    });

    const assets = new Map();
    for (const track of tracks.values()) {
      const asset = assets.get(track.assetId) || {
        assetId: track.assetId,
        durationSeconds: track.durationSeconds,
        video: [],
        audio: [],
        lastActivity: 0,
        lastOrder: 0
      };
      asset[track.type].push(finalizeInstagramTrack(track));
      asset.lastActivity = Math.max(asset.lastActivity, track.lastActivity);
      asset.lastOrder = Math.max(asset.lastOrder, track.lastOrder);
      assets.set(track.assetId, asset);
    }

    const eligibleAssets = [...assets.values()]
      .filter((asset) => asset.video.length && asset.audio.length)
      .map((asset) => ({
        ...asset,
        durationDifference: Number.isFinite(durationSeconds)
          ? Math.abs((asset.durationSeconds || 0) - durationSeconds)
          : 0
      }))
      .filter((asset) => asset.durationDifference <= 2.5)
      .sort((first, second) => (
        first.durationDifference - second.durationDifference
        || second.lastActivity - first.lastActivity
        || second.lastOrder - first.lastOrder
      ));

    const selectedAsset = eligibleAssets[0] || null;
    const selectedVideo = selectCompleteInstagramTrack(selectedAsset?.video || []);
    const selectedAudio = selectCompleteInstagramTrack(selectedAsset?.audio || []);

    diagnostics.directMedia = {
      detected: tracks.size > 0,
      platform: "instagram",
      capturedEvents: capturedResources.length,
      trackCandidates: tracks.size,
      assetCandidates: assets.size,
      durationMatchedAssets: eligibleAssets.length,
      requestedDurationSeconds: Number.isFinite(durationSeconds) ? Number(durationSeconds.toFixed(3)) : null,
      selectedDurationSeconds: selectedAsset?.durationSeconds || null,
      selectedVideoQuality: selectedVideo?.quality || null,
      selectedVideoBitrate: selectedVideo?.bitrate || null,
      selectedAudioBitrate: selectedAudio?.bitrate || null,
      videoRanges: selectedVideo?.contiguousRanges.length || 0,
      audioRanges: selectedAudio?.contiguousRanges.length || 0,
      videoCoveredBytes: selectedVideo?.coveredBytes || 0,
      audioCoveredBytes: selectedAudio?.coveredBytes || 0,
      videoCoverageRatio: selectedVideo ? Number(selectedVideo.coverageRatio.toFixed(3)) : null,
      audioCoverageRatio: selectedAudio ? Number(selectedAudio.coverageRatio.toFixed(3)) : null,
      videoStartsAtZero: selectedVideo?.startsAtZero ?? null,
      audioStartsAtZero: selectedAudio?.startsAtZero ?? null,
      videoHasGaps: selectedVideo?.hasGaps ?? null,
      audioHasGaps: selectedAudio?.hasGaps ?? null
    };

    if (!selectedAsset || !selectedVideo || !selectedAudio) return null;
    if (!isTrackCompleteEnough(selectedVideo) || !isTrackCompleteEnough(selectedAudio)) {
      diagnostics.directMedia.incomplete = true;
      return null;
    }

    const shortCode = location.pathname.match(/^\/(?:reels?|p)\/([^/]+)/i)?.[1];
    return {
      url: `blob:instagram-dash-${shortCode || Date.now()}`,
      filename: shortCode ? `instagram-${shortCode}.mp4` : `instagram-${Date.now()}.mp4`,
      segmented: true,
      instagramPlan: {
        durationSeconds: selectedAsset.durationSeconds || durationSeconds || 0,
        video: selectedVideo,
        audio: selectedAudio
      }
    };
  }

  function findInstagramProgressiveSource(diagnostics) {
    const shortCode = location.pathname.match(/^\/(?:reels?|p)\/([^/]+)/i)?.[1] || null;
    const jsonScripts = document.querySelectorAll?.('script[type="application/json"]') || [];
    let matchedObject = shortCode ? capturedInstagramMedia.get(shortCode) || null : null;
    let sourceMethod = matchedObject ? "rede-do-popup" : "json-progressivo";
    let parsedScripts = 0;

    if (shortCode && !matchedObject) {
      for (const script of jsonScripts) {
        const text = script.textContent || "";
        if (!text.includes(shortCode) || !text.includes("video_versions")) continue;
        try {
          parsedScripts += 1;
          matchedObject = findInstagramMediaObject(JSON.parse(text), shortCode);
          if (matchedObject) {
            sourceMethod = "json-progressivo";
            break;
          }
        } catch {
          // Outros blocos JSON da pagina podem nao conter dados de midia validos.
        }
      }
    }

    const candidates = (matchedObject?.video_versions || [])
      .map((version, index) => {
        try {
          const url = new URL(version?.url);
          if (!isInstagramDirectUrl(url)) return null;
          return {
            url: url.href,
            width: Number(version.width) || 0,
            height: Number(version.height) || 0,
            type: Number(version.type) || null,
            index
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((first, second) => (
        second.width * second.height - first.width * first.height
        || first.index - second.index
      ));

    const selected = candidates[0] || null;
    diagnostics.directMedia = {
      detected: Boolean(selected),
      platform: "instagram",
      method: sourceMethod,
      popupMediaCandidates: capturedInstagramMedia.size,
      shortCodeMatched: Boolean(matchedObject),
      jsonScripts: jsonScripts.length,
      parsedScripts,
      progressiveCount: candidates.length,
      selectedWidth: selected?.width || null,
      selectedHeight: selected?.height || null,
      selectedType: selected?.type || null,
      outputMode: selected ? "chrome-downloads-direto" : null
    };

    if (!selected) return null;
    return {
      url: selected.url,
      filename: `instagram-${shortCode}.mp4`
    };
  }

  function findInstagramMediaObject(root, shortCode) {
    const stack = [root];
    let inspected = 0;
    while (stack.length && inspected < 100_000) {
      const value = stack.pop();
      inspected += 1;
      if (!value || typeof value !== "object") continue;
      if ((value.code === shortCode || value.shortcode === shortCode)
        && Array.isArray(value.video_versions)) {
        return value;
      }
      for (const child of Object.values(value)) {
        if (child && typeof child === "object") stack.push(child);
      }
    }
    return null;
  }

  function isInstagramDirectUrl(value) {
    try {
      const url = value instanceof URL ? value : new URL(value);
      return url.protocol === "https:"
        && /(?:^|\.)(?:fbcdn\.net|cdninstagram\.com)$/i.test(url.hostname)
        && /\.mp4$/i.test(url.pathname);
    } catch {
      return false;
    }
  }

  function getMediaObservations() {
    const performanceEntries = performance.getEntriesByType("resource").map((entry) => ({
      url: entry.name,
      capturedAt: performance.timeOrigin + Math.max(entry.responseEnd || 0, entry.startTime || 0)
    }));
    return [...performanceEntries, ...capturedResources];
  }

  function parseInstagramRange(value) {
    try {
      const url = new URL(value);
      if (!isInstagramRangeUrl(url.href)) return null;
      const start = Number(url.searchParams.get("bytestart"));
      const end = Number(url.searchParams.get("byteend"));
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return null;

      const metadata = JSON.parse(atob(url.searchParams.get("efg") || ""));
      const tag = String(metadata.vencode_tag || "");
      const type = tag.includes("audio") ? "audio" : "video";
      const normalized = new URL(url.href);
      normalized.searchParams.delete("bytestart");
      normalized.searchParams.delete("byteend");
      return {
        normalizedUrl: normalized.href,
        host: url.host,
        assetId: String(metadata.xpv_asset_id || `${url.host}${url.pathname}`),
        type,
        quality: Number(tag.match(/_q(\d+)/)?.[1]) || null,
        durationSeconds: Number(metadata.duration_s) || null,
        bitrate: Number(metadata.bitrate) || null,
        start,
        end
      };
    } catch {
      return null;
    }
  }

  function finalizeInstagramTrack(track) {
    const ranges = [...track.ranges.values()]
      .sort((first, second) => first.start - second.start || second.end - first.end);
    const contiguousRanges = [];
    let cursor = 0;
    while (true) {
      const candidates = ranges.filter((range) => range.start <= cursor && range.end >= cursor);
      if (!candidates.length) break;
      const selected = candidates.sort((first, second) => second.end - first.end)[0];
      contiguousRanges.push(selected);
      cursor = selected.end + 1;
    }

    const coveredBytes = cursor;
    const expectedBytes = track.bitrate && track.durationSeconds
      ? track.bitrate * track.durationSeconds / 8
      : coveredBytes;
    return {
      ...track,
      ranges: undefined,
      contiguousRanges,
      coveredBytes,
      expectedBytes,
      coverageRatio: expectedBytes ? coveredBytes / expectedBytes : 0,
      startsAtZero: Boolean(contiguousRanges.length && contiguousRanges[0].start === 0),
      hasGaps: ranges.some((range) => range.start > cursor)
    };
  }

  function selectCompleteInstagramTrack(tracks) {
    return [...tracks].sort((first, second) => {
      const firstComplete = isTrackCompleteEnough(first) ? 1 : 0;
      const secondComplete = isTrackCompleteEnough(second) ? 1 : 0;
      return secondComplete - firstComplete
        || (second.bitrate || 0) - (first.bitrate || 0)
        || second.coveredBytes - first.coveredBytes;
    })[0] || null;
  }

  function isTrackCompleteEnough(track) {
    return track.startsAtZero && !track.hasGaps && track.coverageRatio >= 0.72;
  }

  function isInstagramRangeUrl(value) {
    try {
      const url = new URL(value);
      return /(?:^|\.)(?:fbcdn\.net|cdninstagram\.com)$/i.test(url.hostname)
        && /\.mp4$/i.test(url.pathname)
        && url.searchParams.has("bytestart")
        && url.searchParams.has("byteend")
        && url.searchParams.has("efg");
    } catch {
      return false;
    }
  }

  function countHlsSegments(text) {
    return text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("#")).length;
  }

  function inferQualityFromUrl(url) {
    const match = url.match(/(?:^|[^0-9])(2160|1440|1080|720|540|480|360|240)p?(?:[^0-9]|$)/i);
    return match ? `${match[1]}p` : null;
  }

  function decodeBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function containsAscii(bytes, value) {
    const needle = [...value].map((character) => character.charCodeAt(0));
    outer: for (let index = 0; index <= bytes.length - needle.length; index += 1) {
      for (let inner = 0; inner < needle.length; inner += 1) {
        if (bytes[index + inner] !== needle[inner]) continue outer;
      }
      return true;
    }
    return false;
  }

  function mergeInitSegments(videoInit, audioInit, durationSeconds) {
    const videoTop = readBoxes(videoInit);
    const audioTop = readBoxes(audioInit);
    const videoMoov = requireBox(videoTop, "moov");
    const audioMoov = requireBox(audioTop, "moov");
    const audioChildren = readBoxes(audioInit, audioMoov.start + audioMoov.headerSize, audioMoov.end);
    const audioTrak = cloneBox(audioInit, requireBox(audioChildren, "trak"));
    const audioMvex = requireBox(audioChildren, "mvex");
    const audioTrex = cloneBox(audioInit, requireBox(readBoxes(audioInit, audioMvex.start + audioMvex.headerSize, audioMvex.end), "trex"));
    patchTrackHeader(audioTrak, 2);
    writeUint32(audioTrex, 12, 2);

    const newChildren = [];
    let audioInserted = false;
    let trexInserted = false;
    for (const child of readBoxes(videoInit, videoMoov.start + videoMoov.headerSize, videoMoov.end)) {
      if (child.type === "mvex") {
        if (!audioInserted) {
          newChildren.push(audioTrak);
          audioInserted = true;
        }
        newChildren.push(appendChildBox(cloneBox(videoInit, child), audioTrex));
        trexInserted = true;
      } else {
        newChildren.push(cloneBox(videoInit, child));
      }
    }
    if (!audioInserted) newChildren.push(audioTrak);
    if (!trexInserted) throw new Error("Cabecalho DASH sem mvex.");

    const newMoov = makeContainerBox("moov", newChildren);
    patchMovieDurations(newMoov, durationSeconds);
    return concatBytes(videoTop.map((box) => box.type === "moov" ? newMoov : cloneBox(videoInit, box)));
  }

  function patchMovieDurations(moov, durationSeconds) {
    const children = readBoxes(moov, 8, moov.length);
    const mvhd = requireBox(children, "mvhd");
    const movieTimescale = readFullBoxTimescale(moov, mvhd);
    writeFullBoxDuration(moov, mvhd, Math.round(durationSeconds * movieTimescale));
    for (const trak of children.filter((box) => box.type === "trak")) {
      const trakChildren = readBoxes(moov, trak.start + trak.headerSize, trak.end);
      writeFullBoxDuration(moov, requireBox(trakChildren, "tkhd"), Math.round(durationSeconds * movieTimescale));
      const mdia = requireBox(trakChildren, "mdia");
      const mdhd = requireBox(readBoxes(moov, mdia.start + mdia.headerSize, mdia.end), "mdhd");
      writeFullBoxDuration(moov, mdhd, Math.round(durationSeconds * readFullBoxTimescale(moov, mdhd)));
    }
    const mvex = children.find((box) => box.type === "mvex");
    const mehd = mvex && readBoxes(moov, mvex.start + mvex.headerSize, mvex.end).find((box) => box.type === "mehd");
    if (mehd) writeFullBoxDuration(moov, mehd, Math.round(durationSeconds * movieTimescale));
  }

  function patchTrackHeader(trak, trackId) {
    const tkhd = requireBox(readBoxes(trak, 8, trak.length), "tkhd");
    const version = trak[tkhd.start + 8];
    writeUint32(trak, tkhd.start + (version === 1 ? 28 : 20), trackId);
  }

  function patchFragment(input, trackId, sequence) {
    const data = new Uint8Array(input);
    for (const box of readBoxes(data)) {
      if (box.type === "sidx" || box.type === "prft") writeUint32(data, box.start + 12, trackId);
      if (box.type !== "moof") continue;
      for (const child of readBoxes(data, box.start + box.headerSize, box.end)) {
        if (child.type === "mfhd") writeUint32(data, child.start + 12, sequence);
        if (child.type !== "traf") continue;
        for (const trafChild of readBoxes(data, child.start + child.headerSize, child.end)) {
          if (trafChild.type === "tfhd") writeUint32(data, trafChild.start + 12, trackId);
        }
      }
    }
    return data;
  }

  function readFullBoxTimescale(data, box) {
    return readUint32(data, box.start + (data[box.start + 8] === 1 ? 28 : 20));
  }

  function writeFullBoxDuration(data, box, value) {
    const version = data[box.start + 8];
    const offset = box.start + (box.type === "tkhd" ? (version === 1 ? 36 : 28) : box.type === "mehd" ? 12 : (version === 1 ? 32 : 24));
    if (version === 1) new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(offset, BigInt(value));
    else writeUint32(data, offset, value);
  }

  function appendChildBox(container, child) {
    const output = concatBytes([container, child]);
    writeUint32(output, 0, output.length);
    return output;
  }

  function makeContainerBox(type, children) {
    const body = concatBytes(children);
    const output = new Uint8Array(8 + body.length);
    writeUint32(output, 0, output.length);
    writeType(output, 4, type);
    output.set(body, 8);
    return output;
  }

  function readBoxes(data, start = 0, end = data.length) {
    const boxes = [];
    let offset = start;
    while (offset + 8 <= end) {
      let size = readUint32(data, offset);
      const type = readType(data, offset + 4);
      let headerSize = 8;
      if (size === 1) {
        size = readUint32(data, offset + 8) * 2 ** 32 + readUint32(data, offset + 12);
        headerSize = 16;
      } else if (size === 0) size = end - offset;
      if (size < headerSize || offset + size > end) throw new Error(`Box MP4 invalido: ${type}`);
      boxes.push({ type, start: offset, size, headerSize, end: offset + size });
      offset += size;
    }
    return boxes;
  }

  function requireBox(boxes, type) {
    const box = boxes.find((candidate) => candidate.type === type);
    if (!box) throw new Error(`Box ${type} nao encontrado.`);
    return box;
  }

  function cloneBox(data, box) {
    return data.slice(box.start, box.end);
  }

  function concatBytes(parts) {
    const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }

  function readUint32(data, offset) {
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset);
  }

  function writeUint32(data, offset, value) {
    new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(offset, value);
  }

  function readType(data, offset) {
    return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
  }

  function writeType(data, offset, type) {
    for (let index = 0; index < 4; index += 1) data[offset + index] = type.charCodeAt(index);
  }

  window.CTXSegmentedDownloader = Object.freeze({
    hasSegmentedSources,
    hasBackgroundCompatibleSources,
    canRunInBackground,
    getSegmentedResourceSnapshot,
    replaceCapturedResources,
    shouldDownloadSegmented,
    prepareSaveHandle,
    prepareBackgroundSaveHandle,
    getSaveSuggestion,
    downloadSegmented,
    parseHlsMasterPlaylist,
    parseHlsMediaPlaylist,
    findInstagramProgressiveSource,
    findInstagramMediaPlan
  });
})();
