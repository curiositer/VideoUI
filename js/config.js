/* ============================================================
   Config Module — localStorage-backed configuration
   ============================================================ */

const STORAGE_KEY = 'parking_display_config';

const DEFAULT_CONFIG = {
  // Polling interval in seconds — how often the frontend fetches
  // latest data from GET /api/parking/status
  pollInterval: 2,

  // ParkID mapping — matches --parkid-a / --parkid-b server args
  // parkIdA = parking lot (停车场), parkIdB = parking building (停车楼)
  parkIdA: '20210001',
  parkIdB: '20210002',

  // Display name for the location (shown at top of card)
  parkingName: 'xxxx景区游客中心停车场',

  // Video stream URL (iframe or HLS .m3u8)
  videoUrl: '',

  // Video embed type: 'iframe' or 'hls'
  videoType: 'iframe',
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
      return { ...DEFAULT_CONFIG, ...stored };
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
