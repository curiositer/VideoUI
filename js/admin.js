/* ============================================================
   Admin Page Logic — config form with dynamic video stream list
   ============================================================ */

(function () {
  'use strict';

  // --- Simple field ↔ config key mapping (excludes videoStreams) ---
  var FIELD_MAP = [
    { id: 'parkingName',       key: 'parkingName',       type: 'value' },
    { id: 'parkIdA',           key: 'parkIdA',           type: 'value' },
    { id: 'parkIdB',           key: 'parkIdB',           type: 'value' },
    { id: 'pollInterval',      key: 'pollInterval',      type: 'number' },
    { id: 'videoSwitchInterval', key: 'videoSwitchInterval', type: 'number' },
  ];

  var toast = document.getElementById('toast');
  var streamListEl = document.getElementById('video-streams-list');
  var btnAddStream = document.getElementById('btn-add-stream');

  // Current video streams being edited
  var editingStreams = [];

  // --- Init: populate form from current config ---
  function init() {
    var config = getConfig();
    populateForm(config);
    renderStreamList(config.videoStreams || []);

    document.getElementById('btn-save').addEventListener('click', onSave);
    document.getElementById('btn-reset').addEventListener('click', onReset);
    btnAddStream.addEventListener('click', onAddStream);
  }

  function populateForm(config) {
    FIELD_MAP.forEach(function (item) {
      var el = document.getElementById(item.id);
      if (!el) return;
      if (item.type === 'number') {
        el.value = config[item.key] != null ? config[item.key] : '';
      } else {
        el.value = config[item.key] != null ? config[item.key] : '';
      }
    });
  }

  // ====================================================================
  //  Video Stream List — dynamic add/remove
  // ====================================================================

  function renderStreamList(streams) {
    editingStreams = (streams || []).map(function (s) {
      return {
        url: s.url || '',
        type: s.type || 'iframe',
        label: s.label || '',
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

    // Header with index + remove button
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

    // Label field
    var grpLabel = createFieldGroup('画面名称', 'text', 'stream-label-' + idx, stream.label,
      '如：停车场入口 / 停车楼一层');
    // Type field
    var grpType = createSelectGroup('视频类型', 'stream-type-' + idx,
      [
	        { value: 'iframe', text: 'iframe（IP 摄像头网页）' },
	        { value: 'hls', text: 'HLS 视频流（.m3u8）' },
	        { value: 'flv', text: 'HTTP-FLV 视频流（推荐，需 MediaMTX）' },
	      ],
      stream.type);
    // URL field
    var grpUrl = createFieldGroup('视频地址', 'text', 'stream-url-' + idx, stream.url,
      'iframe：IP 摄像头网页地址 | HLS：.m3u8 流地址 | FLV：HTTP-FLV 地址（http://host:8887/path）');

    row.appendChild(header);
    row.appendChild(grpLabel);
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
    editingStreams.push({ url: '', type: 'iframe', label: '' });
    refreshStreamList();
  }

  function onRemoveStream(idx) {
    editingStreams.splice(idx, 1);
    refreshStreamList();
  }

  function refreshStreamList() {
    // Read current values from DOM before re-rendering
    collectStreamValues();
    renderStreamList(editingStreams);
  }

  function collectStreamValues() {
    // Update editingStreams from current DOM inputs
    editingStreams.forEach(function (_, idx) {
      var urlEl = document.getElementById('stream-url-' + idx);
      var typeEl = document.getElementById('stream-type-' + idx);
      var labelEl = document.getElementById('stream-label-' + idx);
      if (urlEl) editingStreams[idx].url = urlEl.value;
      if (typeEl) editingStreams[idx].type = typeEl.value;
      if (labelEl) editingStreams[idx].label = labelEl.value;
    });
  }

  // ====================================================================
  //  Save / Reset
  // ====================================================================

  function collectForm() {
    var config = {};

    // Simple fields
    FIELD_MAP.forEach(function (item) {
      var el = document.getElementById(item.id);
      if (!el) return;
      if (item.type === 'number') {
        config[item.key] = parseInt(el.value, 10) || 0;
      } else {
        config[item.key] = el.value;
      }
    });

    // Video streams — read current DOM values first
    collectStreamValues();
    config.videoStreams = editingStreams.map(function (s) {
      return {
        url: s.url || '',
        type: s.type || 'iframe',
        label: s.label || '',
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
    populateForm(defaults);
    renderStreamList(defaults.videoStreams || []);
    showToast('已恢复默认配置');
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
