/* ============================================================
   Main Display Logic — polls local server, updates all fields,
   camera + ad video alternating playback
   ============================================================ */

(function () {
  'use strict';

  // --- DOM refs ---
  const els = {
    name:          document.getElementById('name'),
    totalSpaces:   document.getElementById('total-spaces'),
    availTotal:    document.getElementById('avail-total'),
    statusDot:     document.getElementById('status-dot'),
    videoArea:     document.getElementById('video-area'),
    placeholder:   document.getElementById('placeholder-video'),
  };

  // --- State ---
  let config;
  let pollTimerId = null;
  let consecutiveFailures = 0;
  let lastData = { total: null, availTotal: null };
  const MAX_FAILURES = 3;

  // Video cycle state
  var videoState = 'camera';       // 'camera' | 'ad'
  var cameraTimerId = null;
  var adFileList = [];             // filenames from /api/video-list
  var currentAdIndex = 0;
  var currentVideoEl = null;       // single <video> element
  var currentPlayer = null;        // hls.js / flv.js / RTCPeerConnection
  var videoPanel = null;           // container div
  var currentCameraUrl = '';       // track camera source to avoid unnecessary rebuild

  // --- Init ---
  function init() {
    config = getConfig();
    applyConfig();
    fetchStatus();                    // immediate first fetch
    startPolling();
  }

  // --- Apply config to DOM ---
  function applyConfig() {
    setupVideoSystem(config);
    var rawName = config.parkingName || 'xxxx景区游客中心停车场';
    els.name.innerHTML = rawName.replace(/\n/g, '<br>');
  }

  // ====================================================================
  //  Video System — camera + ad video alternating state machine
  // ====================================================================

  function setupVideoSystem(cfg) {
    var area = els.videoArea;
    var placeholder = els.placeholder;
    if (!area) return;

    // Get camera source (first valid stream in videoStreams)
    var streams = cfg.videoStreams || [];
    var cameraSource = null;
    for (var i = 0; i < streams.length; i++) {
      if (streams[i] && streams[i].url && streams[i].url.trim()) {
        cameraSource = streams[i];
        break;
      }
    }

    if (!cameraSource) {
      // No camera — full teardown
      cleanupVideoSystem();
      if (videoPanel) { videoPanel.remove(); videoPanel = null; currentVideoEl = null; }
      currentCameraUrl = '';
      if (placeholder) placeholder.style.display = 'flex';
      return;
    }

    if (placeholder) placeholder.style.display = 'none';

    var cameraChanged = (currentCameraUrl !== cameraSource.url);

    // Soft cleanup: stop timer, reset ad state (keep DOM; keep player if camera unchanged)
    cleanupVideoSystem(!cameraChanged);

    // Create panel + video element only if it doesn't exist yet
    if (!videoPanel || !videoPanel.parentNode) {
      videoPanel = document.createElement('div');
      videoPanel.className = 'video-panel';
      videoPanel.id = 'video-panel-main';

      currentVideoEl = document.createElement('video');
      currentVideoEl.autoplay = true;
      currentVideoEl.muted = true;
      currentVideoEl.playsInline = true;
      currentVideoEl.loop = true;
      videoPanel.appendChild(currentVideoEl);
      area.appendChild(videoPanel);

      cameraChanged = true; // new element, must set up player
    }

    // Only rebuild player when camera source actually changed (or first load)
    if (cameraChanged) {
      currentCameraUrl = cameraSource.url;
      playCameraStream(cameraSource);
    }

    // Fetch ad video list and (re)start cycle
    // Empty folder = disable ad rotation, camera only
    var folder = cfg.videoFolder || '';
    if (folder) {
      fetchAdFileList(folder);
    } else {
      adFileList = [];
      console.log('Video folder not configured, camera-only mode');
    }
  }

  // --- Fetch video file list from server ---
  function fetchAdFileList(folder) {
    var url = '/api/video-list?folder=' + encodeURIComponent(folder);
    fetch(url).then(function (resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    }).then(function (files) {
      adFileList = files || [];
      if (adFileList.length > 0) {
        console.log('Ad videos found: ' + adFileList.length + ' files');
        startCameraTimer();
      } else {
        console.log('No ad videos in folder, showing camera only');
      }
    }).catch(function (err) {
      console.error('Failed to fetch ad video list:', err);
      adFileList = [];
    });
  }

  // --- Play camera stream on the shared <video> element ---
  function playCameraStream(stream) {
    if (!currentVideoEl) return;

    // Destroy any existing player (hls/flv/webrtc)
    destroyPlayer();

    var isLocal = stream.type === 'local';
    var isHls = stream.type === 'hls' || (stream.url && stream.url.indexOf('.m3u8') !== -1);
    var isFlv = stream.type === 'flv';
    var isWebrtc = stream.type === 'webrtc';

    currentVideoEl.loop = true;
    currentVideoEl.src = '';
    currentVideoEl.srcObject = null;
    currentVideoEl.onended = null;
    currentVideoEl.onerror = null;

    if (isWebrtc) {
      setupWebrtcOnVideo(currentVideoEl, stream.url);
    } else if (isLocal) {
      currentVideoEl.src = stream.url;
    } else if (isFlv) {
      try {
        var player = flvjs.createPlayer({
          type: 'flv',
          url: stream.url,
          isLive: true,
        });
        player.attachMediaElement(currentVideoEl);
        player.load();
        player.play();
        currentPlayer = player;
      } catch (e) {
        console.error('flv.js player init failed:', e);
      }
    } else if (isHls) {
      if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        var hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
        });
        hls.loadSource(stream.url);
        hls.attachMedia(currentVideoEl);
        hls.on(Hls.Events.ERROR, function (event, data) {
          if (data.fatal) {
            console.error('HLS error, recovering...', data);
            hls.recoverMediaError();
          }
        });
        currentPlayer = hls;
      } else {
        currentVideoEl.src = stream.url;
      }
    } else {
      // iframe — replace video with iframe inside panel
      if (videoPanel) {
        videoPanel.innerHTML = '';
        var iframe = document.createElement('iframe');
        iframe.src = stream.url;
        iframe.allow = 'autoplay';
        iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
        videoPanel.appendChild(iframe);
        currentVideoEl = null;
      }
    }

    videoState = 'camera';
  }

  // --- WebRTC player on existing <video> ---
  function setupWebrtcOnVideo(video, url) {
    var pc = null;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
    } catch (e) {
      console.error('WebRTC not supported:', e);
      return;
    }

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    var hasVideo = false;
    pc.ontrack = function (event) {
      if (event.track.kind === 'video' && !hasVideo) {
        hasVideo = true;
        video.srcObject = event.streams[0];
      }
    };

    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        console.error('WebRTC connection', pc.connectionState);
      }
    };

    pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer);
    }).then(function () {
      return fetch(url + '/whep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: pc.localDescription.sdp,
      });
    }).then(function (response) {
      if (!response.ok) throw new Error('WHEP returned ' + response.status);
      return response.text();
    }).then(function (answerSdp) {
      return pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    }).catch(function (err) {
      console.error('WebRTC/WHEP failed:', err);
    });

    currentPlayer = pc;
  }

  // --- Camera timer (switches to ad video after cameraDuration) ---
  function startCameraTimer() {
    stopCameraTimer();
    var duration = (config.cameraDuration || 300);
    console.log('Camera timer: ' + duration + 's until next ad video');
    cameraTimerId = setTimeout(function () {
      switchToAdVideo();
    }, duration * 1000);
  }

  function stopCameraTimer() {
    if (cameraTimerId !== null) {
      clearTimeout(cameraTimerId);
      cameraTimerId = null;
    }
  }

  // --- Switch to ad video ---
  function switchToAdVideo() {
    if (adFileList.length === 0) {
      // No ad videos — stay in camera mode
      return;
    }

    if (!currentVideoEl) {
      // iframe mode — need to rebuild video element
      rebuildVideoElement();
      if (!currentVideoEl) return;
    }

    var filename = adFileList[currentAdIndex];
    var folder = config.videoFolder ? config.videoFolder + '/' : '';
    var videoUrl = '/videos/' + folder + filename;

    // Destroy camera player before switching
    destroyPlayer();

    // Fully reset video element so hls.js/flv.js doesn't interfere
    currentVideoEl.removeAttribute('src');
    currentVideoEl.srcObject = null;
    currentVideoEl.load();

    // Set up local video playback
    currentVideoEl.loop = false;
    currentVideoEl.src = videoUrl;
    currentVideoEl.onended = onAdVideoEnded;
    currentVideoEl.onerror = onAdVideoError;

    // Explicit play() — autoplay alone may not trigger on src change
    currentVideoEl.play().catch(function (err) {
      console.error('Ad video play() rejected:', err.message);
    });

    videoState = 'ad';
    console.log('Playing ad video (' + (currentAdIndex + 1) + '/' + adFileList.length + '): ' + filename);
  }

  function onAdVideoEnded() {
    console.log('Ad video ended, switching back to camera');
    currentAdIndex = (currentAdIndex + 1) % adFileList.length;
    switchToCamera();
  }

  function onAdVideoError(e) {
    var el = currentVideoEl;
    var code = el && el.error ? el.error.code : 'unknown';
    var msg = el && el.error ? el.error.message : 'unknown';
    console.error('Ad video error (code=' + code + '): ' + msg + ' — src=' + (el ? el.src : ''));
    currentAdIndex = (currentAdIndex + 1) % adFileList.length;
    switchToCamera();
  }

  // --- Switch back to camera ---
  function switchToCamera() {
    if (!currentVideoEl) {
      rebuildVideoElement();
      if (!currentVideoEl) return;
    }

    // Clean up ad video state
    currentVideoEl.onended = null;
    currentVideoEl.onerror = null;
    currentVideoEl.loop = true;
    currentVideoEl.src = '';

    // Rebuild camera stream from config
    var streams = config.videoStreams || [];
    var cameraSource = null;
    for (var i = 0; i < streams.length; i++) {
      if (streams[i] && streams[i].url && streams[i].url.trim()) {
        cameraSource = streams[i];
        break;
      }
    }

    if (cameraSource) {
      playCameraStream(cameraSource);
    }

    videoState = 'camera';
    startCameraTimer();
  }

  // --- Rebuild <video> element (if iframe replaced it) ---
  function rebuildVideoElement() {
    if (!videoPanel) return;
    videoPanel.innerHTML = '';
    currentVideoEl = document.createElement('video');
    currentVideoEl.autoplay = true;
    currentVideoEl.muted = true;
    currentVideoEl.playsInline = true;
    currentVideoEl.loop = true;
    videoPanel.appendChild(currentVideoEl);
  }

  // --- Destroy current streaming player ---
  function destroyPlayer() {
    if (currentPlayer) {
      // flv.js
      if (currentPlayer.destroy) {
        try { currentPlayer.destroy(); } catch (e) { /* ignore */ }
      }
      // WebRTC
      if (currentPlayer.close && !currentPlayer.destroy) {
        try { currentPlayer.close(); } catch (e) { /* ignore */ }
      }
      currentPlayer = null;
    }
    if (currentVideoEl) {
      currentVideoEl.src = '';
      currentVideoEl.srcObject = null;
    }
  }

  // --- Soft cleanup — stop timers, optionally keep player, keep DOM intact ---
  function cleanupVideoSystem(keepPlayer) {
    stopCameraTimer();
    if (!keepPlayer) {
      destroyPlayer();
    }
    adFileList = [];
    currentAdIndex = 0;
    videoState = 'camera';
    // NOTE: do NOT remove videoPanel from DOM — it avoids black flash on hot reload
    //        do NOT null currentVideoEl / videoPanel — setupVideoSystem will reuse them
  }

  // ====================================================================
  //  Data Polling (local server: GET /api/parking/status)
  // ====================================================================

  function startPolling() {
    stopPolling();
    var interval = Math.max(1, config.pollInterval || 2) * 1000;
    pollTimerId = setInterval(fetchStatus, interval);
    console.log('Data polling every ' + (config.pollInterval || 2) + 's');
  }

  function stopPolling() {
    if (pollTimerId) {
      clearInterval(pollTimerId);
      pollTimerId = null;
    }
  }

  async function fetchStatus() {
    try {
      var resp = await fetch('/api/parking/status');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();

      var a = data.a;  // parking lot (停车场)
      var b = data.b;  // parking building (停车楼)

      // Compute combined values
      var totalA = (a && typeof a.total === 'number') ? a.total : 0;
      var totalB = (b && typeof b.total === 'number') ? b.total : 0;
      var availA = (a && typeof a.available === 'number') ? a.available : 0;
      var availB = (b && typeof b.available === 'number') ? b.available : 0;

      var combined = {
        total: totalA + totalB,
        availTotal: availA + availB,
      };

      // Only count as valid if at least one lot has reported
      var hasAnyData = (a !== null && a !== undefined) || (b !== null && b !== undefined);

      if (hasAnyData) {
        lastData = combined;
        consecutiveFailures = 0;
        updateCardUI(combined);
        setStatus(true);
      }

    } catch (e) {
      console.error('Status poll failed:', e);
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_FAILURES) {
        lastData = { total: null, availTotal: null };
        els.totalSpaces.textContent = '--';
        els.availTotal.textContent = '--';
      }
      setStatus(false);
    }
  }

  // --- UI Updates ---
  function updateCardUI(data) {
    // Total spaces (red)
    if (data.total !== null && data.total !== undefined) {
      updateValue(els.totalSpaces, data.total);
    }

    // Total available (green)
    if (data.availTotal !== null && data.availTotal !== undefined) {
      updateValue(els.availTotal, data.availTotal);
    }
  }

  function updateValue(el, newVal) {
    var oldVal = parseInt(el.textContent, 10);
    if (!isNaN(oldVal) && oldVal !== newVal) {
      animateNumber(el, newVal);
    } else {
      el.textContent = newVal;
    }
  }

  function animateNumber(el, newVal) {
    el.classList.add('updating');
    el.textContent = newVal;
    setTimeout(function () { el.classList.remove('updating'); }, 600);
  }

  function setStatus(ok) {
    if (ok) {
      els.statusDot.classList.remove('error');
    } else {
      els.statusDot.classList.add('error');
    }
  }

  // --- Helpers ---

  // Reload config on storage change (from admin page in another tab)
  window.addEventListener('storage', function (e) {
    if (e.key === 'parking_display_config') {
      console.log('Config changed, reloading...');
      config = getConfig();
      applyConfig();
      startPolling();               // restart poll timer with new interval
      fetchStatus();                // immediate refresh
    }
  });

  // --- Boot ---
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
