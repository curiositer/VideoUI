/* ============================================================
   主屏逻辑 — 轮询本地服务端数据，
   多摄像头轮播 + 主备故障切换 + 广告视频交替播放
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

  // 视频循环状态
  var videoState = 'camera';       // 'camera' | 'ad'
  var cameraTimerId = null;        // 切广告的倒计时
  var adFileList = [];             // /api/video-list 返回的广告文件名
  var currentAdIndex = 0;
  var currentVideoEl = null;       // 共享的 <video> 元素
  var currentPlayer = null;        // RTCPeerConnection（webrtc 播放时）
  var videoPanel = null;           // 视频容器 div

  // 摄像头列表 / 轮播 / 主备切换状态
  var cameraList = [];             // buildCameraList 产物 [{url, type, label, backups:[...]}]
  var currentCameraIndex = 0;      // 当前摄像头在 cameraList 中的索引
  var currentBackupIndex = -1;     // -1=主画面；>=0 表示正在用第 N 个备用流
  var cameraRotateTimerId = null;  // 多画面轮播定时器
  var recoveryCheckId = null;      // 主画面恢复探测定时器
  var recoveryStableSince = 0;     // 主画面首次探测可达的时间戳（0=未可达）
  var failoverCooldownUntil = 0;   // 故障切换冷却截止时间戳
  var rebuildTimerId = null;       // 原地重建（单摄像头无备用）的延迟定时器

  // 帧数看门狗（webrtc / local 通用）
  var cameraWatchdogId = null;
  var stallChecks = 0;             // 连续检测到无新帧的次数
  var lastFrameCount = -1;

  // 故障切换 / 恢复探测常量
  var RECOVERY_STABLE_MS = 3 * 60 * 1000;  // 主画面持续可达 3 分钟视为恢复正常
  var RECOVERY_CHECK_MS = 15000;           // 每 15 秒探测一次主画面
  var FAILOVER_COOLDOWN_MS = 3000;         // 两次故障切换之间的最小间隔

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
  //  视频系统 — 多摄像头轮播 + 主备故障切换 + 广告交替播放
  // ====================================================================

  // --- 构建有效摄像头列表（仅接受 webrtc / local 两种类型） ---
  function buildCameraList(streams) {
    var list = [];
    (streams || []).forEach(function (s) {
      if (!s || !s.url || !s.url.trim()) return;
      if (s.type !== 'webrtc' && s.type !== 'local') return; // 过滤已不支持的旧类型（hls/flv/iframe）
      var backups = [];
      (s.backups || []).forEach(function (b) {
        if (!b || !b.url || !b.url.trim()) return;
        backups.push({
          url: b.url.trim(),
          type: b.type === 'local' ? 'local' : 'webrtc',
        });
      });
      list.push({ url: s.url.trim(), type: s.type, label: s.label || '', backups: backups });
    });
    return list;
  }

  // --- 深比较两个摄像头列表（url + type + backups），用于热重载优化 ---
  function listsEqual(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i].url !== b[i].url || a[i].type !== b[i].type) return false;
      var ba = a[i].backups, bb = b[i].backups;
      if (ba.length !== bb.length) return false;
      for (var j = 0; j < ba.length; j++) {
        if (ba[j].url !== bb[j].url || ba[j].type !== bb[j].type) return false;
      }
    }
    return true;
  }

  // --- 返回当前应播放的源（主画面或备用流） ---
  function getCurrentSource() {
    if (cameraList.length === 0) return null;
    if (currentCameraIndex >= cameraList.length) currentCameraIndex = 0;
    var cam = cameraList[currentCameraIndex];
    if (currentBackupIndex >= 0 && currentBackupIndex < cam.backups.length) {
      return cam.backups[currentBackupIndex];
    }
    return { url: cam.url, type: cam.type };
  }

  function setupVideoSystem(cfg) {
    var area = els.videoArea;
    var placeholder = els.placeholder;
    if (!area) return;

    var newList = buildCameraList(cfg.videoStreams);

    if (newList.length === 0) {
      // 无有效摄像头 — 完全清理
      cleanupVideoSystem();
      if (videoPanel) { videoPanel.remove(); videoPanel = null; currentVideoEl = null; }
      cameraList = [];
      currentCameraIndex = 0;
      currentBackupIndex = -1;
      if (placeholder) placeholder.style.display = 'flex';
      return;
    }

    if (placeholder) placeholder.style.display = 'none';

    var listChanged = !listsEqual(cameraList, newList);

    // 软清理：停所有定时器、重置广告状态（列表未变时保留播放器与 DOM）
    cleanupVideoSystem(!listChanged);

    cameraList = newList;

    // 创建面板 + video 元素（若不存在）
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

      listChanged = true; // 新建元素，必须重建播放器
    }

    if (listChanged) {
      // 列表有变化：从第一个摄像头的主画面开始播放
      currentCameraIndex = 0;
      currentBackupIndex = -1;
      playCameraStream(getCurrentSource());
    } else if (currentBackupIndex >= 0) {
      // 列表未变且正在使用备用流：恢复探测被软清理停掉了，重新启动
      startRecoveryCheck();
    }

    // 多画面轮播
    startCameraRotateTimer();

    // 广告目录（留空 = 禁用广告轮播，仅摄像头）
    var folder = cfg.videoFolder || '';
    if (folder) {
      fetchAdFileList(folder);
    } else {
      adFileList = [];
      console.log('Video folder not configured, camera-only mode');
    }
  }

  // --- 从服务端获取广告视频文件列表 ---
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

  // --- 在共享 <video> 元素上播放摄像头源（webrtc 或 local） ---
  function playCameraStream(source) {
    if (!currentVideoEl) {
      rebuildVideoElement();
    }
    if (!currentVideoEl || !source) return;

    // 销毁现有播放器（含看门狗、待执行的重建）
    destroyPlayer();

    currentVideoEl.loop = true;
    currentVideoEl.src = '';
    currentVideoEl.srcObject = null;
    currentVideoEl.onended = null;
    currentVideoEl.onerror = null;

    if (source.type === 'webrtc') {
      setupWebrtcOnVideo(currentVideoEl, source.url);
    } else {
      // local 本地视频文件，循环播放
      currentVideoEl.src = source.url;
      currentVideoEl.onerror = function () {
        if (videoState !== 'camera') return; // 广告的错误由专属回调处理
        console.error('本地视频加载失败，触发故障切换: ' + source.url);
        failoverCamera();
      };
      currentVideoEl.play().catch(function () { /* 已静音，正常不会被自动播放策略拦截 */ });
    }

    videoState = 'camera';
    // 统一启动帧数看门狗（webrtc / local 通用）
    startCameraWatchdog(currentVideoEl);
  }

  // --- 在已有 <video> 元素上建立 WebRTC 播放 ---
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
        video.play().catch(function () { /* 已静音，正常不会被自动播放策略拦截 */ });
      }
    };

    pc.onconnectionstatechange = function () {
      if (pc !== currentPlayer) return; // 旧会话残留的 pc，忽略其事件
      if (pc.connectionState === 'failed') {
        console.error('WebRTC 连接失败，触发故障切换');
        failoverCamera();
      } else if (pc.connectionState === 'disconnected') {
        // disconnected 常可自行恢复；若未恢复，由帧数看门狗兜底
        console.warn('WebRTC connection disconnected');
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
      console.error('WebRTC/WHEP 握手失败:', err);
      if (pc === currentPlayer) failoverCamera();
    });

    currentPlayer = pc;
  }

  // ====================================================================
  //  故障切换 + 主画面恢复探测
  // ====================================================================

  // --- 统一故障切换入口 ---
  // 切换链：主画面 → 备1 → 备2 → … → 下一个摄像头的主画面
  // 只有一个摄像头且无备用时原地重建（保留自愈能力）
  function failoverCamera() {
    if (videoState !== 'camera') return;
    if (cameraList.length === 0) return;

    // 冷却保护：多个错误源（看门狗/连接事件/onerror）同时触发时避免切换风暴。
    // 冷却期内的触发被忽略，由持续运行的看门狗在下一轮兜底重试
    var now = Date.now();
    if (now < failoverCooldownUntil) return;
    failoverCooldownUntil = now + FAILOVER_COOLDOWN_MS;

    if (currentCameraIndex >= cameraList.length) currentCameraIndex = 0;
    var cam = cameraList[currentCameraIndex];
    var backups = cam.backups || [];

    if (currentBackupIndex + 1 < backups.length) {
      // 还有备用流可用：切换到下一个备用
      currentBackupIndex++;
      console.warn('画面断流，切换到备用流 ' + (currentBackupIndex + 1) + '/' + backups.length +
                   '（' + (cam.label || '画面' + (currentCameraIndex + 1)) + '）');
      playCameraStream(getCurrentSource());
      startRecoveryCheck();   // 开始探测主画面是否恢复
      return;
    }

    if (cameraList.length > 1) {
      // 备用用尽（或没有备用）：切换到下一个摄像头的主画面
      stopRecoveryCheck();
      currentCameraIndex = (currentCameraIndex + 1) % cameraList.length;
      currentBackupIndex = -1;
      var next = cameraList[currentCameraIndex];
      console.warn('备用流用尽，切换到下一个摄像头: ' + (next.label || '画面' + (currentCameraIndex + 1)));
      playCameraStream(getCurrentSource());
      return;
    }

    // 只有一个摄像头
    if (currentBackupIndex >= 0) {
      // 备用也断了：回到主画面，重试整条切换链
      stopRecoveryCheck();
      currentBackupIndex = -1;
      console.warn('备用流用尽，回到主画面重试');
      playCameraStream(getCurrentSource());
    } else {
      // 无备用：延迟 1 秒原地重建（配合冷却与看门狗自然限速）
      console.warn('画面断流，1 秒后原地重建');
      scheduleRebuildCurrent(1000);
    }
  }

  // --- 延迟重建当前源（单摄像头无备用时的自愈路径） ---
  function scheduleRebuildCurrent(delayMs) {
    if (rebuildTimerId !== null) return;   // 已有待执行的重建，去重
    rebuildTimerId = setTimeout(function () {
      rebuildTimerId = null;
      if (videoState !== 'camera') return;
      var source = getCurrentSource();
      if (!source) return;
      console.log('重建视频会话:', source.url);
      playCameraStream(source);
    }, delayMs);
  }

  // --- 主画面恢复探测：使用备用流期间，每 15 秒探测主画面 ---
  // 主画面持续可达满 3 分钟 → 认为恢复正常，切回主画面
  function startRecoveryCheck() {
    stopRecoveryCheck();
    recoveryCheckId = setInterval(function () {
      if (videoState !== 'camera' || currentBackupIndex < 0) return;
      var cam = cameraList[currentCameraIndex];
      if (!cam) return;
      probeStream(cam.url, cam.type).then(function (ok) {
        // 异步探测返回时可能已切走或探测已停止
        if (recoveryCheckId === null || currentBackupIndex < 0) return;
        if (!ok) {
          if (recoveryStableSince !== 0) console.log('主画面探测中断，重新计时');
          recoveryStableSince = 0;
          return;
        }
        if (recoveryStableSince === 0) {
          recoveryStableSince = Date.now();
          console.log('主画面探测可达，进入 3 分钟稳定观察期');
          return;
        }
        if (Date.now() - recoveryStableSince >= RECOVERY_STABLE_MS) {
          recoverToPrimary();
        }
      });
    }, RECOVERY_CHECK_MS);
  }

  function stopRecoveryCheck() {
    if (recoveryCheckId !== null) {
      clearInterval(recoveryCheckId);
      recoveryCheckId = null;
    }
    recoveryStableSince = 0;
  }

  // --- 探测流是否可达（浏览器无法发 ICMP ping，用 HTTP HEAD 等效） ---
  // webrtc：HEAD 请求 MediaMTX 的流路径页面；local：HEAD 请求静态文件
  function probeStream(url, type) {
    return fetch(url, { method: 'HEAD', cache: 'no-store' }).then(function (resp) {
      return resp.ok;
    }).catch(function () {
      return false;
    });
  }

  // --- 主画面恢复：切回主画面并停止探测 ---
  function recoverToPrimary() {
    stopRecoveryCheck();
    currentBackupIndex = -1;
    if (videoState !== 'camera') return;  // 广告态防御（探测在广告期间本应已停止）
    console.log('主画面已稳定恢复 3 分钟，切回主画面');
    playCameraStream(getCurrentSource());
  }

  // ====================================================================
  //  帧数看门狗（webrtc / local 通用）
  // ====================================================================

  // --- 看门狗：解码帧数停止增长时触发故障切换 ---
  // 兜底 WebRTC connectionState 仍为 'connected' 的静默冻结等场景
  function startCameraWatchdog(video) {
    stopCameraWatchdog();
    lastFrameCount = -1;
    stallChecks = 0;
    cameraWatchdogId = setInterval(function () {
      if (videoState !== 'camera' || !video || video !== currentVideoEl || !video.isConnected) return;

      var frames;
      if (typeof video.getVideoPlaybackQuality === 'function') {
        frames = video.getVideoPlaybackQuality().totalVideoFrames;
      } else if (typeof video.webkitDecodedFrameCount === 'number') {
        frames = video.webkitDecodedFrameCount;
      } else {
        frames = video.currentTime; // 兜底：用播放时钟代替帧数
      }

      if (frames === lastFrameCount) {
        stallChecks++;
        if (stallChecks >= 2) {   // 约 20 秒无新帧
          console.error('画面冻结（约 20 秒无新帧），触发故障切换');
          stallChecks = 0;
          failoverCamera();
        }
      } else {
        stallChecks = 0;
      }
      lastFrameCount = frames;
    }, 10000);
  }

  function stopCameraWatchdog() {
    if (cameraWatchdogId !== null) {
      clearInterval(cameraWatchdogId);
      cameraWatchdogId = null;
    }
    stallChecks = 0;
    lastFrameCount = -1;
  }

  // ====================================================================
  //  多画面轮播
  // ====================================================================

  // --- 轮播定时器：多个摄像头时按 cameraRotateInterval 秒循环切换 ---
  // 间隔为 0 或只有一个摄像头时不轮播
  function startCameraRotateTimer() {
    stopCameraRotateTimer();
    var interval = (config.cameraRotateInterval != null) ? config.cameraRotateInterval : 30;
    if (interval <= 0 || cameraList.length <= 1) return;

    console.log('摄像头轮播: 每 ' + interval + ' 秒切换（共 ' + cameraList.length + ' 个画面）');
    cameraRotateTimerId = setInterval(function () {
      if (videoState !== 'camera') return;  // 广告播放期间不切换
      stopRecoveryCheck();                   // 切走后不再探测上一个摄像头的主画面
      currentCameraIndex = (currentCameraIndex + 1) % cameraList.length;
      currentBackupIndex = -1;               // 新摄像头从主画面开始
      console.log('轮播切换到画面 ' + (currentCameraIndex + 1) + '/' + cameraList.length);
      playCameraStream(getCurrentSource());
    }, interval * 1000);
  }

  function stopCameraRotateTimer() {
    if (cameraRotateTimerId !== null) {
      clearInterval(cameraRotateTimerId);
      cameraRotateTimerId = null;
    }
  }

  // ====================================================================
  //  广告视频交替播放
  // ====================================================================

  // --- 摄像头持续时长倒计时（到点切广告） ---
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

  // --- 切换到广告视频 ---
  function switchToAdVideo() {
    if (adFileList.length === 0) {
      // 无广告视频 — 保持摄像头模式
      return;
    }

    if (!currentVideoEl) {
      rebuildVideoElement();
      if (!currentVideoEl) return;
    }

    // 广告期间暂停轮播与主画面恢复探测
    stopCameraRotateTimer();
    stopRecoveryCheck();

    var filename = adFileList[currentAdIndex];
    var folder = config.videoFolder ? config.videoFolder + '/' : '';
    var videoUrl = '/videos/' + folder + filename;

    // 切换前销毁摄像头播放器
    destroyPlayer();

    // 完全重置 video 元素
    currentVideoEl.removeAttribute('src');
    currentVideoEl.srcObject = null;
    currentVideoEl.load();

    // 设置广告本地视频播放
    currentVideoEl.loop = false;
    currentVideoEl.src = videoUrl;
    currentVideoEl.onended = onAdVideoEnded;
    currentVideoEl.onerror = onAdVideoError;

    // 显式 play() — 仅靠 autoplay 在切换 src 时可能不触发
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

  function onAdVideoError() {
    var el = currentVideoEl;
    var code = el && el.error ? el.error.code : 'unknown';
    var msg = el && el.error ? el.error.message : 'unknown';
    console.error('Ad video error (code=' + code + '): ' + msg + ' — src=' + (el ? el.src : ''));
    currentAdIndex = (currentAdIndex + 1) % adFileList.length;
    switchToCamera();
  }

  // --- 广告结束切回摄像头（保持故障切换后的主备状态，不重置索引） ---
  function switchToCamera() {
    if (!currentVideoEl) {
      rebuildVideoElement();
      if (!currentVideoEl) return;
    }

    // 清理广告播放状态
    currentVideoEl.onended = null;
    currentVideoEl.onerror = null;
    currentVideoEl.loop = true;
    currentVideoEl.src = '';

    videoState = 'camera';

    var source = getCurrentSource();
    if (source) {
      playCameraStream(source);
    }

    startCameraTimer();
    startCameraRotateTimer();
    if (currentBackupIndex >= 0) startRecoveryCheck();  // 仍在备用流上则继续探测主画面
  }

  // --- 重建 <video> 元素（防御性保留） ---
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

  // --- 销毁当前播放器（WebRTC 连接）及关联定时器 ---
  function destroyPlayer() {
    // 停止看门狗、取消待执行的原地重建
    stopCameraWatchdog();
    if (rebuildTimerId !== null) {
      clearTimeout(rebuildTimerId);
      rebuildTimerId = null;
    }
    if (currentPlayer) {
      // RTCPeerConnection
      if (currentPlayer.close) {
        try { currentPlayer.close(); } catch (e) { /* 忽略 */ }
      }
      currentPlayer = null;
    }
    if (currentVideoEl) {
      currentVideoEl.src = '';
      currentVideoEl.srcObject = null;
    }
  }

  // --- 软清理：停所有定时器，按需保留播放器，保留 DOM ---
  function cleanupVideoSystem(keepPlayer) {
    stopCameraTimer();
    stopCameraRotateTimer();
    stopRecoveryCheck();
    if (!keepPlayer) {
      destroyPlayer();
    }
    adFileList = [];
    currentAdIndex = 0;
    videoState = 'camera';
    // 注意：不移除 videoPanel / currentVideoEl —— setupVideoSystem 会复用，避免黑闪
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
