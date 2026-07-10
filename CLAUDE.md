# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

停车场大屏展示页面 — 面向游客的 9:4 宽屏实时监控画面。左 3/4 为监控画面，右 1/4 为车位信息。同时展示停车场和停车楼的空闲车位（绿色字体）及总停车位（红色字体）。纯静态页面，无登录。

## 常用命令

```bash
# 启动服务端（接收停车场 POST + 托管静态文件）
python server.py --port 3000 --parkid-a 20210001 --parkid-b 20210002

# 启动 MediaMTX（RTSP → HLS / HTTP-FLV 桥接）
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
海康摄像头 ──RTSP──→ MediaMTX (单进程) ──HLS──→ Nginx :80 (反向代理) ──→ Chrome 全屏
 rtsp://ip:port            :8888 / :8887        统一入口消除跨域            kiosk 模式
 /Streaming/Channels/101                           ├─ /       → Python :3000 (页面+API)
                                                   ├─ /hls/   → HLS 视频流
                                                   ├─ /flv/   → FLV 视频流
                                                   └─ /videos/→ 本地 MP4 文件

停车场客户端 → POST /parking → server.py (内存存储) ← GET /api/parking/status ← 前端轮询
```

部署运维详见 `deploy.md`。

```
server.py               → HTTP 服务端：接收 POST、提供 GET、托管静态文件（默认端口 3000）
index.html              → 主展示页：左 3/4 视频 + 右 1/4 车位卡片（四行信息）
admin.html              → 配置管理页：所有设置写入 localStorage
nginx.conf              → Nginx 反向代理配置：统一入口 :80，消除跨域
deploy.md               → 部署运维手册：服务注册、开机自启、故障恢复
css/style.css           → 全局样式：9:4 自适应容器、卡片、视频面板、管理页表单
js/config.js            → 配置读写模块：getConfig() / saveConfig() / resetConfig()
js/main.js              → 主屏逻辑：轮询 GET /api/parking/status、数字动画、错误降级、视频播放
js/admin.js             → 管理页表单：加载当前配置、保存、重置
js/hls.min.js           → hls.js 库：浏览器端解码 HLS 流
js/flv.min.js           → flv.js 库：浏览器端 MSE 解码 HTTP-FLV
mediamtx.yml.example    → MediaMTX 配置模板，供用户参考
```

### 卡片展示内容（右侧 1/4）

```
xxxx景区游客中心停车场    ← 景区名称 (cyan)
总停车位：1000 个         ← A+B 合计 (红色)
停车场空闲车位：978 个     ← parkid-a 空闲 (绿色)
停车楼空闲车位：120 个     ← parkid-b 空闲 (绿色)
```

### 数据流

1. 停车场客户端在车位变动时 POST 到 `/parking`，server.py 按 parkid 存入内存
2. 前端 `main.js` 按 `pollInterval` 秒轮询 `GET /api/parking/status`，获取 A/B 两个车场最新数据
3. 总停车位 = a.total + b.total（两个车场总车位之和，红色显示）
4. 停车场空闲车位 = a.available（绿色显示）
5. 停车楼空闲车位 = b.available（绿色显示）
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

### 错误处理策略

- 前端轮询超时依赖浏览器默认行为（本地服务器响应快）
- 单次失败保留上次有效值
- 连续 3 次失败 → 显示 "--"，状态指示点变红
- 恢复后自动切回正常显示

### 视频流类型 (videoStreams.type)

| 类型 | 说明 | URL 格式 | 依赖 |
|------|------|----------|------|
| `hls` | HLS 视频流（推荐），hls.js 解码（Chrome/Edge），Safari 原生支持 | `/hls/<path>/index.m3u8` | MediaMTX + Nginx |
| `flv` | HTTP-FLV 视频流，flv.js + MSE 硬解 H.264 | `/flv/<path>` | MediaMTX + Nginx |
| `local` | 本地视频文件（MP4/WebM），原生 &lt;video&gt; 播放 | `/videos/<filename>` | Nginx 静态文件 |
| `iframe` | 嵌入 IP 摄像头网页（通过 iframe） | 完整 HTTP URL | 无 |

> 使用 Nginx 反向代理后，hls/flv/local 类型均使用**相对路径**（`/hls/...`、`/flv/...`、`/videos/...`），不写 `localhost:8888`，以消除跨域。

### RTSP 摄像头接入流程（推荐 hls.js + MediaMTX HLS）

1. 下载 MediaMTX: https://github.com/bluenviron/mediamtx/releases
2. 将 `mediamtx.yml.example` 复制为 `mediamtx.yml`，修改 RTSP 地址和账号密码
3. 启动 MediaMTX:
   ```bash
   # Linux/macOS
   ./mediamtx
   # Windows
   mediamtx.exe
   ```
4. MediaMTX 默认端口:
   - HLS: `http://localhost:8888/<path>/index.m3u8`（前端 hls 类型使用，Chrome/Edge 通过 hls.js 播放）
   - HTTP-FLV: `http://localhost:8887/<path>`（新版 MediaMTX 支持，前端 flv 类型使用）
5. 启动 Nginx 反向代理（统一入口 :80），配置见 `nginx.conf`
6. 在 admin.html 中添加监控画面:
   - 视频类型选 **HLS**
   - 视频地址填 `/hls/<path>/index.m3u8`（相对路径，经 Nginx 代理）
   - 例如: `/hls/entrance/index.m3u8`

> **原理**: 浏览器无法直接播放 RTSP。MediaMTX 接收 RTSP 流并以 HLS 格式转发，Nginx 反向代理统一到 :80，前端 hls.js 将 HLS 切片解码后喂给浏览器 `<video>` 标签。Chrome/Edge 通过 hls.js 播放，Safari 原生支持 HLS。所有资源同源，无跨域问题。

### 常见摄像头 RTSP URL 格式

| 品牌 | RTSP 地址格式 |
|------|-------------|
| 海康威视 | `rtsp://username:password@ip:554/Streaming/Channels/101` |
| 大华 | `rtsp://username:password@ip:554/cam/realmonitor?channel=1&subtype=0` |
| 宇视 | `rtsp://username:password@ip:554/media/video1` |
| 通用 ONVIF | `rtsp://username:password@ip:554/onvif1` |
