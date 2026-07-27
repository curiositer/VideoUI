/* ============================================================
   管理页逻辑 — 配置表单 + 动态监控画面列表（含备用流子列表）
   ============================================================ */

(function () {
  'use strict';

  // --- 简单字段 ↔ 配置 key 映射（不含 videoStreams） ---
  var FIELD_MAP = [
    { id: 'parkingName',          key: 'parkingName',          type: 'value' },
    { id: 'parkIdA',              key: 'parkIdA',              type: 'value' },
    { id: 'parkIdB',              key: 'parkIdB',              type: 'value' },
    { id: 'pollInterval',         key: 'pollInterval',         type: 'number' },
    { id: 'videoFolder',          key: 'videoFolder',          type: 'value' },
    { id: 'cameraDuration',       key: 'cameraDuration',       type: 'number' },
    { id: 'cameraRotateInterval', key: 'cameraRotateInterval', type: 'number' },
  ];

  // 视频类型选项（仅支持 webrtc / local 两种）
  var TYPE_OPTIONS = [
    { value: 'webrtc', text: 'WebRTC 视频流（超低延迟，支持H.265）' },
    { value: 'local', text: '本地视频文件（MP4/WebM）' },
  ];

  var toast = document.getElementById('toast');
  var streamListEl = document.getElementById('video-streams-list');
  var btnAddStream = document.getElementById('btn-add-stream');
  var btnImportCameras = document.getElementById('btn-import-cameras');

  // 正在编辑的监控画面列表
  var editingStreams = [];

  // 防止并发加载 cameras.json
  var _cameraDefaultsLoading = false;
  var _eventsBound = false;

  // --- 初始化：绑定事件 + 加载配置到表单 ---
  function init() {
    bindEvents();
    var config = getConfig();
    loadConfigIntoForm(config);
  }

  // 绑定保存/重置/添加按钮事件（只执行一次）
  function bindEvents() {
    if (_eventsBound) return;
    _eventsBound = true;
    document.getElementById('btn-save').addEventListener('click', onSave);
    document.getElementById('btn-reset').addEventListener('click', onReset);
    btnAddStream.addEventListener('click', onAddStream);
    if (btnImportCameras) {
      btnImportCameras.addEventListener('click', onImportCameras);
    }
  }

  // 加载配置到表单（如果首次使用则先从 cameras.json 加载摄像头列表）
  function loadConfigIntoForm(config) {
    if (config._needsCameraDefaults && config.videoStreams.length === 0 && !_cameraDefaultsLoading) {
      _cameraDefaultsLoading = true;
      console.log('首次启动，尝试从 cameras.json 加载摄像头配置...');
      fetch('/cameras.json')
        .then(function (resp) {
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          return resp.json();
        })
        .then(function (streams) {
          if (streams && streams.length > 0) {
            console.log('从 cameras.json 加载了 ' + streams.length + ' 个摄像头（含备用流）');
            config.videoStreams = streams;
            delete config._needsCameraDefaults;
            saveConfig(config);               // 持久化到 localStorage
            populateForm(config);
            renderStreamList(config.videoStreams || []);
          } else {
            populateForm(config);
            renderStreamList(config.videoStreams || []);
          }
        })
        .catch(function (err) {
          console.warn('cameras.json 加载失败（文件不存在或格式错误）:', err.message);
          delete config._needsCameraDefaults;
          populateForm(config);
          renderStreamList(config.videoStreams || []);
        })
        .finally(function () {
          _cameraDefaultsLoading = false;
        });
      return;  // 等 fetch 完成后填充表单
    }

    populateForm(config);
    renderStreamList(config.videoStreams || []);
  }

  function populateForm(config) {
    FIELD_MAP.forEach(function (item) {
      var el = document.getElementById(item.id);
      if (!el) return;
      el.value = config[item.key] != null ? config[item.key] : '';
    });
  }

  // --- 类型规范化：旧类型（hls/flv/iframe）回落到 webrtc ---
  function normalizeType(t) {
    return t === 'local' ? 'local' : 'webrtc';
  }

  // ====================================================================
  //  监控画面列表 — 动态增删（每个画面含备用流子列表）
  // ====================================================================

  function renderStreamList(streams) {
    editingStreams = (streams || []).map(function (s) {
      return {
        url: s.url || '',
        type: normalizeType(s.type),
        label: s.label || '',
        backups: (s.backups || []).map(function (b) {
          return { url: b.url || '', type: normalizeType(b.type) };
        }),
      };
    });

    streamListEl.innerHTML = '';

    editingStreams.forEach(function (_, idx) {
      streamListEl.appendChild(createStreamRow(idx));
    });
  }

  function createStreamRow(idx) {
    var stream = editingStreams[idx];
    var row = document.createElement('div');
    row.className = 'stream-row';
    row.id = 'stream-row-' + idx;

    // 标题行：序号 + 删除按钮
    var header = document.createElement('div');
    header.className = 'stream-header';

    var indexLabel = document.createElement('span');
    indexLabel.className = 'stream-index';
    indexLabel.textContent = '监控画面 ' + (idx + 1);

    var btnRemove = document.createElement('button');
    btnRemove.className = 'btn-remove';
    btnRemove.type = 'button';
    btnRemove.textContent = '✕ 删除';
    btnRemove.addEventListener('click', function () { onRemoveStream(idx); });

    header.appendChild(indexLabel);
    header.appendChild(btnRemove);

    // 画面名称
    var grpLabel = createFieldGroup('画面名称', 'text', 'stream-label-' + idx, stream.label,
      '如：停车场入口 / 停车楼一层');
    // 主画面类型
    var grpType = createSelectGroup('视频类型', 'stream-type-' + idx, TYPE_OPTIONS, stream.type);
    // 主画面地址
    var grpUrl = createFieldGroup('视频地址', 'text', 'stream-url-' + idx, stream.url,
      'WebRTC：/webrtc/xxx（经 Nginx 代理到 MediaMTX） | 本地：/videos/xxx.mp4');

    row.appendChild(header);
    row.appendChild(grpLabel);
    row.appendChild(grpType);
    row.appendChild(grpUrl);

    // 备用流子列表
    var backupSection = document.createElement('div');
    backupSection.className = 'backup-list';
    backupSection.id = 'backup-list-' + idx;

    var backupTitle = document.createElement('div');
    backupTitle.className = 'backup-title';
    backupTitle.textContent = '备用视频流（主画面断流时依次自动切换，主画面恢复 3 分钟后自动切回）';
    backupSection.appendChild(backupTitle);

    stream.backups.forEach(function (_, bIdx) {
      backupSection.appendChild(createBackupRow(idx, bIdx));
    });

    var btnAddBackup = document.createElement('button');
    btnAddBackup.className = 'btn-add-backup';
    btnAddBackup.type = 'button';
    btnAddBackup.textContent = '＋ 添加备用流';
    btnAddBackup.addEventListener('click', function () { onAddBackup(idx); });
    backupSection.appendChild(btnAddBackup);

    row.appendChild(backupSection);

    return row;
  }

  // --- 单条备用流行：序号 + 删除 + 类型 + 地址 ---
  function createBackupRow(idx, bIdx) {
    var backup = editingStreams[idx].backups[bIdx];
    var row = document.createElement('div');
    row.className = 'backup-row';
    row.id = 'backup-row-' + idx + '-' + bIdx;

    var header = document.createElement('div');
    header.className = 'stream-header';

    var indexLabel = document.createElement('span');
    indexLabel.className = 'backup-index';
    indexLabel.textContent = '备用流 ' + (bIdx + 1);

    var btnRemove = document.createElement('button');
    btnRemove.className = 'btn-remove';
    btnRemove.type = 'button';
    btnRemove.textContent = '✕ 删除';
    btnRemove.addEventListener('click', function () { onRemoveBackup(idx, bIdx); });

    header.appendChild(indexLabel);
    header.appendChild(btnRemove);

    var grpType = createSelectGroup('备用类型', 'backup-type-' + idx + '-' + bIdx,
      TYPE_OPTIONS, backup.type);
    var grpUrl = createFieldGroup('备用地址', 'text', 'backup-url-' + idx + '-' + bIdx,
      backup.url, 'WebRTC：/webrtc/xxx | 本地：/videos/xxx.mp4');

    row.appendChild(header);
    row.appendChild(grpType);
    row.appendChild(grpUrl);

    return row;
  }

  function createFieldGroup(labelText, inputType, id, value, hint) {
    var grp = document.createElement('div');
    grp.className = 'form-group';

    var label = document.createElement('label');
    label.textContent = labelText;
    if (id) label.setAttribute('for', id);

    var input = document.createElement('input');
    input.type = inputType;
    if (id) input.id = id;
    input.value = value || '';
    if (hint) input.placeholder = '';

    grp.appendChild(label);
    grp.appendChild(input);

    if (hint) {
      var hintEl = document.createElement('span');
      hintEl.className = 'hint';
      hintEl.textContent = hint;
      grp.appendChild(hintEl);
    }

    return grp;
  }

  function createSelectGroup(labelText, id, options, selectedValue) {
    var grp = document.createElement('div');
    grp.className = 'form-group';

    var label = document.createElement('label');
    label.textContent = labelText;
    if (id) label.setAttribute('for', id);

    var select = document.createElement('select');
    if (id) select.id = id;

    options.forEach(function (opt) {
      var optionEl = document.createElement('option');
      optionEl.value = opt.value;
      optionEl.textContent = opt.text;
      if (opt.value === selectedValue) optionEl.selected = true;
      select.appendChild(optionEl);
    });

    grp.appendChild(label);
    grp.appendChild(select);

    return grp;
  }

  function onAddStream() {
    collectStreamValues();
    editingStreams.push({ url: '', type: 'webrtc', label: '', backups: [] });
    renderStreamList(editingStreams);
  }

  function onRemoveStream(idx) {
    collectStreamValues();
    editingStreams.splice(idx, 1);
    renderStreamList(editingStreams);
  }

  function onAddBackup(idx) {
    collectStreamValues();
    editingStreams[idx].backups.push({ url: '', type: 'webrtc' });
    renderStreamList(editingStreams);
  }

  function onRemoveBackup(idx, bIdx) {
    collectStreamValues();
    editingStreams[idx].backups.splice(bIdx, 1);
    renderStreamList(editingStreams);
  }

  // --- 重新渲染前先从 DOM 收集当前值，避免丢失未保存的编辑 ---
  function collectStreamValues() {
    editingStreams.forEach(function (stream, idx) {
      var urlEl = document.getElementById('stream-url-' + idx);
      var typeEl = document.getElementById('stream-type-' + idx);
      var labelEl = document.getElementById('stream-label-' + idx);
      if (urlEl) stream.url = urlEl.value;
      if (typeEl) stream.type = typeEl.value;
      if (labelEl) stream.label = labelEl.value;

      stream.backups.forEach(function (backup, bIdx) {
        var bUrlEl = document.getElementById('backup-url-' + idx + '-' + bIdx);
        var bTypeEl = document.getElementById('backup-type-' + idx + '-' + bIdx);
        if (bUrlEl) backup.url = bUrlEl.value;
        if (bTypeEl) backup.type = bTypeEl.value;
      });
    });
  }

  // ====================================================================
  //  保存 / 重置
  // ====================================================================

  function collectForm() {
    var config = {};

    // 简单字段
    FIELD_MAP.forEach(function (item) {
      var el = document.getElementById(item.id);
      if (!el) return;
      if (item.type === 'number') {
        config[item.key] = parseInt(el.value, 10) || 0;
      } else {
        config[item.key] = el.value;
      }
    });

    // 监控画面列表 — 先从 DOM 读取最新值
    collectStreamValues();
    config.videoStreams = editingStreams.map(function (s) {
      return {
        url: s.url || '',
        type: s.type || 'webrtc',
        label: s.label || '',
        // 过滤掉地址为空的备用流
        backups: (s.backups || []).filter(function (b) {
          return b.url && b.url.trim();
        }).map(function (b) {
          return { url: b.url, type: b.type || 'webrtc' };
        }),
      };
    });

    return config;
  }

  function onSave() {
    var config = collectForm();
    saveConfig(config);
    showToast('配置已保存 ✓  返回大屏页面即可看到更新');
  }

  function onReset() {
    if (!confirm('确定要恢复默认配置吗？当前设置（包括监控画面列表）将被清除。')) return;
    resetConfig();
    var defaults = getConfig();
    // 通过 loadConfigIntoForm 加载，首次使用会自动从 cameras.json 导入摄像头（含备用流）
    loadConfigIntoForm(defaults);
    showToast('已恢复默认配置');
  }

  function onImportCameras() {
    if (!confirm('确定要从 config.json 重新导入摄像头配置吗？\n\n当前未保存的编辑将丢失，其他设置（轮播间隔、广告视频等）不受影响。')) return;

    _cameraDefaultsLoading = false;  // 重置锁，允许重新加载
    var config = getConfig();
    // 强制设置标志位，触发 cameras.json 加载
    config._needsCameraDefaults = true;
    config.videoStreams = [];
    loadConfigIntoForm(config);
    showToast('正在从 config.json 导入摄像头...');
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(function () { toast.classList.remove('show'); }, 2500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
