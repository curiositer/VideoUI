/* ============================================================
   Main Display Logic — data fetching, UI updates, video load
   ============================================================ */

(function () {
  'use strict';

  // --- DOM refs ---
  const els = {
    nameA:       document.getElementById('name-a'),
    availableA:  document.getElementById('available-a'),
    totalA:      document.getElementById('total-a'),
    statusDotA:  document.getElementById('status-dot-a'),

    nameB:       document.getElementById('name-b'),
    availableB:  document.getElementById('available-b'),
    totalB:      document.getElementById('total-b'),
    statusDotB:  document.getElementById('status-dot-b'),

    videoA:      document.getElementById('video-a'),
    videoB:      document.getElementById('video-b'),

    placeholderA: document.getElementById('placeholder-a'),
    placeholderB: document.getElementById('placeholder-b'),
  };

  // --- State ---
  let config;
  let timerId = null;
  let consecutiveFailuresA = 0;
  let consecutiveFailuresB = 0;
  const MAX_FAILURES = 3;

  // Last known good values (preserved across failures)
  let lastDataA = null;
  let lastDataB = null;

  // --- Init ---
  function init() {
    config = getConfig();
    applyConfig();
    fetchData();                    // Immediate first fetch
    startTimer();
  }

  // --- Apply config to DOM ---
  function applyConfig() {
    els.nameA.textContent = config.parkingNameA;
    els.nameB.textContent = config.parkingNameB;

    // Setup video panels
    setupVideo('A', config.videoUrlA, els.videoA, els.placeholderA);
    setupVideo('B', config.videoUrlB, els.videoB, els.placeholderB);
  }

  function setupVideo(slot, url, container, placeholder) {
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

  // --- Data Fetching ---
  async function fetchData() {
    if (config.apiMode === 'combined') {
      await fetchCombined();
    } else {
      await Promise.all([fetchSingle('A', config.apiUrlA), fetchSingle('B', config.apiUrlB)]);
    }
  }

  async function fetchCombined() {
    try {
      const resp = await fetch(config.combinedApiUrl, { signal: timeoutSignal(5000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      updateCard('A', data.a, lastDataA);
      updateCard('B', data.b, lastDataB);

      lastDataA = data.a;
      lastDataB = data.b;
      consecutiveFailuresA = 0;
      consecutiveFailuresB = 0;
      setStatus('A', true);
      setStatus('B', true);
    } catch (e) {
      console.error('Combined fetch failed:', e);
      handleFailure('A');
      handleFailure('B');
    }
  }

  async function fetchSingle(slot, url) {
    try {
      const resp = await fetch(url, { signal: timeoutSignal(5000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      if (slot === 'A') {
        updateCard('A', data, lastDataA);
        lastDataA = data;
        consecutiveFailuresA = 0;
        setStatus('A', true);
      } else {
        updateCard('B', data, lastDataB);
        lastDataB = data;
        consecutiveFailuresB = 0;
        setStatus('B', true);
      }
    } catch (e) {
      console.error(`Fetch ${slot} failed:`, e);
      handleFailure(slot);
    }
  }

  // --- UI Updates ---
  function updateCard(slot, data, lastData) {
    if (!data || typeof data.total !== 'number' || typeof data.available !== 'number') {
      console.warn(`Invalid data for slot ${slot}:`, data);
      return;
    }

    const availEl = slot === 'A' ? els.availableA : els.availableB;
    const totalEl = slot === 'A' ? els.totalA : els.totalB;

    // Animate number change
    if (lastData && lastData.available !== data.available) {
      animateNumber(availEl, data.available);
    } else {
      availEl.textContent = data.available;
    }

    totalEl.textContent = data.total;
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

  function setStatus(slot, ok) {
    const dot = slot === 'A' ? els.statusDotA : els.statusDotB;
    if (ok) {
      dot.classList.remove('error');
    } else {
      dot.classList.add('error');
    }
  }

  function handleFailure(slot) {
    if (slot === 'A') {
      consecutiveFailuresA++;
      if (consecutiveFailuresA >= MAX_FAILURES) {
        els.availableA.textContent = '--';
        els.totalA.textContent = '--';
        lastDataA = null;
      }
      setStatus('A', false);
    } else {
      consecutiveFailuresB++;
      if (consecutiveFailuresB >= MAX_FAILURES) {
        els.availableB.textContent = '--';
        els.totalB.textContent = '--';
        lastDataB = null;
      }
      setStatus('B', false);
    }
  }

  // --- Timer ---
  function startTimer() {
    stopTimer();
    const ms = Math.max(1, config.updateInterval) * 1000;
    timerId = setInterval(fetchData, ms);
    console.log(`Polling every ${config.updateInterval}s`);
  }

  function stopTimer() {
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
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
      startTimer();
      fetchData();
    }
  });

  // --- Boot ---
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
