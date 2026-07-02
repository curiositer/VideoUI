/* ============================================================
   Config Module — localStorage-backed configuration
   ============================================================ */

const STORAGE_KEY = 'parking_display_config';

const DEFAULT_CONFIG = {
  // A/B rotation interval in seconds (switches parking lot display)
  rotationInterval: 10,

  // Update interval in seconds (kept for backward compatibility)
  updateInterval: 10,

  // Polling interval in seconds — how often the frontend fetches
  // latest data from GET /api/parking/status
  pollInterval: 2,

  // ParkID mapping — matches --parkid-a / --parkid-b server args
  parkIdA: '20210001',
  parkIdB: '20210002',

  // Video stream URLs (iframe or HLS .m3u8) — one per parking lot
  videoUrlA: '',
  videoUrlB: '',

  // Video embed type: 'iframe' or 'hls'
  videoType: 'iframe',

  // Parking lot display names
  parkingNameA: '停车场',
  parkingNameB: '停车楼',
};

/**
 * Read config from localStorage, filling missing keys with defaults.
 * @returns {object}
 */
function getConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const stored = JSON.parse(raw);
      const config = { ...DEFAULT_CONFIG, ...stored };
      // Fallback: existing configs may lack rotationInterval
      if (config.rotationInterval == null) {
        config.rotationInterval = config.updateInterval || 10;
      }
      return config;
    }
  } catch (e) {
    console.warn('Failed to read config from localStorage, using defaults.', e);
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Save config to localStorage.
 * @param {object} config
 */
function saveConfig(config) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    console.log('Config saved.');
  } catch (e) {
    console.error('Failed to save config.', e);
  }
}

/**
 * Reset config to defaults (clears localStorage).
 */
function resetConfig() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    console.log('Config reset to defaults.');
  } catch (e) {
    console.error('Failed to reset config.', e);
  }
}
