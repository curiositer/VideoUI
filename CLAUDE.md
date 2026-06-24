# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

停车场大屏展示页面 — 面向游客的 9:4 宽屏实时监控画面。四象限布局：上部显示 A/B 停车场车位数量（总数+空闲），下部嵌入 A/B 停车场监控视频流。纯静态页面，无登录，无后端依赖。

## 常用命令

```bash
# 本地开发预览
python -m http.server 8080

# 或用 Node.js
npx serve .
```

浏览器打开 `http://localhost:8080` 查看大屏，`http://localhost:8080/admin.html` 进入配置管理。

## 架构

```
index.html          → 主展示页，2×2 CSS Grid 布局
admin.html          → 配置管理页，所有设置写入 localStorage
css/style.css       → 全局样式：9:4 自适应容器、卡片、视频面板、管理页表单
js/config.js        → 配置读写模块：getConfig() / saveConfig() / resetConfig()
js/main.js          → 主屏逻辑：定时拉取车位数据、数字动画、视频源加载、错误降级
js/admin.js         → 管理页表单：加载当前配置、保存、重置
```

### 数据流

1. `admin.html` 保存配置 → `localStorage`(`parking_display_config`)
2. `index.html` 加载时 `getConfig()` 读取配置
3. `main.js` 按 `updateInterval` 秒轮询 API → 更新 DOM
4. 配置在另一标签页修改时，`main.js` 通过 `storage` 事件自动热重载

### API 约定

- **独立模式**：两个接口各自返回 `{ total: number, available: number }`
- **合并模式**：一个接口返回 `{ a: { total, available }, b: { total, available } }`
- 配置项 `apiMode` 控制模式切换

### 错误处理策略

- 接口超时 5 秒（AbortController）
- 单次失败保留上次有效值
- 连续 3 次失败 → 显示 "--"，状态指示点变红
- 恢复后自动切回正常显示
