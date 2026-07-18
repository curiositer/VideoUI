# CLAUDE.md

所有的回答和注释都要用中文编写

## 项目概述

停车场大屏展示页面 — 面向游客的 9:4 宽屏实时监控画面。左 3/4 为监控画面，右 1/4 为车位信息。同时展示停车场和停车楼的空闲车位（绿色字体）及总停车位（红色字体）。纯静态页面，无登录。

## 常用命令

```bash
# 启动服务端（接收停车场 POST + 托管静态文件）
python server.py --port 3000 --parkid-a 20210001 --parkid-b 20210002 --video-dir D:\videos

# 启动 MediaMTX（RTSP → WebRTC/WHEP 桥接）
./mediamtx                                    # Windows: mediamtx.exe
# 配置文件: mediamtx.yml（从 mediamtx.yml.example 复制修改）

# 启动 Nginx（反向代理，统一入口 :80）
nginx                                         # Windows: nginx.exe
# 配置文件: 将项目 nginx.conf 复制到 Nginx 安装目录 conf/ 下

# 注册 Windows 服务（开机自启 + 崩溃重启，管理员权限）
nssm install MediaMTX D:\mediamtx\mediamtx.exe
nssm install ParkingServer python "D:\AI\VideoUI\server.py --port 3000 --parkid-a 20210001 --parkid-b 20210002"
nssm install ParkingNginx D:\nginx\nginx.exe
# 详细步骤见 deploy.md

# 模拟停车场上报
curl -X POST http://localhost:3000/parking \
  -H "Content-Type: application/json" \
  -d '{"service":"parkingspace","parkid":"20210001","spacetotal":1000,"spaceLeft":978,"spaceused":22,"time":"2021-02-01 18:24:25","remark":""}'
```

浏览器打开 `http://localhost`（通过 Nginx 统一入口）查看大屏，`http://localhost:3000/admin.html` 进入配置管理。

## 架构

```
海康摄像头 ──RTSP──→ MediaMTX (单进程) ─WebRTC─→ Nginx :80 (反向代理) ──→ Chrome 全屏
 rtsp://ip:port            :8889 (WHEP)         统一入口消除跨域            kiosk 模式
 /Streaming/Channels/101                           ├─ /        → Python :3000 (页面+API)
                                                   ├─ /webrtc/ → WebRTC (WHEP) 信令
                                                   └─ /videos/ → 本地 MP4 文件

停车场客户端 → POST /parking → server.py (内存存储) ← GET /api/parking/status ← 前端轮询
```

部署运维详见 `deploy.md`。

```
server.py               → HTTP 服务端：接收 POST、提供 GET、托管静态文件（默认端口 3000）
index.html              → 主展示页：左 3/4 视频 + 右 1/4 车位卡片（三行信息）
admin.html              → 配置管理页：所有设置写入 localStorage
nginx.conf              → Nginx 反向代理配置：统一入口 :80，消除跨域
deploy.md               → 部署运维手册：服务注册、开机自启、故障恢复
css/style.css           → 全局样式：9:4 自适应容器、卡片、视频面板、管理页表单
js/config.js            → 配置读写模块：getConfig() / saveConfig() / resetConfig()
js/main.js              → 主屏逻辑：轮询数据、多摄像头轮播、主备故障切换、帧数看门狗、摄像头+广告交替播放
js/admin.js             → 管理页表单：加载当前配置、保存、重置、备用流子列表编辑
mediamtx.yml.example    → MediaMTX 配置模板，供用户参考
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
6. 配置在另一标签页修改时，`main.js` 通过 `storage` 事件自动热重载

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

### 视频播放模式（多摄像头轮播 + 主备切换 + 广告交替）

左侧视频区域只有一个画面。`videoStreams` 中所有有效流构成摄像头列表：

- **多画面轮播**：多个摄像头按 `cameraRotateInterval` 秒（默认 30）循环切换；间隔为 0 或只有一个摄像头时固定播放
- **主备故障切换**：每个摄像头可配多个备用流（`backups` 列表）。当前画面断流（帧数看门狗约 20 秒检测 / WebRTC 连接失败 / WHEP 握手失败 / 本地视频加载失败）时按链切换：`主画面 → 备1 → 备2 → … → 下一个摄像头的主画面`；只有一个摄像头且无备用时原地重建（自愈）
- **主画面自动恢复**：使用备用流期间每 15 秒 HTTP HEAD 探测主画面，持续可达满 3 分钟 → 自动切回主画面
- **故障切换冷却**：两次切换至少间隔 3 秒，避免所有流都断开时的切换风暴

配置 `videoFolder`（`/videos/` 下的子文件夹）后，系统按以下节奏交替播放：

```
摄像头轮播(cameraDuration 秒) → 广告视频1 → 摄像头轮播 → 广告视频2 → ...（循环）
```

- `cameraDuration`（默认 300 秒）控制摄像头持续显示时间
- 广告视频播完后自动切回摄像头（保持切换前的主备状态），视频加载失败则跳过该文件
- 广告播放期间轮播与恢复探测暂停
- `videoFolder` 留空时始终显示摄像头画面
- 视频文件按文件名排序，支持 `.mp4` / `.webm` / `.mkv`

### 错误处理策略

数据轮询：

- 前端轮询超时依赖浏览器默认行为（本地服务器响应快）
- 单次失败保留上次有效值
- 连续 3 次失败 → 显示 "--"，状态指示点变红
- 恢复后自动切回正常显示

视频画面：

- 帧数看门狗每 10 秒读取 `video.getVideoPlaybackQuality().totalVideoFrames`，连续 2 次（约 20 秒）无新帧判定为冻结，触发故障切换（兜底 WebRTC 静默断流场景）
- 断流沿主备切换链自动换源（见"视频播放模式"），全部断开时 3 秒冷却逐个重试
- `videoStreams` 中残留的旧类型（hls/flv/iframe）会被过滤忽略，管理页重新保存后自动迁移为 webrtc

### 视频流类型 (videoStreams.type)

仅支持两种类型：

| 类型 | 说明 | URL 格式 | 依赖 |
|------|------|----------|------|
| `webrtc` | WebRTC 视频流（WHEP，超低延迟，支持 H.265） | `/webrtc/<path>` | MediaMTX + Nginx |
| `local` | 本地视频文件（MP4/WebM），原生 &lt;video&gt; 循环播放 | `/videos/<filename>` | Nginx 静态文件 |

每个流可配 `backups` 备用流列表（元素为 `{url, type}`），断流时依次自动切换。

> 使用 Nginx 反向代理后，webrtc/local 类型均使用**相对路径**（`/webrtc/...`、`/videos/...`），不写 `localhost:8889`，以消除跨域。

### RTSP 摄像头接入流程（MediaMTX WebRTC/WHEP）

1. 下载 MediaMTX: https://github.com/bluenviron/mediamtx/releases
2. 将 `mediamtx.yml.example` 复制为 `mediamtx.yml`，修改 RTSP 地址和账号密码
3. 启动 MediaMTX:
   ```bash
   # Linux/macOS
   ./mediamtx
   # Windows
   mediamtx.exe
   ```
4. MediaMTX WebRTC 默认端口 `:8889`，WHEP 信令地址: `http://localhost:8889/<path>/whep`
5. 启动 Nginx 反向代理（统一入口 :80），`/webrtc/` 代理到 `:8889`，配置见 `nginx.conf`
6. 在 admin.html 中添加监控画面:
   - 视频类型选 **WebRTC**
   - 视频地址填 `/webrtc/<path>`（相对路径，经 Nginx 代理，前端自动拼接 `/whep` 后缀）
   - 例如: `/webrtc/entrance`
   - 按需在该画面下添加**备用流**（另一台摄像头的 `/webrtc/xxx` 或本地兜底视频 `/videos/xxx.mp4`）

> **原理**: 浏览器无法直接播放 RTSP。MediaMTX 接收 RTSP 流并通过 WHEP 协议以 WebRTC 转发，Nginx 反向代理统一到 :80，前端 `RTCPeerConnection` 与 MediaMTX 交换 SDP 后直接渲染到 `<video>` 标签。延迟通常在 1 秒以内，且支持 H.265（依赖系统硬解）。所有资源同源，无跨域问题。

### 常见摄像头 RTSP URL 格式

| 品牌 | RTSP 地址格式 |
|------|-------------|
| 海康威视 | `rtsp://username:password@ip:554/Streaming/Channels/101` |
| 大华 | `rtsp://username:password@ip:554/cam/realmonitor?channel=1&subtype=0` |
| 宇视 | `rtsp://username:password@ip:554/media/video1` |
| 通用 ONVIF | `rtsp://username:password@ip:554/onvif1` |
