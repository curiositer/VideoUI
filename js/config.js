/* ============================================================
   Config Module — localStorage-backed configuration
   ============================================================ */

const STORAGE_KEY = 'parking_display_config';

const DEFAULT_CONFIG = {
  // Update interval in seconds
  updateInterval: 10,

  // API mode: 'separate' = two endpoints (apiUrlA / apiUrlB)
  //           'combined' = one endpoint (combinedApiUrl) returns {a:{},b:{}}
  apiMode: 'separate',

  // Separate mode — each returns { total: number, available: number }
  apiUrlA: '/api/parking/a',
  apiUrlB: '/api/parking/b',

  // Combined mode — returns { a: {total, available}, b: {total, available} }
  combinedApiUrl: '/api/parking/all',

  // Video stream URLs (iframe or HLS .m3u8)
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
      // Deep-merge: stored values override defaults, missing keys use defaults
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
