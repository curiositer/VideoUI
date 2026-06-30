/* ============================================================
   Main Display Logic — rotation timer, data fetching, UI updates
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
  let rotationTimerId = null;
  let consecutiveFailures = { A: 0, B: 0 };
  let lastData = { A: null, B: null };
  const MAX_FAILURES = 3;

  // --- Init ---
  function init() {
    config = getConfig();
    applyConfig();
    switchToLot('A');                 // initial display + data fetch
    startRotation();
  }

  // --- Apply config to DOM ---
  function applyConfig() {
    // Pre-load both video streams into DOM (only active panel is visible via CSS)
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
      // Default: iframe (IP camera web view)
      const iframe = document.createElement('iframe');
      iframe.src = url;
      iframe.allow = 'autoplay';
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      container.appendChild(iframe);
    }
  }

  // --- Rotation ---
  function switchToLot(lot) {
    currentLot = lot;

    // Toggle video panel visibility
    els.videoA.classList.toggle('active', lot === 'A');
    els.videoB.classList.toggle('active', lot === 'B');

    // Update card with cached data (or placeholder)
    els.name.textContent = lot === 'A' ? config.parkingNameA : config.parkingNameB;

    const cached = lastData[lot];
    if (cached && typeof cached.available === 'number' && typeof cached.total === 'number') {
      updateCardUI(cached);
      setStatus(consecutiveFailures[lot] < MAX_FAILURES);
    } else {
      els.available.textContent = '--';
      els.total.textContent = '--';
      setStatus(consecutiveFailures[lot] < MAX_FAILURES);
    }

    // Fetch fresh data for the newly active lot
    fetchDataForLot(lot);
  }

  function startRotation() {
    stopRotation();
    const interval = Math.max(1, config.rotationInterval || config.updateInterval || 10) * 1000;
    rotationTimerId = setInterval(() => {
      const nextLot = currentLot === 'A' ? 'B' : 'A';
      switchToLot(nextLot);
    }, interval);
    console.log(`A/B rotation every ${config.rotationInterval || config.updateInterval || 10}s`);
  }

  function stopRotation() {
    if (rotationTimerId) {
      clearInterval(rotationTimerId);
      rotationTimerId = null;
    }
  }

  // --- Data Fetching ---
  function fetchDataForLot(lot) {
    if (config.apiMode === 'combined') {
      fetchCombined();
    } else {
      fetchSingle(lot);
    }
  }

  async function fetchCombined() {
    try {
      const resp = await fetch(config.combinedApiUrl, { signal: timeoutSignal(5000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      // Cache both lots
      if (data.a && typeof data.a.total === 'number') {
        lastData.A = data.a;
        consecutiveFailures.A = 0;
      }
      if (data.b && typeof data.b.total === 'number') {
        lastData.B = data.b;
        consecutiveFailures.B = 0;
      }

      // Update UI only for currently active lot
      const activeData = data[currentLot.toLowerCase()];
      if (activeData && typeof activeData.total === 'number') {
        updateCardUI(activeData);
        setStatus(true);
      }
    } catch (e) {
      console.error('Combined fetch failed:', e);
      handleFailure(currentLot);
    }
  }

  async function fetchSingle(lot) {
    const url = lot === 'A' ? config.apiUrlA : config.apiUrlB;
    try {
      const resp = await fetch(url, { signal: timeoutSignal(5000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      if (!data || typeof data.total !== 'number' || typeof data.available !== 'number') {
        throw new Error('Invalid data format');
      }

      // Cache this lot's data
      lastData[lot] = data;
      consecutiveFailures[lot] = 0;

      // Only update UI if this lot is still active (stale response guard)
      if (currentLot === lot) {
        updateCardUI(data);
        setStatus(true);
      }
    } catch (e) {
      console.error(`Fetch ${lot} failed:`, e);
      // Always track failure for the lot that was requested
      consecutiveFailures[lot]++;
      if (consecutiveFailures[lot] >= MAX_FAILURES) {
        lastData[lot] = null;
      }
      // Only update UI if this lot is still active
      if (currentLot === lot) {
        handleFailure(lot);
      }
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

  function handleFailure(lot) {
    consecutiveFailures[lot]++;
    if (consecutiveFailures[lot] >= MAX_FAILURES) {
      lastData[lot] = null;
      if (currentLot === lot) {
        els.available.textContent = '--';
        els.total.textContent = '--';
      }
    }
    if (currentLot === lot) {
      setStatus(false);
    }
  }

  // --- Helpers ---
  function timeoutSignal(ms) {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), ms);
    return ctrl.signal;
  }

  // Reload config on storage change (from admin page in another tab)
  window.addEventListener('storage', (e) => {
    if (e.key === 'parking_display_config') {
      console.log('Config changed, reloading...');
      config = getConfig();
      applyConfig();
      startRotation();              // restart timer with new interval
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
