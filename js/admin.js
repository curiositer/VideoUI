/* ============================================================
   Admin Page Logic — config form management
   ============================================================ */

(function () {
  'use strict';

  // --- Form field ↔ config key mapping ---
  const FIELD_MAP = [
    { id: 'parkingName',  key: 'parkingName',  type: 'value' },
    { id: 'parkIdA',      key: 'parkIdA',      type: 'value' },
    { id: 'parkIdB',      key: 'parkIdB',      type: 'value' },
    { id: 'pollInterval', key: 'pollInterval', type: 'number' },
    { id: 'videoUrl',     key: 'videoUrl',     type: 'value' },
    { id: 'videoType',    key: 'videoType',    type: 'value' },
  ];

  const toast = document.getElementById('toast');

  // --- Init: populate form from current config ---
  function init() {
    const config = getConfig();
    populateForm(config);

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
        config[key] = parseInt(el.value, 10) || 0;
      } else {
        config[key] = el.value;
      }
    });
    return config;
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
