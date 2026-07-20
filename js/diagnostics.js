/* ============================================================
   诊断日志模块 — 静默收集错误/警告/事件，定期上报到服务端
   不阻塞主线程，不影响视频播放，所有上报 fire-and-forget
   ============================================================ */

(function () {
  'use strict';

  // --- 配置 ---
  var FLUSH_INTERVAL_MS = 30000;   // 每 30 秒上报一次
  var MAX_BUFFER_SIZE = 5000;      // 环形缓冲最大条目数
  var MAX_BATCH_SIZE = 100;        // 单次上报最多 100 条
  var UPLOAD_URL = '/api/diagnostics';

  // --- 内部状态 ---
  var buffer = [];                 // 事件缓冲
  var writePos = 0;               // 环形缓冲写入位置
  var isCircular = false;         // 是否已绕回
  var flushTimerId = null;
  var sessionId = randomId();
  var pageType = detectPageType();

  // --- 分类关键词映射 ---
  var CATEGORY_RULES = [
    { pattern: /webrtc|whep|rtcpeer|ice|sdp/i,               category: 'video' },
    { pattern: /冻结|stall|watchdog|无新帧|总视频帧/i,          category: 'video' },
    { pattern: /断流|故障切换|failover|备用流|backup|主画面|原地重建|重建视频/i, category: 'video' },
    { pattern: /连接失败|连接断开|connected|disconnected|failed/i, category: 'video' },
    { pattern: /本地视频|加载失败|play\(\)|自动播放/i,            category: 'video' },
    { pattern: /轮播|探测|恢复|recovery|probe/i,                 category: 'video' },
    { pattern: /广告|ad video/i,                                 category: 'ad' },
    { pattern: /轮询|poll|status|parking/i,                      category: 'data' },
    { pattern: /配置|config|localStorage|storage/i,              category: 'system' },
  ];

  // --- 工具函数 ---
  function randomId() {
    return Math.random().toString(36).substring(2, 10) +
           Date.now().toString(36);
  }

  function detectPageType() {
    var path = window.location.pathname.toLowerCase();
    if (path.indexOf('admin') >= 0) return 'admin';
    if (path.indexOf('status') >= 0) return 'status';
    return 'display';
  }

  function nowISO() {
    return new Date().toISOString();
  }

  function detectCategory(message) {
    if (!message || typeof message !== 'string') return 'system';
    for (var i = 0; i < CATEGORY_RULES.length; i++) {
      if (CATEGORY_RULES[i].pattern.test(message)) {
        return CATEGORY_RULES[i].category;
      }
    }
    return 'system';
  }

  function extractStack() {
    try {
      var err = new Error();
      if (err.stack) {
        var lines = err.stack.split('\n');
        // 跳过 diagnostics.js 自身的调用帧和 Diag 包装帧
        var relevant = [];
        for (var i = 3; i < Math.min(lines.length, 8); i++) {
          var trimmed = lines[i].trim();
          if (trimmed && trimmed.indexOf('diagnostics.js') < 0) {
            relevant.push(trimmed);
          }
        }
        return relevant.length > 0 ? relevant.join('\n') : undefined;
      }
    } catch (e) { /* 忽略 */ }
    return undefined;
  }

  // --- 事件入队（环形缓冲） ---
  function enqueue(level, category, message, detail) {
    var event = {
      ts: nowISO(),
      level: level,
      category: category || 'system',
      message: String(message || '').substring(0, 500),
      sessionId: sessionId,
      page: pageType,
    };
    if (detail && typeof detail === 'object') {
      // 浅拷贝，只保留基本类型字段
      var safe = {};
      try {
        for (var k in detail) {
          if (!Object.prototype.hasOwnProperty.call(detail, k)) continue;
          var v = detail[k];
          if (v === null || v === undefined) continue;
          var t = typeof v;
          if (t === 'string' || t === 'number' || t === 'boolean') {
            safe[k] = v;
          } else if (t === 'object') {
            try { safe[k] = JSON.parse(JSON.stringify(v)); } catch(e) { safe[k] = String(v); }
          } else {
            safe[k] = String(v);
          }
        }
      } catch (e) { /* 忽略序列化错误 */ }
      if (Object.keys(safe).length > 0) event.detail = safe;
    }
    buffer[writePos] = event;
    writePos++;
    if (writePos >= MAX_BUFFER_SIZE) {
      writePos = 0;
      isCircular = true;
    }
    // 如果积压太多，立即触发一次上报
    if (getBufferSize() >= MAX_BATCH_SIZE) {
      flush();
    }
  }

  function getBufferSize() {
    return isCircular ? MAX_BUFFER_SIZE : writePos;
  }

  function drainBuffer(maxCount) {
    var result = [];
    var count = Math.min(maxCount, getBufferSize());
    if (count === 0) return result;

    if (isCircular) {
      // 从 writePos（最旧）开始读取
      for (var i = 0; i < count; i++) {
        var idx = (writePos + i) % MAX_BUFFER_SIZE;
        result.push(buffer[idx]);
        buffer[idx] = undefined;
      }
      isCircular = false;
      writePos = 0;
    } else {
      for (var j = 0; j < count; j++) {
        result.push(buffer[j]);
        buffer[j] = undefined;
      }
      writePos = 0;
    }
    return result;
  }

  // --- 上报到服务端 ---
  function flush() {
    var events = drainBuffer(MAX_BATCH_SIZE);
    if (events.length === 0) return;

    var payload;
    try {
      payload = JSON.stringify(events);
    } catch (e) {
      return; // 序列化失败，静默丢弃（极少发生）
    }

    // 优先使用 sendBeacon（保证不阻塞，页面卸载时也能发）
    if (navigator.sendBeacon) {
      try {
        var blob = new Blob([payload], { type: 'application/json' });
        var ok = navigator.sendBeacon(UPLOAD_URL, blob);
        if (!ok) {
          // sendBeacon 队列满，回退到 fetch
          fetch(UPLOAD_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            keepalive: true,
          }).catch(function () { /* 静默忽略 */ });
        }
      } catch (e) {
        // Blob 创建失败等极端情况，尝试 fetch
        fetch(UPLOAD_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
        }).catch(function () { /* 静默忽略 */ });
      }
    } else {
      // 无 sendBeacon 时降级为 fetch
      fetch(UPLOAD_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(function () { /* 静默忽略 */ });
    }
  }

  // --- 定时上报 ---
  function startFlushTimer() {
    if (flushTimerId !== null) return;
    flushTimerId = setInterval(flush, FLUSH_INTERVAL_MS);
  }

  // --- Console 拦截 ---
  var _origConsoleError = console.error.bind(console);
  var _origConsoleWarn = console.warn.bind(console);
  var _origConsoleLog = console.log.bind(console);

  console.error = function () {
    // 先写诊断缓冲
    var msg = arguments.length > 0 ? String(arguments[0]) : '';
    var cat = detectCategory(msg);
    var detail = {};
    if (arguments.length > 1 && arguments[1] instanceof Error) {
      detail.error = arguments[1].message;
      detail.stack = arguments[1].stack ? arguments[1].stack.substring(0, 500) : undefined;
    } else if (arguments.length > 1) {
      detail.extra = String(arguments[1]);
    }
    enqueue('error', cat, msg, detail);
    // 再调原始方法（保留浏览器控制台输出）
    _origConsoleError.apply(console, arguments);
  };

  console.warn = function () {
    var msg = arguments.length > 0 ? String(arguments[0]) : '';
    var cat = detectCategory(msg);
    enqueue('warn', cat, msg, null);
    _origConsoleWarn.apply(console, arguments);
  };

  // console.log 只在匹配到已知分类时才收集（避免过于嘈杂的日志）
  console.log = function () {
    var msg = arguments.length > 0 ? String(arguments[0]) : '';
    var cat = detectCategory(msg);
    if (cat !== 'system') {
      enqueue('info', cat, msg, null);
    }
    _origConsoleLog.apply(console, arguments);
  };

  // --- 全局异常捕获 ---
  window.addEventListener('error', function (e) {
    var msg = e.message || '未知异常';
    if (e.error && e.error.stack) {
      enqueue('error', 'system', msg, {
        source: (e.filename || '') + ':' + (e.lineno || '') + ':' + (e.colno || ''),
        stack: e.error.stack.substring(0, 500),
      });
    } else {
      enqueue('error', 'system', msg, {
        source: (e.filename || '') + ':' + (e.lineno || '') + ':' + (e.colno || ''),
      });
    }
  });

  window.addEventListener('unhandledrejection', function (e) {
    var reason = e.reason;
    var msg = '未处理的 Promise 拒绝';
    var detail = {};
    if (reason instanceof Error) {
      msg = reason.message;
      detail.stack = reason.stack ? reason.stack.substring(0, 500) : undefined;
    } else if (reason !== undefined && reason !== null) {
      detail.reason = String(reason).substring(0, 300);
    }
    enqueue('error', 'system', msg, detail);
  });

  // --- 页面卸载时上报剩余事件 ---
  window.addEventListener('beforeunload', function () {
    var events = drainBuffer(MAX_BATCH_SIZE);
    if (events.length === 0) return;
    try {
      var payload = JSON.stringify(events);
      if (navigator.sendBeacon) {
        navigator.sendBeacon(UPLOAD_URL, new Blob([payload], { type: 'application/json' }));
      }
    } catch (e) { /* 静默忽略 */ }
  });

  // --- 公开 API ---
  window.Diag = {
    /**
     * 记录错误事件
     * @param {string} category - 'video' | 'data' | 'system' | 'ad'
     * @param {string} message - 错误描述
     * @param {object} [detail] - 附加信息
     */
    error: function (category, message, detail) {
      enqueue('error', category, message, detail);
    },

    /**
     * 记录警告事件
     * @param {string} category - 'video' | 'data' | 'system' | 'ad'
     * @param {string} message - 警告描述
     * @param {object} [detail] - 附加信息
     */
    warn: function (category, message, detail) {
      enqueue('warn', category, message, detail);
    },

    /**
     * 记录一般事件
     * @param {string} category - 'video' | 'data' | 'system' | 'ad'
     * @param {string} message - 事件描述
     * @param {object} [detail] - 附加信息
     */
    info: function (category, message, detail) {
      enqueue('info', category, message, detail);
    },

    /**
     * 立即上报缓冲中的事件
     */
    flush: flush,

    /**
     * 获取当前缓冲大小（调试用）
     */
    getBufferSize: getBufferSize,

    /**
     * 获取当前会话 ID
     */
    getSessionId: function () { return sessionId; },
  };

  // --- 启动 ---
  startFlushTimer();

  console.log('诊断模块已启动 (session=' + sessionId + ', page=' + pageType + ')');
})();
