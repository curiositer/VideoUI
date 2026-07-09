# 停车场大屏 — 部署运维手册

## 1. 系统拓扑

```
海康摄像头 ──RTSP──→ MediaMTX ──HLS──→ Nginx :80 ──→ Chrome 全屏
  rtsp://ip:port        :8888         统一入口         kiosk 模式
  /Streaming/           :8887
  Channels/101
                                         ├─ /       → Python :3000 (页面+API)
                                         ├─ /hls/   → HLS 视频流
                                         ├─ /flv/   → FLV 视频流
                                         └─ /videos/→ 本地 MP4 文件
```

所有请求统一到 `http://localhost:80`，从根源消除跨域。

---

## 2. 环境准备

### 2.1 安装 Python 3

确保 `python` 命令可用：
```bash
python --version   # 需要 3.7+
```

### 2.2 下载 MediaMTX

从 https://github.com/bluenviron/mediamtx/releases 下载 Windows 版本（`mediamtx_v*_windows_amd64.zip`），解压到 `D:\mediamtx\`。

### 2.3 下载 Nginx

从 https://nginx.org/en/download.html 下载 Windows 版（推荐稳定版），解压到 `D:\nginx\`。

### 2.4 下载 nssm

从 https://nssm.cc/download 下载 nssm，解压到 `D:\nssm\`（或放到 PATH 中）。

### 2.5 创建本地视频目录

```bash
mkdir D:\videos
```

---

## 3. 配置 MediaMTX

编辑 `D:\mediamtx\mediamtx.yml`，配置海康摄像头 RTSP 源：

```yaml
# ====== 必改项 ======
# 修改默认管理员密码
api: yes
webRtcAdditionalHosts: []

# ====== 摄像头路径 ======
paths:
  entrance:
    source: rtsp://admin:password@192.168.1.100:554/Streaming/Channels/101
  parking_a:
    source: rtsp://admin:password@192.168.1.101:554/Streaming/Channels/101
  # 更多摄像头按同样格式添加
  # cam_exit:
  #   source: rtsp://admin:password@192.168.1.102:554/Streaming/Channels/101
```

> **海康摄像头说明**：所有海康摄像头 RTSP 路径统一为 `/Streaming/Channels/101`（主码流），仅 IP 和端口不同。如需子码流，路径改为 `/Streaming/Channels/102`。

**HLS 访问地址**（MediaMTX 启动后）：
- 入口摄像头：`http://localhost:8888/entrance/index.m3u8`
- 停车场A：`http://localhost:8888/parking_a/index.m3u8`

---

## 4. 配置 Nginx

将项目中的 `nginx.conf` 复制到 `D:\nginx\conf\nginx.conf`（覆盖默认配置）：

```bash
copy D:\AI\VideoUI\nginx.conf D:\nginx\conf\nginx.conf
```

验证配置：
```bash
cd D:\nginx
nginx -t
```

---

## 5. 配置数据上报

确保停车场客户端向以下地址 POST 数据：
```
POST http://localhost:3000/api/parkingspace
Content-Type: application/json

{
  "service": "parkingspace",
  "parkid": "20210001",
  "spacetotal": 1000,
  "spaceLeft": 978,
  "spaceused": 22,
  "time": "2021-02-01 18:24:25",
  "remark": ""
}
```

parkid `20210001` 对应停车场，`20210002` 对应停车楼（可通过 server.py 启动参数修改）。

---

## 6. 视频地址配置

浏览器打开 `http://localhost:3000/admin.html`，添加监控画面时填写以下格式：

| 视频类型 | 地址格式 | 示例 |
|---------|---------|------|
| HLS 视频流 | `/hls/<path>/index.m3u8` | `/hls/entrance/index.m3u8` |
| HTTP-FLV 视频流 | `/flv/<path>` | `/flv/entrance` |
| 本地视频文件 | `/videos/<filename>` | `/videos/promo.mp4` |
| IFrame（IP 摄像头网页）| 完整 HTTP URL | `http://192.168.1.200:8080` |

> **关键**：配置完后通过 `http://localhost`（端口 80）访问大屏，不要直接访问 3000 端口，否则跨域问题仍然存在。

---

## 7. 注册 Windows 服务（开机自启 + 崩溃重启）

### 7.1 通过 nssm 注册 3 个服务

在**管理员权限**的终端中执行：

```bash
# --- MediaMTX ---
nssm install MediaMTX
# 弹出窗口，按以下填入：
#   Application Path:  D:\mediamtx\mediamtx.exe
#   Startup Directory: D:\mediamtx
# 或者命令行：
nssm install MediaMTX D:\mediamtx\mediamtx.exe
nssm set MediaMTX AppDirectory D:\mediamtx
nssm set MediaMTX AppExit Default Restart
nssm set MediaMTX Start SERVICE_AUTO_START

# --- Python Parking Server ---
nssm install ParkingServer python "D:\AI\VideoUI\server.py --port 3000 --parkid-a 20210001 --parkid-b 20210002"
nssm set ParkingServer AppDirectory D:\AI\VideoUI
nssm set ParkingServer AppExit Default Restart
nssm set ParkingServer Start SERVICE_AUTO_START

# --- Nginx ---
nssm install ParkingNginx D:\nginx\nginx.exe
nssm set ParkingNginx AppDirectory D:\nginx
nssm set ParkingNginx AppExit Default Restart
nssm set ParkingNginx Start SERVICE_AUTO_START
```

### 7.2 启动服务

```bash
nssm start MediaMTX
nssm start ParkingServer
nssm start ParkingNginx
```

或者通过 Windows 服务管理器（`services.msc`）手动启动。

### 7.3 设置启动顺序

```bash
# ParkingServer 依赖于 MediaMTX（等 MediaMTX 启动后再启动）
nssm set ParkingServer DependOnService MediaMTX
# ParkingNginx 依赖两者
nssm set ParkingNginx DependOnService MediaMTX ParkingServer
```

---

## 8. Chrome 大屏自动展示

### 8.1 创建快捷方式

在 `shell:startup`（按 Win+R，输入 `shell:startup`）中创建 Chrome 快捷方式。

右键 → 新建 → 快捷方式，目标填入：

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --disable-restore-session-state --disable-session-crashed-bubble --disable-features=TranslateUI http://localhost
```

### 8.2 Chrome 参数说明

| 参数 | 说明 |
|------|------|
| `--kiosk` | 不可退出的全屏模式（按 Alt+F4 退出） |
| `--disable-restore-session-state` | 不显示"恢复上次会话"提示 |
| `--disable-session-crashed-bubble` | 抑制 Chrome 崩溃恢复气泡 |
| `--disable-features=TranslateUI` | 禁用翻译弹窗 |

### 8.3 开机后等待时机

Chrome 启动时 Nginx 可能尚未就绪。如果遇到空白页，可创建一个启动批处理延迟启动：

```batch
@echo off
timeout /t 30 /nobreak >nul
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --disable-restore-session-state --disable-session-crashed-bubble http://localhost
```

将此 `.bat` 文件放到 `shell:startup` 替代直接启动 Chrome。

---

## 9. 日常运维

### 查看服务状态
```bash
nssm status MediaMTX
nssm status ParkingServer
nssm status ParkingNginx
```

### 重启某服务
```bash
nssm restart ParkingServer
```

### 查看 Nginx 日志
```bash
# 错误日志
type D:\nginx\logs\error.log
# 访问日志
type D:\nginx\logs\access.log
```

### 手动测试服务健康
```bash
# Python 服务
curl http://localhost:3000/api/parking/status

# MediaMTX HLS
curl http://localhost:8888/entrance/index.m3u8

# Nginx 代理（最终入口）
curl http://localhost/api/parking/status
curl http://localhost/hls/entrance/index.m3u8
```

### 停止所有服务
```bash
nssm stop ParkingNginx
nssm stop ParkingServer
nssm stop MediaMTX
```

---

## 10. 故障恢复流程

| 故障现象 | 排查步骤 |
|---------|---------|
| Chrome 显示白屏 | 1. 检查 Nginx 是否运行 `nssm status ParkingNginx` 2. 检查 Python 服务 `curl localhost:3000` |
| 视频黑屏/加载中 | 1. 检查 MediaMTX `nssm status MediaMTX` 2. 检查摄像头 RTSP 是否能通 `ffplay rtsp://...` 3. 查看 MediaMTX 控制台输出 |
| 车位数据不更新 | 1. 检查 ParkingServer 状态 2. 确认停车场客户端 POST 是否正常 |
| 某进程反复崩溃 | nssm 会自动重启，检查对应日志文件排查根因 |
| 停电后恢复 | 所有服务已注册为 `SERVICE_AUTO_START`，开机自动启动，无需人工干预 |
