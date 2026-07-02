/* ============================================================
   Main Display Logic — polls local server, rotation timer, UI updates
   ============================================================ */

(function () {
  'use strict';

  // --- DOM refs ---
  const els = {
    name:       document.getElementById('name-current'),
    available:  document.getElementById('available-current'),
    total:      document.getElementById('total-current'),
    statusDot:  document.getElementById('status-dot-current'),
    videoA:     document.getElementById('video-a'),
    videoB:     document.getElementById('video-b'),
  };

  // --- State ---
  let config;
  let currentLot = 'A';               // 'A' or 'B'
  let pollTimerId = null;
  let rotationTimerId = null;
  let consecutiveFailures = { A: 0, B: 0 };
  let lastData = { A: null, B: null };
  const MAX_FAILURES = 3;

  // --- Init ---
  function init() {
    config = getConfig();
    applyConfig();
    switchToLot('A');                 // initial display
    startPolling();                   // fetch data from local server
    startRotation();                  // A/B switching
  }

  // --- Apply config to DOM ---
  function applyConfig() {
    setupVideo('a', config.videoUrlA);
    setupVideo('b', config.videoUrlB);
  }

  function setupVideo(slot, url) {
    const container = document.getElementById('video-' + slot);
    const placeholder = document.getElementById('placeholder-' + slot);
    if (!container) return;

    // Clear previous content except placeholder
    const children = container.querySelectorAll(':not(.video-placeholder)');
    children.forEach(c => c.remove());

    if (!url) {
      placeholder.style.display = 'flex';
      return;
    }

    placeholder.style.display = 'none';

    if (config.videoType === 'hls' || url.endsWith('.m3u8')) {
      const video = document.createElement('video');
      video.autoplay = true;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.src = url;
      container.appendChild(video);
    } else {
      const iframe = document.createElement('iframe');
      iframe.src = url;
      iframe.allow = 'autoplay';
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      container.appendChild(iframe);
    }
  }

  // --- Data Polling (local server: GET /api/parking/status) ---
  function startPolling() {
    stopPolling();
    const interval = Math.max(1, config.pollInterval || 2) * 1000;
    pollTimerId = setInterval(fetchStatus, interval);
    console.log(`Data polling every ${config.pollInterval || 2}s`);
  }

  function stopPolling() {
    if (pollTimerId) {
      clearInterval(pollTimerId);
      pollTimerId = null;
    }
  }

  async function fetchStatus() {
    try {
      const resp = await fetch('/api/parking/status');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      // Cache data for both lots
      let anyUpdated = false;
      ['A', 'B'].forEach(lot => {
        const key = lot.toLowerCase();  // 'a' or 'b'
        const entry = data[key];
        if (entry && typeof entry.total === 'number' && typeof entry.available === 'number') {
          lastData[lot] = entry;
          consecutiveFailures[lot] = 0;
          anyUpdated = true;
        } else if (entry === null) {
          // Server returned null = no data received yet for this lot
          // Don't count as failure; just leave as-is
        }
      });

      // Update UI for currently active lot if we have data
      const active = lastData[currentLot];
      if (active && typeof active.total === 'number') {
        updateCardUI(active);
        setStatus(true);
      } else if (lastData[currentLot] === null && consecutiveFailures[currentLot] === 0) {
        // No data ever received — show placeholder
        els.available.textContent = '--';
        els.total.textContent = '--';
        setStatus(true);  // not an error, just no data yet
      }

      // If data came back after failures, reset status
      if (consecutiveFailures[currentLot] >= MAX_FAILURES && active) {
        consecutiveFailures[currentLot] = 0;
        updateCardUI(active);
        setStatus(true);
      }

    } catch (e) {
      console.error('Status poll failed:', e);
      ['A', 'B'].forEach(lot => {
        consecutiveFailures[lot]++;
        if (consecutiveFailures[lot] >= MAX_FAILURES) {
          lastData[lot] = null;
        }
      });
      if (consecutiveFailures[currentLot] >= MAX_FAILURES) {
        els.available.textContent = '--';
        els.total.textContent = '--';
      }
      setStatus(consecutiveFailures[currentLot] < MAX_FAILURES);
    }
  }

  // --- Rotation ---
  function switchToLot(lot) {
    currentLot = lot;

    // Toggle video panel visibility
    els.videoA.classList.toggle('active', lot === 'A');
    els.videoB.classList.toggle('active', lot === 'B');

    // Update card name
    els.name.textContent = lot === 'A' ? config.parkingNameA : config.parkingNameB;

    // Update card data from cache
    const cached = lastData[lot];
    if (cached && typeof cached.available === 'number' && typeof cached.total === 'number') {
      updateCardUI(cached);
      setStatus(consecutiveFailures[lot] < MAX_FAILURES);
    } else {
      els.available.textContent = '--';
      els.total.textContent = '--';
      setStatus(consecutiveFailures[lot] < MAX_FAILURES);
    }
  }

  function startRotation() {
    stopRotation();
    const interval = Math.max(1, config.rotationInterval || 10) * 1000;
    rotationTimerId = setInterval(() => {
      const nextLot = currentLot === 'A' ? 'B' : 'A';
      switchToLot(nextLot);
    }, interval);
    console.log(`A/B rotation every ${config.rotationInterval || 10}s`);
  }

  function stopRotation() {
    if (rotationTimerId) {
      clearInterval(rotationTimerId);
      rotationTimerId = null;
    }
  }

  // --- UI Updates ---
  function updateCardUI(data) {
    if (!data || typeof data.total !== 'number' || typeof data.available !== 'number') {
      console.warn('Invalid data:', data);
      return;
    }

    const oldAvailable = parseInt(els.available.textContent, 10);
    const oldTotal = parseInt(els.total.textContent, 10);

    if (!isNaN(oldAvailable) && oldAvailable !== data.available) {
      animateNumber(els.available, data.available);
    } else {
      els.available.textContent = data.available;
    }

    if (!isNaN(oldTotal) && oldTotal !== data.total) {
      animateNumber(els.total, data.total);
    } else {
      els.total.textContent = data.total;
    }
  }

  function animateNumber(el, newVal) {
    const oldText = el.textContent;
    const oldVal = parseInt(oldText, 10);

    if (isNaN(oldVal) || oldVal === newVal) {
      el.textContent = newVal;
      return;
    }

    // Brief "pulse" animation via class
    el.classList.add('updating');
    el.textContent = newVal;
    setTimeout(() => el.classList.remove('updating'), 600);
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
  window.addEventListener('storage', (e) => {
    if (e.key === 'parking_display_config') {
      console.log('Config changed, reloading...');
      config = getConfig();
      applyConfig();
      startPolling();               // restart poll timer with new interval
      startRotation();              // restart rotation timer with new interval
      switchToLot(currentLot);      // re-apply current lot with new names
    }
  });

  // --- Boot ---
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
