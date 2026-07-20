# CLAUDE.md

所有的回答和注释都要用中文编写

## 项目概述

停车场大屏展示页面 — 面向游客的 9:4 宽屏实时监控画面。左 3/4 为监控画面，右 1/4 为车位信息。同时展示停车场和停车楼的空闲车位（绿色字体）及总停车位（红色字体）。纯静态页面，无登录。

项目系统为 Windows Server 2022。

Python 使用 **uv** 管理依赖和运行环境。

## 常用命令

```bash
# 安装依赖（首次运行或依赖变更时）
uv sync

# 启动服务端（接收停车场 POST + 托管静态文件）
uv run python server.py --port 3000 --parkid-a 20210001 --parkid-b 20210002 --video-dir D:\videos

# 启动 MediaMTX（RTSP → WebRTC 桥接）
./mediamtx                                    # Windows: mediamtx.exe
# 配置文件: mediamtx.yml（从 mediamtx.yml.example 复制修改）

# 启动 Nginx（反向代理，统一入口 :80）
nginx                                         # Windows: nginx.exe
# 配置文件: 将项目 nginx.conf 复制到 Nginx 安装目录 conf/ 下

# 模拟停车场上报
curl -X POST http://localhost:3000/parking \
  -H "Content-Type: application/json" \
  -d '{"service":"parkingspace","parkid":"20210001","spacetotal":1000,"spaceLeft":978,"spaceused":22,"time":"2021-02-01 18:24:25","remark":""}'
```

浏览器打开 `http://localhost`（通过 Nginx 统一入口）查看大屏，`http://localhost:3000/admin.html` 进入配置管理。

## 架构

```
海康摄像头 ──RTSP──→ MediaMTX (单进程) ──WebRTC──→ Nginx :80 (反向代理) ──→ Chrome 全屏
 rtsp://ip:port            :8889 (WHEP)           统一入口消除跨域            kiosk 模式
 /Streaming/Channels/101                           ├─ /       → Python :3000 (页面+API)
                                                   ├─ /webrtc/→ WebRTC 信令 (WHEP)
                                                   └─ /videos/→ 本地 MP4 文件

停车场客户端 → POST /parking → server.py (内存存储) ← GET /api/parking/status ← 前端轮询
```

部署运维详见 `deploy.md`。

```
server.py               → HTTP 服务端：接收 POST、提供 GET、托管静态文件（默认端口 3000）
index.html              → 主展示页：左 3/4 视频 + 右 1/4 车位卡片（三行信息）
admin.html              → 配置管理页：所有设置写入 localStorage
nginx.conf              → Nginx 反向代理配置：统一入口 :80，消除跨域
deploy.md               → 部署运维手册：服务注册、开机自启、故障恢复
start-all.bat           → 一键启动所有服务（MediaMTX + Python + Nginx）
stop-all.bat            → 一键停止所有服务
restart-all.bat         → 一键重启所有服务
css/style.css           → 全局样式：9:4 自适应容器、卡片、视频面板、管理页表单
js/config.js            → 配置读写模块：getConfig() / saveConfig() / resetConfig()
js/main.js              → 主屏逻辑：轮询 GET /api/parking/status、数字动画、错误降级、摄像头+广告交替播放
js/admin.js             → 管理页表单：加载当前配置、保存、重置
mediamtx.yml.example    → MediaMTX 配置模板，供用户参考
pyproject.toml          → Python 项目配置（uv 管理依赖）
```

### 卡片展示内容（右侧 1/4）

```
xxxx景区游客中心停车场    ← 景区名称 (cyan)
总停车位：1000 个         ← A+B 合计 (红色)
总空闲车位：1098 个       ← A+B 空闲合计 (绿色)
```

### 数据流

1. 停车场客户端在车位变动时 POST 到 `/parking`，server.py 按 parkid 存入内存
2. 前端 `main.js` 按 `pollInterval` 秒轮询 `GET /api/parking/status`，获取 A/B 两个车场最新数据
3. 总停车位 = a.total + b.total（两个车场总车位之和，红色显示）
4. 总空闲车位 = a.available + b.available（两个车场空闲车位之和，绿色显示）
5. 配置在另一标签页修改时，`main.js` 通过 `storage` 事件自动热重载

### ParkID 映射

- server.py 通过 `--parkid-a` / `--parkid-b` 启动参数指定 A/B 对应的 parkid
- 前端 `config.js` 中的 `parkIdA` / `parkIdB` 需与服务端一致
- A = 停车场（parking lot），B = 停车楼（parking building）
- GET `/api/parking/status` 返回 `{a: {total, available}, b: {total, available}}`
- 某车场尚未收到上报时对应值为 `null`，该行显示 `--`

### API 约定

- **POST `/parking`**：停车场客户端上报，body 包含 `parkid`、`spacetotal`、`spaceLeft` 等
- **GET `/api/parking/status`**：前端轮询，返回 `{a: {total, available}, b: {total, available}}`
- **GET `/api/video-list?folder=<subfolder>`**：列出视频目录中的文件，返回 `["file1.mp4", ...]`

### 视频播放模式（摄像头 + 广告交替）

左侧视频区域只有一个画面。`videoStreams` 中第一个有效流作为**摄像头实时画面**。配置 `videoFolder`（`/videos/` 下的子文件夹）后，系统按以下节奏交替播放：

```
摄像头(5min) → 广告视频1 → 摄像头(5min) → 广告视频2 → ...（循环）
```

- `cameraDuration`（默认 300 秒）控制摄像头持续显示时间
- 广告视频播完后自动切回摄像头，视频加载失败则跳过该文件
- `videoFolder` 留空时始终显示摄像头画面
- 视频文件按文件名排序，支持 `.mp4` / `.webm` / `.mkv`

### 错误处理策略

- 前端轮询超时依赖浏览器默认行为（本地服务器响应快）
- 单次失败保留上次有效值
- 连续 3 次失败 → 显示 "--"，状态指示点变红
- 恢复后自动切回正常显示

### 视频流类型 (videoStreams.type)

| 类型 | 说明 | URL 格式 | 依赖 |
|------|------|----------|------|
| `webrtc` | WebRTC 视频流（**推荐**），超低延迟，浏览器原生支持 | `/webrtc/<path>` | MediaMTX + Nginx |
| `hls` | HLS 视频流（备选），延迟较高，需 hls.js 解码 | `/hls/<path>/index.m3u8` | MediaMTX + Nginx + hls.js |
| `flv` | HTTP-FLV 视频流（备选），需 flv.js 解码 | `/flv/<path>` | MediaMTX + Nginx + flv.js |
| `local` | 本地视频文件（MP4/WebM），原生 &lt;video&gt; 播放 | `/videos/<filename>` | Nginx 静态文件 |
| `iframe` | 嵌入 IP 摄像头网页（通过 iframe） | 完整 HTTP URL | 无 |

> **推荐使用 WebRTC**：延迟最低（<1 秒），浏览器原生支持无需第三方 JS 库，MediaMTX 通过 WHEP 协议提供 WebRTC 信令。

### RTSP 摄像头接入流程（推荐 WebRTC + MediaMTX WHEP）

1. 下载 MediaMTX: https://github.com/bluenviron/mediamtx/releases
2. 将 `mediamtx.yml.example` 复制为 `mediamtx.yml`，修改 RTSP 地址和账号密码，确保 `webrtc: yes`
3. 启动 MediaMTX:
   ```bash
   # Linux/macOS
   ./mediamtx
   # Windows
   mediamtx.exe
   ```
4. MediaMTX 默认端口:
   - WebRTC: `http://localhost:8889/<path>`（**推荐**，超低延迟，浏览器原生 WebRTC）
   - HLS: `http://localhost:8888/<path>/index.m3u8`（备选，延迟 2-5 秒）
   - HTTP-FLV: `http://localhost:8887/<path>`（备选，延迟 1-3 秒）
5. 启动 Nginx 反向代理（统一入口 :80），配置见 `nginx.conf`
6. 在 admin.html 中添加监控画面:
   - 视频类型选 **WebRTC**
   - 视频地址填 `/webrtc/<path>`（相对路径，经 Nginx 代理）
   - 例如: `/webrtc/parking_a1`

> **原理**: 浏览器无法直接播放 RTSP。MediaMTX 接收 RTSP 流，通过 WHEP（WebRTC-HTTP Egress Protocol）将视频以 WebRTC 格式转发。Nginx 反向代理统一到 :80，前端使用浏览器原生 `RTCPeerConnection` API 直接播放，无需任何第三方 JS 解码库。WebRTC 延迟通常 <1 秒，远优于 HLS（2-5 秒）和 FLV（1-3 秒）。所有资源同源，无跨域问题。

### 常见摄像头 RTSP URL 格式

| 品牌 | RTSP 地址格式 |
|------|-------------|
| 海康威视 | `rtsp://username:password@ip:554/Streaming/Channels/101` |
| 大华 | `rtsp://username:password@ip:554/cam/realmonitor?channel=1&subtype=0` |
| 宇视 | `rtsp://username:password@ip:554/media/video1` |
| 通用 ONVIF | `rtsp://username:password@ip:554/onvif1` |


### MediaMTX 配置文件说明

```yaml
# 关键配置项（完整模板见 mediamtx.yml.example）
webrtc: yes                # 启用 WebRTC（必需）
hls: yes                   # HLS 备选（可选）
hlsAddress: :8888

paths:
  entrance:                # 路径名，决定访问地址 /webrtc/entrance
    source: rtsp://admin:password@192.168.1.100:554/Streaming/Channels/101
```

> **注意**: WebRTC 在本地网络环境下延迟最低（<1 秒）。若摄像头与服务器不在同一网段，需确保 MediaMTX 所在服务器与浏览器之间的网络可达（WebRTC 需要 UDP 直连或 TURN 中继）。
