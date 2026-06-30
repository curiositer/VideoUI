# 停车场大屏实时监控

9:4 宽屏停车场实时监控展示页面，面向户外大屏游客场景，无需登录，纯静态部署。

## 页面布局

```
┌────────────────────────────┬──────────┐
│                            │ A 停车场  │
│                            │          │
│       监控画面              │ 空闲 128 │  ← 绿色
│    （A/B 10秒轮换）          │ 总 200   │  ← 红色
│                            │          │
│                            │   个     │
└────────────────────────────┴──────────┘
  ←──────── 3/4 ────────→  ←── 1/4 ──→
```

- **左 3/4**：实时监控画面，A/B 停车场自动轮换
- **右 1/4**：当前停车场名称 + 空闲车位（绿色大字）+ 总车位（红色大字）
- **轮换间隔**：默认 10 秒，可在管理页配置

## 本地安装部署

### 方式一：Python 内置服务器（推荐）

```bash
# 进入项目目录
cd VideoUI

# Python 3.x
python -m http.server 8080

# 浏览器打开
# 大屏展示页：http://localhost:8080
# 配置管理页：http://localhost:8080/admin.html
```

### 方式二：Node.js

```bash
# 安装 serve（仅首次）
npm install -g serve

# 启动
cd VideoUI
npx serve .

# 浏览器打开 http://localhost:8080
```

### 方式三：任意静态文件服务器

将整个 `VideoUI/` 目录部署到 Nginx、Apache、IIS 等任意 Web 服务器的静态目录即可。

### Nginx 示例

```nginx
server {
    listen 80;
    server_name parking.example.com;

    root /var/www/VideoUI;
    index index.html;

    # 如后端 API 在同域，可配置反向代理
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
    }
}
```

## 配置管理

打开 `admin.html` 页面进行配置，所有设置保存在浏览器 localStorage 中。

| 配置项 | 说明 | 默认值 |
|---|---|---|
| A/B 切换间隔 | 两个停车场轮换及数据刷新间隔（秒） | 10 |
| 接口模式 | separate=两个独立接口 / combined=一个合并接口 | separate |
| API URL (A/B) | 各停车场数据接口地址 | /api/parking/a, /api/parking/b |
| 合并接口 URL | 统一返回全部数据的接口 | /api/parking/all |
| 视频 URL (A/B) | 监控画面地址（IP 摄像头网页或 .m3u8 流） | 空（显示占位符） |
| 视频嵌入方式 | iframe（摄像头网页）/ hls（.m3u8 流） | iframe |
| 车场显示名称 | 卡片上显示的名称 | A 停车场 / B 停车楼 |

## 数据接口格式

### 独立模式 (separate)

A/B 各一个接口，返回：

```json
{ "total": 200, "available": 45 }
```

### 合并模式 (combined)

一个接口返回全部：

```json
{
  "a": { "total": 200, "available": 45 },
  "b": { "total": 150, "available": 32 }
}
```

## 工作流程

1. 页面加载 → 默认显示 A 停车场（视频 + 车位信息）
2. 立即拉取 A 车场数据
3. 等待切换间隔（默认 10s）→ 自动切换到 B 停车场
4. 切换时更新视频画面 + 车位数据
5. 循环往复，管理页修改配置实时生效（跨标签页）

## 错误处理

- 接口超时 5 秒
- 单次失败保留上次有效值
- 连续 3 次失败 → 显示 `--`，状态指示灯变红
- 恢复后自动切回正常显示
- A/B 各自独立追踪错误状态，A 失败不影响 B

## 文件结构

```
VideoUI/
├── index.html      # 大屏展示页
├── admin.html      # 配置管理页
├── css/
│   └── style.css   # 样式（9:4 自适应、户外大字体）
├── js/
│   ├── config.js   # 配置读写（localStorage）
│   ├── main.js     # 大屏逻辑（轮换、数据拉取、动画）
│   └── admin.js    # 管理页表单逻辑
└── README.md
```

## 浏览器兼容

支持所有现代浏览器（Chrome、Edge、Firefox、Safari）。

> **提示**：监控视频流可能涉及跨域问题。如使用 iframe 嵌入摄像头页面，需确保摄像头服务允许被嵌入（`X-Frame-Options`）。HLS 流（.m3u8）在非 Safari 浏览器上可能需要 HLS.js 播放器支持。
