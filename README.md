# Parking Display Screen — 停车场大屏展示

9:4 宽屏停车场实时监控展示页面，面向游客，无需登录。

## 快速开始

直接用浏览器打开 `index.html`，或用任意静态文件服务托管：

```bash
# Python 3
python -m http.server 8080

# Node.js
npx serve .
```

打开 <http://localhost:8080> 查看大屏展示页，<http://localhost:8080/admin.html> 进入配置管理页。

## 页面布局

```
┌──────────────────────────────────┐
│  A 停车场     │  B 停车场        │  ← 车位数量（总数+空闲）
│  空闲: 128    │  空闲: 96        │
├────────────────┼─────────────────┤
│                │                 │
│  A 监控画面    │  B 监控画面      │  ← 实时视频流
│                │                 │
└──────────────────────────────────┘
  ←─────── 9 : 4 ────────────────→
```

## 配置说明

所有配置通过 `admin.html` 页面进行，保存在浏览器 localStorage 中。

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| 数据刷新间隔 | 车位数据轮询秒数 | 10s |
| 接口模式 | separate=两个接口 / combined=一个接口 | separate |
| API URL (A/B) | 各停车场数据接口地址 | /api/parking/a, /api/parking/b |
| 合并接口 URL | 统一返回全部数据的接口 | /api/parking/all |
| 视频 URL (A/B) | 监控画面地址 | （空，显示占位） |
| 视频嵌入方式 | iframe（摄像头网页）/ hls（.m3u8流） | iframe |

## 数据接口格式

### 独立模式 (separate)

每个接口返回：

```json
{ "total": 200, "available": 45 }
```

### 合并模式 (combined)

单个接口返回：

```json
{
  "a": { "total": 200, "available": 45 },
  "b": { "total": 150, "available": 32 }
}
```

## 文件结构

```
VideoUI/
├── index.html      # 大屏展示页
├── admin.html      # 配置管理页
├── css/
│   └── style.css   # 样式
├── js/
│   ├── config.js   # 配置读写（localStorage）
│   ├── main.js     # 大屏逻辑（轮询、渲染）
│   └── admin.js    # 管理页表单逻辑
└── README.md
```

## 浏览器兼容

支持所有现代浏览器（Chrome、Edge、Firefox、Safari）。

> **提示**：监控视频流可能涉及跨域问题。如使用 iframe 方式嵌入摄像头页面，需确保摄像头服务允许被嵌入（X-Frame-Options）。
