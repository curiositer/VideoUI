/* ============================================================
   Main Display Logic — polls local server, updates all fields,
   manages multiple video streams with rotation
   ============================================================ */

(function () {
  'use strict';

  // --- DOM refs ---
  const els = {
    name:          document.getElementById('name'),
    totalSpaces:   document.getElementById('total-spaces'),
    availLot:      document.getElementById('avail-lot'),
    availBuilding: document.getElementById('avail-building'),
    statusDot:     document.getElementById('status-dot'),
    videoArea:     document.getElementById('video-area'),
    placeholder:   document.getElementById('placeholder-video'),
  };

  // --- State ---
  let config;
  let pollTimerId = null;
  let videoSwitchTimerId = null;
  let currentVideoIndex = 0;
  let consecutiveFailures = 0;
  let lastData = { total: null, availLot: null, availBuilding: null };
  const MAX_FAILURES = 3;

  // --- Init ---
  function init() {
    config = getConfig();
    applyConfig();
    fetchStatus();                    // immediate first fetch
    startPolling();
  }

  // --- Apply config to DOM ---
  function applyConfig() {
    setupVideos(config.videoStreams || [], config.videoSwitchInterval || 10);
    els.name.textContent = config.parkingName || '景区游客中心停车场';
  }

  // ====================================================================
  //  Video Streams — dynamic panels, floating labels, rotation
  // ====================================================================

  function setupVideos(streams, switchInterval) {
    var area = els.videoArea;
    var placeholder = els.placeholder;
    if (!area) return;

    // Remove existing panels (keep placeholder)
    var existing = area.querySelectorAll('.video-panel');
    for (var i = 0; i < existing.length; i++) {
      existing[i].remove();
    }

    // Stop any running rotation
    stopVideoSwitch();
    currentVideoIndex = 0;

    // Filter out streams with no URL configured
    var validStreams = (streams || []).filter(function (s) { return s && s.url && s.url.trim(); });

    if (validStreams.length === 0) {
      if (placeholder) placeholder.style.display = 'flex';
      return;
    }

    if (placeholder) placeholder.style.display = 'none';

    // Create a panel for each valid stream
    for (var idx = 0; idx < validStreams.length; idx++) {
      var stream = validStreams[idx];
      var panel = document.createElement('div');
      panel.className = 'video-panel';
      panel.id = 'video-panel-' + idx;
      if (idx === 0) panel.classList.add('active');

      // Embed video / iframe
      var isHls = stream.type === 'hls' || (stream.url && stream.url.indexOf('.m3u8') !== -1);
      if (isHls) {
        var video = document.createElement('video');
        video.autoplay = true;
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.src = stream.url;
        panel.appendChild(video);
      } else {
        var iframe = document.createElement('iframe');
        iframe.src = stream.url;
        iframe.allow = 'autoplay';
        iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
        panel.appendChild(iframe);
      }

      // Floating label (top-left overlay)
      var label = document.createElement('div');
      label.className = 'video-label';
      label.textContent = stream.label || ('监控画面 ' + (idx + 1));
      panel.appendChild(label);

      area.appendChild(panel);
    }

    // Start rotation only when there are 2+ streams
    if (validStreams.length > 1 && switchInterval > 0) {
      startVideoSwitch(switchInterval);
    }
  }

  function startVideoSwitch(intervalSec) {
    stopVideoSwitch();
    videoSwitchTimerId = setInterval(switchToNextVideo, intervalSec * 1000);
    console.log('Video rotation started: every ' + intervalSec + 's');
  }

  function stopVideoSwitch() {
    if (videoSwitchTimerId) {
      clearInterval(videoSwitchTimerId);
      videoSwitchTimerId = null;
    }
  }

  function switchToNextVideo() {
    var panels = document.querySelectorAll('#video-area .video-panel');
    if (panels.length <= 1) return;

    // Hide current
    if (panels[currentVideoIndex]) {
      panels[currentVideoIndex].classList.remove('active');
    }

    // Advance to next (wrap around)
    currentVideoIndex = (currentVideoIndex + 1) % panels.length;

    // Show next
    if (panels[currentVideoIndex]) {
      panels[currentVideoIndex].classList.add('active');
    }
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
      var availA = (a && typeof a.available === 'number') ? a.available : null;
      var availB = (b && typeof b.available === 'number') ? b.available : null;

      var combined = {
        total: totalA + totalB,
        availLot: availA,
        availBuilding: availB,
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
        lastData = { total: null, availLot: null, availBuilding: null };
        els.totalSpaces.textContent = '--';
        els.availLot.textContent = '--';
        els.availBuilding.textContent = '--';
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

    // Parking lot available (green)
    if (data.availLot !== null && data.availLot !== undefined) {
      updateValue(els.availLot, data.availLot);
    }

    // Parking building available (green)
    if (data.availBuilding !== null && data.availBuilding !== undefined) {
      updateValue(els.availBuilding, data.availBuilding);
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
