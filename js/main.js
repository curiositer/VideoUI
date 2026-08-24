/* ============================================================
   主屏逻辑 — 轮询本地服务端数据，
   多摄像头轮播 + 主备故障切换 + 广告视频交替播放
   双 video 元素交叉渐变：消除切换黑屏
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
  var videoPanel = null;           // 视频容器 div

  // 双 video 元素系统 — 交叉渐变消除切换黑屏
  // activeVideo: 当前可见（video-active class, opacity:1 z-index:2）
  // standbyVideo: 隐藏预加载（video-standby class, opacity:0 z-index:1）
  // 切换时在 standby 上连接新流，就绪后 CSS 0.5s 渐变 → 交换引用
  var activeVideo = null;
  var standbyVideo = null;
  var activePlayer = null;         // activeVideo 的 RTCPeerConnection
  var standbyPlayer = null;        // standbyVideo 的 RTCPeerConnection
  var switchLocked = false;        // 防止并发切换
  var crossfadeTimerId = null;     // CSS 渐变完成定时器（用于取消冲突）
  var activeSourceUrl = null;      // 当前 activeVideo 正在播放的源 URL（用于跳过同源重连）

  // 摄像头列表 / 轮播 / 主备切换状态
  var cameraList = [];             // buildCameraList 产物 [{url, type, label, backups:[...]}]
  var currentCameraIndex = 0;      // 当前摄像头在 cameraList 中的索引
  var currentBackupIndex = -1;     // -1=主画面；>=0 表示正在用第 N 个备用流
  var cameraRotateTimerId = null;  // 多画面轮播定时器
  var recoveryCheckId = null;      // 主画面恢复探测定时器
  var recoveryStableSince = 0;     // 主画面首次探测可达的时间戳（0=未可达）
  var failoverCooldownUntil = 0;   // 故障切换冷却截止时间戳
  var rebuildTimerId = null;       // 原地重建（单摄像头无备用）的延迟定时器

  // 帧数看门狗（仅监控 activeVideo）
  var cameraWatchdogId = null;

  // 故障切换 / 恢复探测常量
  var RECOVERY_STABLE_MS = 3 * 60 * 1000;  // 主画面持续可达 3 分钟视为恢复正常
  var RECOVERY_CHECK_MS = 15000;           // 每 15 秒探测一次主画面
  var FAILOVER_COOLDOWN_MS = 3000;         // 两次故障切换之间的最小间隔

  // 故障切换计数器（供诊断仪表盘使用）
  var failoverStats = { total: 0, freezes: 0 };

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
  //  视频系统 — 双 video 元素交叉渐变 + 多摄像头轮播 + 主备故障切换 + 广告交替播放
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

  // ====================================================================
  //  双 video 元素管理
  // ====================================================================

  // --- 初始化两个 video 元素（active 在上层，standby 在下层） ---
  function initVideoElements() {
    if (!videoPanel || !videoPanel.parentNode) {
      videoPanel = document.createElement('div');
      videoPanel.className = 'video-panel';
      videoPanel.id = 'video-panel-main';
      els.videoArea.appendChild(videoPanel);
    }

    if (activeVideo && activeVideo.parentNode === videoPanel &&
        standbyVideo && standbyVideo.parentNode === videoPanel) {
      return; // 已初始化
    }

    videoPanel.innerHTML = '';

    // 先创建 standby（在下层）
    standbyVideo = document.createElement('video');
    standbyVideo.autoplay = true;
    standbyVideo.muted = true;
    standbyVideo.playsInline = true;
    standbyVideo.loop = true;
    standbyVideo.className = 'video-standby';
    videoPanel.appendChild(standbyVideo);

    // 再创建 active（在上层）
    activeVideo = document.createElement('video');
    activeVideo.autoplay = true;
    activeVideo.muted = true;
    activeVideo.playsInline = true;
    activeVideo.loop = true;
    activeVideo.className = 'video-active';
    videoPanel.appendChild(activeVideo);
  }

  // --- 判断视频元素是否正在播放内容 ---
  function isVideoPlaying(video) {
    if (!video) return false;
    var hasSrc = video.src && video.src !== '' && video.src !== window.location.href;
    var hasStream = !!(video.srcObject && video.srcObject.active);
    return (hasSrc || hasStream) && video.readyState >= 2;
  }

  // --- 重置指定 video 元素（清空 src/srcObject/事件回调） ---
  function resetSlotVideo(video) {
    if (!video) return;
    video.onended = null;
    video.onerror = null;
    video.loop = true;
    video.src = '';
    video.srcObject = null;
  }

  // --- 安全关闭 RTCPeerConnection ---
  function closePlayer(pc) {
    if (!pc) return;
    try {
      if (pc.close) pc.close();
    } catch (e) { /* 忽略 */ }
  }

  // ====================================================================
  //  WebRTC 连接工厂（接受任意 video 元素 + 错误回调）
  // ====================================================================

  function _createWebrtcConnection(video, url, onError) {
    var pc = null;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
    } catch (e) {
      console.error('WebRTC not supported:', e);
      Diag.error('video', 'WebRTC不支持', {error: e.message});
      if (typeof onError === 'function') onError(e);
      return null;
    }

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    var hasVideo = false;
    pc.ontrack = function (event) {
      if (event.track.kind === 'video' && !hasVideo) {
        hasVideo = true;
        video.srcObject = event.streams[0];
        video.play().catch(function (e) {
          Diag.warn('video', 'WebRTC自动播放被浏览器拦截', {url: url, error: e ? e.message : 'unknown'});
        });
      }
    };

    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'failed') {
        console.error('WebRTC 连接失败: ' + url);
        Diag.error('video', 'WebRTC连接失败', {url: url, connectionState: pc.connectionState});
        if (pc === activePlayer) {
          if (typeof onError === 'function') {
            onError('connection-failed');      // 走回调：解锁 + skipCooldown
          } else {
            switchLocked = false;
            failoverCamera();
          }
        } else if (typeof onError === 'function') {
          onError('connection-failed');
        }
      } else if (pc.connectionState === 'disconnected') {
        console.warn('WebRTC 连接断开: ' + url);
        Diag.warn('video', 'WebRTC连接断开', {url: url, connectionState: pc.connectionState});
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
      Diag.error('video', 'WHEP握手失败', {url: url, error: err.message});
      if (pc === activePlayer) {
        if (typeof onError === 'function') {
          onError(err);                        // 走回调：解锁 + skipCooldown
        } else {
          switchLocked = false;
          failoverCamera();
        }
      } else if (typeof onError === 'function') {
        onError(err);
      }
    });

    return pc;
  }

  // ====================================================================
  //  核心：交叉渐变切换
  // ====================================================================

  // --- CSS 渐变：active 淡出 + standby 淡入（0.5s），然后交换引用 ---
  function execCrossfade(onComplete) {
    if (!activeVideo || !standbyVideo) return;

    // 淡出旧 active
    activeVideo.classList.remove('video-active');
    activeVideo.classList.add('video-standby');

    // 淡入 standby
    standbyVideo.classList.remove('video-standby');
    standbyVideo.classList.add('video-active');

    // 等 CSS transition 完成（0.5s）
    if (crossfadeTimerId) clearTimeout(crossfadeTimerId);
    crossfadeTimerId = setTimeout(function () {
      crossfadeTimerId = null;

      // 保存旧 active 引用
      var oldVideo = activeVideo;
      var oldPlayer = activePlayer;

      // 交换引用：standby → active，旧 active → 新 standby
      activeVideo = standbyVideo;
      activePlayer = standbyPlayer;
      standbyVideo = oldVideo;
      standbyPlayer = null;

      // 销毁旧 active 的资源
      closePlayer(oldPlayer);
      resetSlotVideo(standbyVideo);

      switchLocked = false;

      // 启动新 active 的帧数看门狗
      startCameraWatchdog();

      if (typeof onComplete === 'function') onComplete();
    }, 500);
  }

  // --- 在 standby 上播放指定源，就绪后渐变切换 ---
  // 如果 active 尚无内容（首次加载），直接在 active 上播放，跳过渐变
  function playStreamOnStandby(source, onComplete) {
    if (!source) return;

    if (!standbyVideo || !activeVideo) {
      initVideoElements();
    }

    if (switchLocked) {
      console.warn('视频切换进行中，忽略新请求');
      return;
    }

    // 如果当前正在播放的就是同一个 URL，无需重连（避免交叉渐变闪烁）
    if (activeSourceUrl && source.url === activeSourceUrl && isVideoPlaying(activeVideo)) {
      console.log('源 ' + source.url + ' 已在播放，跳过切换');
      if (typeof onComplete === 'function') onComplete();
      return;
    }

    // 首次加载：active 无内容时直接播放，无需渐变
    // switchLocked 由 _playDirectOnActive 内部的 playing/error 回调负责解锁
    if (!isVideoPlaying(activeVideo)) {
      switchLocked = true;
      _playDirectOnActive(source, onComplete);
      return;
    }

    switchLocked = true;

    // 重置 standby
    resetSlotVideo(standbyVideo);
    closePlayer(standbyPlayer);
    standbyPlayer = null;

    var ready = false;
    var safetyTimeoutId = null;

    function onReady() {
      if (ready) return;
      ready = true;
      if (safetyTimeoutId) clearTimeout(safetyTimeoutId);
      activeSourceUrl = source.url;  // 记录新源 URL，用于后续同源跳过判断
      execCrossfade(onComplete);
    }

    // 监听 standby 的 'playing' 事件 — 对 WebRTC (MediaStream) 和本地文件都有效
    standbyVideo.addEventListener('playing', function () {
      // 延迟 150ms 确保首帧已渲染到屏幕
      setTimeout(onReady, 150);
    }, { once: true });

    // 8 秒安全超时：standby 始终未就绪时强制渐变（避免永久卡住）
    safetyTimeoutId = setTimeout(function () {
      console.warn('备用视频就绪超时（8秒），强制渐变');
      Diag.warn('video', '备用视频就绪超时', {url: source.url});
      onReady();
    }, 8000);

    // 错误处理：standby 连接失败 → 解锁并触发故障切换（跳过冷却，这是合法顺序切换）
    function onStandbyError(err) {
      if (ready) return;
      ready = true;
      if (safetyTimeoutId) clearTimeout(safetyTimeoutId);
      switchLocked = false;
      console.error('备用流连接失败: ' + (err || 'unknown'));
      Diag.error('video', '备用流连接失败', {url: source.url, error: String(err || '')});
      failoverCamera(true);  // skipCooldown: 这是顺序切换不是重复触发
    }

    // 在 standby 上启动播放
    standbyVideo.loop = true;

    if (source.type === 'webrtc') {
      standbyPlayer = _createWebrtcConnection(standbyVideo, source.url, onStandbyError);
    } else {
      standbyVideo.src = source.url;
      standbyVideo.onerror = function () {
        console.error('备用本地视频加载失败: ' + source.url);
        onStandbyError('local-load-error');
      };
      standbyVideo.play().catch(function (e) {
        Diag.warn('video', 'standby play() 失败', {url: source.url, error: e ? e.message : 'unknown'});
      });
    }
  }

  // --- 直接在当前 active 上播放（首次加载或无画面时的故障切换） ---
  function _playDirectOnActive(source, onComplete) {
    resetSlotVideo(activeVideo);
    closePlayer(activePlayer);
    activePlayer = null;

    activeVideo.loop = true;

    // 安全解锁定时器：如果 playing 事件 15 秒内未触发，强制解锁
    var directUnlockTimer = setTimeout(function () {
      if (switchLocked) {
        console.warn('直接连接 playing 事件超时（15秒），强制解锁');
        switchLocked = false;
      }
    }, 15000);

    function onActiveError(err) {
      // 直接连接失败 → 解锁并触发顺序故障切换（跳过冷却）
      clearTimeout(directUnlockTimer);
      if (switchLocked) switchLocked = false;
      console.error('直接连接失败: ' + (err || 'unknown'));
      Diag.error('video', '直接连接失败', {url: source.url, error: String(err || '')});
      failoverCamera(true);
    }

    // 连接成功时通过 'playing' 事件解锁
    activeVideo.addEventListener('playing', function () {
      clearTimeout(directUnlockTimer);
      if (switchLocked) switchLocked = false;
    }, { once: true });

    if (source.type === 'webrtc') {
      activePlayer = _createWebrtcConnection(activeVideo, source.url, onActiveError);
    } else {
      activeVideo.src = source.url;
      activeVideo.onerror = function () {
        if (videoState !== 'camera') return;
        console.error('本地视频加载失败: ' + source.url);
        Diag.error('video', '本地视频加载失败', {url: source.url, cameraIndex: currentCameraIndex, backupIndex: currentBackupIndex});
        onActiveError('local-load-error');
      };
      activeVideo.play().catch(function (e) {
        Diag.warn('video', 'active play() 失败', {url: source.url, error: e ? e.message : 'unknown'});
      });
    }

    videoState = 'camera';
    activeSourceUrl = source.url;  // 记录当前播放源，用于后续同源跳过判断
    startCameraWatchdog();

    if (typeof onComplete === 'function') onComplete();
  }

  // ====================================================================
  //  统一播放入口（被轮播、故障切换、恢复探测、广告返回等调用）
  // ====================================================================

  function playCameraStream(source, onComplete) {
    stopCameraWatchdog();
    videoState = 'camera';
    playStreamOnStandby(source, onComplete);
  }

  // ====================================================================
  //  故障切换 + 主画面恢复探测
  // ====================================================================

  // --- 统一故障切换入口 ---
  // 切换链：主画面 → 备1 → 备2 → … → 下一个摄像头的主画面
  // 只有一个摄像头且无备用时原地重建（保留自愈能力）
  // skipCooldown: true 时跳过冷却检查，用于连接失败后的顺序切换
  function failoverCamera(skipCooldown) {
    if (videoState !== 'camera') return;
    if (cameraList.length === 0) return;

    // 如果正在连接中（switchLocked），说明已有连接尝试在进行。
    // 此时只有该连接的错误回调（已解锁 switchLocked）才能推进故障切换。
    // 其他来源（看门狗、onconnectionstatechange）的并发调用会被阻挡，避免索引被错误修改。
    if (switchLocked) return;

    // 冷却保护：多个错误源（看门狗/连接事件/onerror）同时触发时避免切换风暴。
    // 冷却期内的触发被忽略，由持续运行的看门狗在下一轮兜底重试
    // skipCooldown 用于连接建立失败后的顺序切换——这是合法的下一步，不应被阻挡
    var now = Date.now();
    if (!skipCooldown && now < failoverCooldownUntil) return;
    failoverCooldownUntil = now + FAILOVER_COOLDOWN_MS;

    if (currentCameraIndex >= cameraList.length) currentCameraIndex = 0;
    var cam = cameraList[currentCameraIndex];
    var backups = cam.backups || [];

    failoverStats.total++;

    if (currentBackupIndex + 1 < backups.length) {
      // 还有备用流可用：切换到下一个备用
      currentBackupIndex++;
      var label = cam.label || '画面' + (currentCameraIndex + 1);
      console.warn('画面断流，切换到备用流 ' + (currentBackupIndex + 1) + '/' + backups.length +
                   '（' + label + '）');
      Diag.warn('video', '故障切换-使用备用流', {cameraIndex: currentCameraIndex, backupIndex: currentBackupIndex, label: label, url: backups[currentBackupIndex].url});
      playCameraStream(getCurrentSource());
      startRecoveryCheck();   // 开始探测主画面是否恢复
      return;
    }

    if (cameraList.length > 1) {
      // 备用用尽（或没有备用）：切换到下一个摄像头的主画面
      stopRecoveryCheck();
      var fromIndex = currentCameraIndex;
      currentCameraIndex = (currentCameraIndex + 1) % cameraList.length;
      currentBackupIndex = -1;
      var next = cameraList[currentCameraIndex];
      console.warn('备用流用尽，切换到下一个摄像头: ' + (next.label || '画面' + (currentCameraIndex + 1)));
      Diag.warn('video', '故障切换-切换摄像头', {fromIndex: fromIndex, toIndex: currentCameraIndex, label: next.label || ''});
      playCameraStream(getCurrentSource());
      return;
    }

    // 只有一个摄像头
    if (currentBackupIndex >= 0) {
      // 备用也断了：回到主画面，重试整条切换链
      stopRecoveryCheck();
      currentBackupIndex = -1;
      console.warn('备用流用尽，回到主画面重试');
      Diag.warn('video', '故障切换-重试主画面', {cameraIndex: currentCameraIndex});
      playCameraStream(getCurrentSource());
    } else {
      // 无备用：延迟 1 秒原地重建（配合冷却与看门狗自然限速）
      console.warn('画面断流，1 秒后原地重建');
      Diag.warn('video', '故障切换-原地重建', {cameraIndex: currentCameraIndex});
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
      Diag.info('video', '重建视频会话', {url: source.url, cameraIndex: currentCameraIndex});
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
          if (recoveryStableSince !== 0) {
            console.log('主画面探测中断，重新计时');
            Diag.info('video', '主画面探测中断', {cameraIndex: currentCameraIndex});
          }
          recoveryStableSince = 0;
          return;
        }
        if (recoveryStableSince === 0) {
          recoveryStableSince = Date.now();
          console.log('主画面探测可达，进入 3 分钟稳定观察期');
          Diag.info('video', '主画面探测可达', {cameraIndex: currentCameraIndex});
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
    }).catch(function (err) {
      // 记录探测失败类型（但不改变函数返回值，保持现有逻辑）
      Diag.warn('video', '主画面探测失败', {url: url, error: err.message || 'network error'});
      return false;
    });
  }

  // --- 主画面恢复：切回主画面并停止探测 ---
  function recoverToPrimary() {
    stopRecoveryCheck();
    currentBackupIndex = -1;
    if (videoState !== 'camera') return;  // 广告态防御（探测在广告期间本应已停止）
    console.log('主画面已稳定恢复 3 分钟，切回主画面');
    Diag.info('video', '主画面恢复', {cameraIndex: currentCameraIndex});
    playCameraStream(getCurrentSource());
  }

  // ====================================================================
  //  帧数看门狗（仅监控 activeVideo）
  // ====================================================================

  // --- 看门狗：解码帧数停止增长时触发故障切换 ---
  // 兜底 WebRTC connectionState 仍为 'connected' 的静默冻结等场景
  function startCameraWatchdog() {
    stopCameraWatchdog();
    var video = activeVideo;
    var stallChecks = 0;
    var lastFrameCount = -1;

    cameraWatchdogId = setInterval(function () {
      if (videoState !== 'camera' || !video || video !== activeVideo) return;

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
          Diag.error('video', '画面冻结', {cameraIndex: currentCameraIndex, stallChecks: stallChecks});
          failoverStats.freezes++;
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
    Diag.info('video', '摄像头轮播启动', {interval: interval, cameraCount: cameraList.length});
    cameraRotateTimerId = setInterval(function () {
      if (videoState !== 'camera') return;  // 广告播放期间不切换
      stopRecoveryCheck();                   // 切走后不再探测上一个摄像头的主画面
      currentCameraIndex = (currentCameraIndex + 1) % cameraList.length;
      currentBackupIndex = -1;               // 新摄像头从主画面开始
      console.log('轮播切换到画面 ' + (currentCameraIndex + 1) + '/' + cameraList.length);
      Diag.info('video', '轮播切换', {toIndex: currentCameraIndex, total: cameraList.length});
      // playCameraStream 内部使用 standby + 交叉渐变，旧画面持续显示
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
    Diag.info('ad', '摄像头计时器启动', {duration: duration});
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

  // --- 切换到广告视频（使用 standby + 交叉渐变，无黑屏） ---
  function switchToAdVideo() {
    if (adFileList.length === 0) {
      // 无广告视频 — 保持摄像头模式
      return;
    }

    if (!standbyVideo || !activeVideo) {
      initVideoElements();
      if (!standbyVideo || !activeVideo) return;
    }

    // 如果正在切换中（轮播/故障切换），延迟重试，避免与 switchLocked 冲突
    if (switchLocked) {
      console.log('广告切换被系统占用，1秒后重试');
      cameraTimerId = setTimeout(switchToAdVideo, 1000);
      return;
    }

    // 确认可以切换后才停止摄像头相关定时器
    stopCameraRotateTimer();
    stopRecoveryCheck();

    var filename = adFileList[currentAdIndex];
    var folder = config.videoFolder ? config.videoFolder + '/' : '';
    var videoUrl = '/videos/' + folder + filename;

    // 使用 standby + 渐变切换到广告
    playStreamOnStandby({ type: 'local', url: videoUrl }, function () {
      // 渐变完成，广告视频现在是 activeVideo
      activeVideo.loop = false;
      activeVideo.onended = onAdVideoEnded;
      activeVideo.onerror = onAdVideoError;

      // 确保广告视频开始播放（playStreamOnStandby 已经调了 play()，这里再确认一次）
      activeVideo.play().catch(function (err) {
        console.error('Ad video play() rejected:', err.message);
        Diag.error('ad', '广告视频播放失败', {filename: filename, error: err.message});
        currentAdIndex = (currentAdIndex + 1) % adFileList.length;
        switchToCamera();
      });

      videoState = 'ad';
      console.log('Playing ad video (' + (currentAdIndex + 1) + '/' + adFileList.length + '): ' + filename);
      Diag.info('ad', '播放广告视频', {filename: filename, index: currentAdIndex + 1, total: adFileList.length});
    });
  }

  function onAdVideoEnded() {
    console.log('Ad video ended, switching back to camera');
    Diag.info('ad', '广告视频播放结束', {index: currentAdIndex + 1, total: adFileList.length});
    currentAdIndex = (currentAdIndex + 1) % adFileList.length;
    switchToCamera();
  }

  function onAdVideoError() {
    var el = activeVideo;
    var code = el && el.error ? el.error.code : 'unknown';
    var msg = el && el.error ? el.error.message : 'unknown';
    console.error('Ad video error (code=' + code + '): ' + msg + ' — src=' + (el ? el.src : ''));
    Diag.error('ad', '广告视频播放错误', {code: code, message: msg, src: el ? el.src : ''});
    currentAdIndex = (currentAdIndex + 1) % adFileList.length;
    switchToCamera();
  }

  // --- 广告结束切回摄像头（保持故障切换后的主备状态，不重置索引） ---
  function switchToCamera() {
    videoState = 'camera';

    var source = getCurrentSource();
    if (source) {
      playCameraStream(source, function () {
        // 渐变完成，恢复摄像头相关定时器
        startCameraTimer();
        startCameraRotateTimer();
        if (currentBackupIndex >= 0) startRecoveryCheck();  // 仍在备用流上则继续探测主画面
      });
    }
  }

  // ====================================================================
  //  视频系统初始化 + 生命周期
  // ====================================================================

  var _cameraDefaultsLoading = false;  // 防止并发加载 cameras.json

  function setupVideoSystem(cfg) {
    // ── 首次启动：从预生成的 cameras.json 加载摄像头列表 ──
    if (cfg._needsCameraDefaults && cfg.videoStreams.length === 0 && !_cameraDefaultsLoading) {
      _cameraDefaultsLoading = true;
      console.log('首次启动，尝试从 cameras.json 加载摄像头配置...');
      fetch('/cameras.json')
        .then(function (resp) {
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          return resp.json();
        })
        .then(function (streams) {
          if (streams && streams.length > 0) {
            console.log('从 cameras.json 加载了 ' + streams.length + ' 个摄像头');
            cfg.videoStreams = streams;
            delete cfg._needsCameraDefaults;
            saveConfig(cfg);               // 持久化到 localStorage
            setupVideoSystem(cfg);          // 重新初始化
          }
        })
        .catch(function (err) {
          console.warn('cameras.json 加载失败（文件不存在或格式错误）:', err.message);
          Diag.warn('system', 'cameras.json加载失败', {error: err.message});
          delete cfg._needsCameraDefaults;
          // 显示占位图
          var ph = els.placeholder;
          if (ph) ph.style.display = 'flex';
        })
        .finally(function () {
          _cameraDefaultsLoading = false;
        });
      return;  // 等 fetch 完成后递归调用
    }
    // ──────────────────────────────────────────────────────────

    var area = els.videoArea;
    var placeholder = els.placeholder;
    if (!area) return;

    var newList = buildCameraList(cfg.videoStreams);

    if (newList.length === 0) {
      // 无有效摄像头 — 完全清理
      cleanupVideoSystem();
      if (videoPanel) { videoPanel.remove(); videoPanel = null; activeVideo = null; standbyVideo = null; }
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

    // 创建双 video 元素（若不存在）
    if (!activeVideo || !standbyVideo || !videoPanel || !videoPanel.parentNode) {
      initVideoElements();
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
      Diag.error('ad', '广告视频列表获取失败', {error: err.message, folder: folder});
      adFileList = [];
    });
  }

  // --- 软清理：停所有定时器，按需保留播放器，保留 DOM ---
  function cleanupVideoSystem(keepPlayer) {
    stopCameraTimer();
    stopCameraRotateTimer();
    stopRecoveryCheck();
    if (!keepPlayer) {
      // 硬清理：销毁所有播放器和交叉渐变定时器
      stopCameraWatchdog();
      if (crossfadeTimerId) { clearTimeout(crossfadeTimerId); crossfadeTimerId = null; }
      if (rebuildTimerId) { clearTimeout(rebuildTimerId); rebuildTimerId = null; }
      closePlayer(activePlayer);
      activePlayer = null;
      closePlayer(standbyPlayer);
      standbyPlayer = null;
      if (activeVideo) resetSlotVideo(activeVideo);
      if (standbyVideo) resetSlotVideo(standbyVideo);
      switchLocked = false;
      activeSourceUrl = null;
    }
    adFileList = [];
    currentAdIndex = 0;
    videoState = 'camera';
    // 注意：不移除 videoPanel / video 元素 —— setupVideoSystem 会复用，避免黑闪
  }

  // ====================================================================
  //  Data Polling (local server: GET /api/parking/status)
  // ====================================================================

  function startPolling() {
    stopPolling();
    var interval = Math.max(1, config.pollInterval || 2) * 1000;
    pollTimerId = setInterval(fetchStatus, interval);
    console.log('Data polling every ' + (config.pollInterval || 2) + 's');
    Diag.info('data', '数据轮询启动', {interval: config.pollInterval || 2});
  }

  function stopPolling() {
    if (pollTimerId) {
      clearInterval(pollTimerId);
      pollTimerId = null;
    }
  }

  async function fetchStatus() {
    try {
      // 30 秒超时控制
      var controller = new AbortController();
      var timeoutId = setTimeout(function () { controller.abort(); }, 30000);
      var resp = await fetch('/api/parking/status', { signal: controller.signal });
      clearTimeout(timeoutId);
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
        availTotal: availA + availB - 60,
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
      clearTimeout(timeoutId);
      console.error('Status poll failed:', e);
      Diag.error('data', '数据轮询失败', {error: e.message, consecutiveFailures: consecutiveFailures + 1});
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
      Diag.info('system', '配置热重载', {source: 'storage event'});
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
