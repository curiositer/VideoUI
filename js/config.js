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

  // Video streams — array of {url, type, label}
  // type: 'iframe' (IP摄像机网页), 'hls' (.m3u8流), 'flv' (HTTP-FLV流), 'webrtc' (WebRTC), 'local' (本地视频)
  // The first valid stream is used as the camera feed
  videoStreams: [],

  // Subfolder under /videos/ containing ad videos to play between camera intervals
  // e.g. 'ads' → /videos/ads/; leave empty to disable ad rotation
  videoFolder: '',

  // How many seconds to show the camera feed before switching to an ad video
  // Default 300 = 5 minutes
  cameraDuration: 300,
};

/**
 * Read config from localStorage, filling missing keys with defaults.
 * Migrates legacy single-video config to videoStreams array automatically.
 * @returns {object}
 */
function getConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const stored = JSON.parse(raw);

      // Migrate old single-video config to videoStreams array
      if ((!stored.videoStreams || stored.videoStreams.length === 0) && stored.videoUrl) {
        stored.videoStreams = [{
          url: stored.videoUrl,
          type: stored.videoType || 'iframe',
          label: '监控画面',
        }];
        // Clean up old keys so they don't stick around
        delete stored.videoUrl;
        delete stored.videoType;
      }

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
