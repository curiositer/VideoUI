/* ============================================================
   Admin Page Logic — config form management
   ============================================================ */

(function () {
  'use strict';

  // --- Form field ↔ config key mapping ---
  const FIELD_MAP = [
    { id: 'rotationInterval', key: 'rotationInterval', type: 'number' },
    { id: 'apiMode',          key: 'apiMode',          type: 'value' },
    { id: 'apiUrlA',          key: 'apiUrlA',          type: 'value' },
    { id: 'apiUrlB',          key: 'apiUrlB',          type: 'value' },
    { id: 'combinedApiUrl',   key: 'combinedApiUrl',   type: 'value' },
    { id: 'videoUrlA',        key: 'videoUrlA',        type: 'value' },
    { id: 'videoUrlB',        key: 'videoUrlB',        type: 'value' },
    { id: 'videoType',        key: 'videoType',        type: 'value' },
    { id: 'parkingNameA',     key: 'parkingNameA',     type: 'value' },
    { id: 'parkingNameB',     key: 'parkingNameB',     type: 'value' },
  ];

  const apiModeSelect = document.getElementById('apiMode');
  const separateFields = document.getElementById('separate-fields');
  const combinedFields = document.getElementById('combined-fields');
  const toast = document.getElementById('toast');

  // --- Init: populate form from current config ---
  function init() {
    const config = getConfig();
    populateForm(config);
    toggleApiMode();

    apiModeSelect.addEventListener('change', toggleApiMode);

    document.getElementById('btn-save').addEventListener('click', onSave);
    document.getElementById('btn-reset').addEventListener('click', onReset);
  }

  function populateForm(config) {
    FIELD_MAP.forEach(({ id, key, type }) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (type === 'number') {
        el.value = config[key] ?? '';
      } else {
        el.value = config[key] ?? '';
      }
    });
  }

  function collectForm() {
    const config = {};
    FIELD_MAP.forEach(({ id, key, type }) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (type === 'number') {
        config[key] = parseInt(el.value, 10) || 10;
      } else {
        config[key] = el.value;
      }
    });
    // Keep updateInterval in sync for backward compatibility
    config.updateInterval = config.rotationInterval;
    return config;
  }

  function toggleApiMode() {
    const mode = apiModeSelect.value;
    if (mode === 'combined') {
      separateFields.style.display = 'none';
      combinedFields.style.display = 'block';
    } else {
      separateFields.style.display = 'block';
      combinedFields.style.display = 'none';
    }
  }

  function onSave() {
    const config = collectForm();
    saveConfig(config);
    showToast('配置已保存 ✓  返回大屏页面即可看到更新');
  }

  function onReset() {
    if (!confirm('确定要恢复默认配置吗？当前设置将被清除。')) return;
    resetConfig();
    const defaults = getConfig();
    populateForm(defaults);
    toggleApiMode();
    showToast('已恢复默认配置');
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
