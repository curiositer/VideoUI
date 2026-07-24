# 停车场大屏实时监控

9:4 宽屏停车场实时监控展示页面，面向户外大屏游客场景，无需登录。

## 页面布局

```
┌────────────────────────────┬──────────────┐
│                            │ xxxx景区     │
│                            │ 游客中心停车场│
│                            │              │
│       监控画面              │ 总停车位 1000│ ← 红色
│                            │              │
│                            │ 总空闲车位   │ ← 绿色
│                            │    1098      │
└────────────────────────────┴──────────────┘
  ←──────── 3/4 ────────→  ←─── 1/4 ───→
```

- **左 3/4**：实时监控画面（WebRTC 超低延迟 / 本地视频）
- **右 1/4**：停车场名称 + 总停车位（红色）+ 总空闲车位（绿色）
- 总停车位 = 停车场 A + 停车楼 B 的总车位数之和
- 总空闲车位 = 停车场 A + 停车楼 B 的空闲车位数之和

## 架构

```
海康摄像头 ──RTSP──→ MediaMTX (单进程) ─WebRTC─→ Nginx :80 (反向代理) ──→ Chrome 全屏
 rtsp://ip:port        :8889 (WHEP)         统一入口消除跨域            kiosk 模式
 /Streaming/Channels/101                           ├─ /        → Python :3000 (页面+API)
                                                   ├─ /webrtc/ → WebRTC (WHEP) 信令
                                                   └─ /videos/ → 本地 MP4 文件

停车场客户端 → POST /parking → server.py (内存存储) ← GET /api/parking/status ← 前端轮询
```

- **MediaMTX**：将 RTSP 视频流通过 WHEP 协议以 WebRTC 转发，延迟通常在 1 秒以内
- **Nginx**：反向代理统一入口 `:80`，消除跨域问题
- **server.py**：Python 内置模块实现的 HTTP 服务端，零外部依赖
  - 接收停车场客户端 POST 上报的车位数据
  - 按 parkid 分别存储，供前端轮询
  - 同时托管静态文件（index.html / admin.html / status.html / css / js）
- **前端**：纯静态页面，轮询本地服务端获取最新数据
  - WebRTC (WHEP) 播放实时视频流，支持 H.265（依赖系统硬解）
  - 本地视频文件通过原生 `<video>` 标签播放
- 停车场客户端在车位变动时主动 POST，无需前端配置外部 API 地址

## 快速启动

### 1. 启动服务端

```bash
cd D:\AI\VideoUI

# 默认启动（parkid-a=20210001, parkid-b=20210002, port=8080）
python server.py

# 自定义参数（配合 Nginx 反向代理时使用 3000 端口）
python server.py --port 3000 --parkid-a 20210001 --parkid-b 20210002 --video-dir D:\videos
```

### 2. 配置并启动 MediaMTX

从 [MediaMTX Releases](https://github.com/bluenviron/mediamtx/releases) 下载 Windows 版本，将项目中的 `mediamtx.yml.example` 复制为 `mediamtx.yml`，修改 RTSP 摄像头地址和账号密码后启动：

```bash
mediamtx.exe
```

### 3. 配置并启动 Nginx

将项目中的 `nginx.conf` 复制到 Nginx 安装目录的 `conf/` 下，启动：

```bash
nginx.exe
```

### 4. 打开大屏

浏览器打开：
- 大屏展示页：`http://localhost`（通过 Nginx 统一入口）
- 配置管理页：`http://localhost:3000/admin.html`
- 运行诊断页：`http://localhost:3000/status.html`

## RTSP 摄像头接入流程

浏览器无法直接播放 RTSP。使用 **MediaMTX** 接收 RTSP 流并通过 **WHEP 协议**以 WebRTC 转发，Nginx 反向代理统一到 `:80`。

### 原理

```
RTSP 摄像头 → MediaMTX → WHEP (http://localhost:8889/<path>/whep) → Nginx (:80) → 浏览器 WebRTC
```

### 步骤

1. 下载 MediaMTX，将 `mediamtx.yml.example` 复制为 `mediamtx.yml`
2. 修改 `mediamtx.yml` 中 `paths` 下的摄像头 RTSP 地址
3. 启动 MediaMTX，WHEP 信令地址为 `http://localhost:8889/<path>/whep`
4. 启动 Nginx（`/webrtc/` 代理到 `:8889`）
5. 在 admin.html 中添加监控画面：
   - 视频类型选 **WebRTC**
   - 视频地址填 `/webrtc/<path>`（相对路径，经 Nginx 代理）
   - 例如：`/webrtc/entrance`

### 常见摄像头 RTSP URL 格式

| 品牌 | RTSP 地址格式 |
|------|-------------|
| 海康威视 | `rtsp://username:password@ip:554/Streaming/Channels/101` |
| 大华 | `rtsp://username:password@ip:554/cam/realmonitor?channel=1&subtype=0` |
| 宇视 | `rtsp://username:password@ip:554/media/video1` |
| 通用 ONVIF | `rtsp://username:password@ip:554/onvif1` |

## 视频播放模式

左侧视频区域只有一个画面，支持以下功能：

### 多摄像头轮播

`videoStreams` 中所有有效流构成摄像头列表，按 `cameraRotateInterval` 秒（默认 30）循环切换。间隔为 0 或只有一个摄像头时固定播放。

### 主备故障切换

每个摄像头可配多个备用流（`backups` 列表）。当前画面断流时按链切换：`主画面 → 备1 → 备2 → … → 下一个摄像头的主画面`。只有一个摄像头且无备用时原地重建（自愈）。

触发条件：
- 帧数看门狗检测到约 20 秒无新帧
- WebRTC 连接失败
- WHEP 握手失败
- 本地视频加载失败

### 主画面自动恢复

使用备用流期间每 15 秒 HTTP HEAD 探测主画面，持续可达满 3 分钟 → 自动切回主画面。

### 广告视频交替播放

配置 `videoFolder`（`/videos/` 下的子文件夹）后，系统按以下节奏交替：

```
摄像头轮播(cameraDuration 秒) → 广告视频1 → 摄像头轮播 → 广告视频2 → ...（循环）
```

- `cameraDuration`（默认 300 秒）控制摄像头持续显示时间
- 视频文件按文件名排序，支持 `.mp4` / `.webm` / `.mkv`

### 视频流类型

| 类型 | 说明 | URL 格式 | 依赖 |
|------|------|----------|------|
| `webrtc` | WebRTC 视频流（WHEP，超低延迟，支持 H.265） | `/webrtc/<path>` | MediaMTX + Nginx |
| `local` | 本地视频文件（MP4/WebM），原生 `<video>` 循环播放 | `/videos/<filename>` | Nginx 静态文件 |

> 使用 Nginx 反向代理后，所有类型均使用**相对路径**，不写 `localhost:8889`，以消除跨域。

## API 约定

### POST /parking

停车场客户端上报车位数据：

```bash
curl -X POST http://localhost:3000/parking \
  -H "Content-Type: application/json" \
  -d '{
    "service": "parkingspace",
    "parkid": "20210001",
    "spacetotal": 1000,
    "spaceLeft": 978,
    "spaceused": 22,
    "time": "2021-02-01 18:24:25",
    "remark": ""
  }'
```

| 字段 | 类型 | 说明 |
|------|------|------|
| service | string | 固定值 `"parkingspace"` |
| parkid | string | 车场唯一标识，用于区分停车场 / 停车楼 |
| spacetotal | number | 总车位数 |
| spaceLeft | number | 空闲车位数 |
| spaceused | number | 已用车位数（可选） |
| time | string | 上报时间（可选） |
| remark | string | 备注（可选） |

### GET /api/parking/status

前端轮询，返回两个车场的最新数据：

```json
{
  "a": { "total": 1000, "available": 978 },
  "b": { "total": 500, "available": 120 }
}
```

- `a` / `b` 分别对应 `--parkid-a`（停车场）/ `--parkid-b`（停车楼）
- 某车场尚未收到上报时对应值为 `null`

### GET /api/video-list?folder=\<subfolder\>

列出视频目录中的文件，返回 `["file1.mp4", ...]`。

### GET /api/health

综合健康检查，返回服务运行时长、车位数据状态、今日诊断统计等。

### POST /api/diagnostics

前端批量上报诊断事件（fire-and-forget）。

### GET /api/diagnostics?date=\<YYYY-MM-DD\>

查询指定日期的诊断事件列表。

## 配置管理

打开 `admin.html` 页面进行配置，所有设置保存在浏览器 localStorage 中。

| 配置项 | 说明 | 默认值 |
|---|---|---|
| 景区名称 | 大屏顶部显示的停车场名称 | xxxx景区游客中心停车场 |
| 停车场 ParkID | 需与服务端 --parkid-a 一致 | 20210001 |
| 停车楼 ParkID | 需与服务端 --parkid-b 一致 | 20210002 |
| 数据刷新间隔 | 前端轮询频率（秒） | 2 |
| 监控画面 | 多路视频流列表，每路含名称/类型/地址/备用流 | 空 |
| 摄像头轮播间隔 | 多画面轮播切换间隔（秒），0=不轮播 | 30 |
| 视频文件夹 | `/videos/` 下的广告视频子文件夹，留空禁用 | 空 |
| 摄像头持续显示时间 | 广告视频间隔中摄像头持续显示的秒数 | 300 |

> 配置在另一标签页修改时，大屏页面通过 `storage` 事件自动热重载。

## 错误处理

- 前端轮询失败保留上次有效值
- 连续 3 次失败 → 显示 `--`，状态指示灯变红
- 恢复后自动切回正常显示
- 视频画面冻结/断流 → 自动故障切换到备用流或下一个摄像头
- 故障切换有 3 秒冷却期，避免切换风暴

## 文件结构

```
VideoUI/
├── server.py              # HTTP 服务端（接收 POST + 托管静态文件 + 诊断日志）
├── start_server.bat       # Windows 启动脚本
├── mediamtx.yml.example   # MediaMTX 配置模板（WebRTC/WHEP）
├── nginx.conf             # Nginx 反向代理配置（统一入口 :80）
├── index.html             # 大屏展示页
├── admin.html             # 配置管理页
├── status.html            # 运行诊断仪表盘
├── deploy.md              # 部署运维手册
├── css/
│   └── style.css          # 样式（9:4 自适应、户外大字体）
├── js/
│   ├── config.js          # 配置读写（localStorage）
│   ├── main.js            # 大屏逻辑（数据轮询、视频轮播、故障切换、广告交替）
│   ├── admin.js           # 管理页表单逻辑
│   └── diagnostics.js     # 诊断日志模块（静默收集 + 定时上报）
└── logs/                  # 诊断日志输出目录（自动创建，保留 30 天）
```

## 浏览器兼容

支持所有现代浏览器（Chrome、Edge、Firefox、Safari）。推荐使用 Chrome Kiosk 模式部署到户外大屏。

## 部署运维

详细部署步骤（Windows 服务注册、开机自启、故障恢复）见 [deploy.md](deploy.md)。
