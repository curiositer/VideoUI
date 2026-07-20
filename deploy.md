# 停车场大屏 — 部署运维手册

## 1. 系统拓扑

```
海康摄像头 ──RTSP──→ MediaMTX ──WebRTC WHEP──→ Nginx :80 ──→ Chrome 全屏
  rtsp://ip:port        :8889                   统一入口        kiosk 模式
  /Streaming/           /entrance
  Channels/101
                                           ├─ /       → Python :3000 (页面+API)
                                           ├─ /webrtc/→ WebRTC 信令 (WHEP)
                                           └─ /videos/→ 本地 MP4 文件
```

所有请求统一到 `http://localhost:80`，从根源消除跨域。视频流通过 **WebRTC**（WHEP 协议）传输，延迟 <1 秒，浏览器原生支持无需第三方 JS 库。

---

## 2. 环境准备

### 2.1 安装 uv（Python 包管理器）

项目使用 [uv](https://docs.astral.sh/uv/) 管理 Python 环境和依赖，替代传统的 venv + pip。

```powershell
# PowerShell 一键安装（推荐）
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# 安装后验证
uv --version   # 应输出版本号
```

安装项目依赖：
```bash
cd D:\AI\VideoUI
uv sync        # 读取 pyproject.toml，自动创建 .venv 并安装依赖
```

> `uv run` 会自动使用 `.venv` 中的 Python，无需手动 `activate`。

### 2.2 下载 MediaMTX

从 https://github.com/bluenviron/mediamtx/releases 下载 Windows 版本（`mediamtx_v*_windows_amd64.zip`），解压到 `D:\mediamtx\`。

### 2.3 下载 Nginx

从 https://nginx.org/en/download.html 下载 Windows 版（推荐稳定版），解压到 `D:\nginx\`。

### 2.4 下载 nssm（可选，用于 Windows 服务注册）

从 https://nssm.cc/download 下载 nssm，解压到 `D:\nssm\`（或放到 PATH 中）。

> nssm 为可选项。项目提供的 `start-all.bat` / `stop-all.bat` 脚本已能覆盖日常启停需求。
> 如需开机自启 + 崩溃自动重启，nssm 是最佳选择。

### 2.5 创建本地视频目录

```bash
mkdir D:\videos
```

---

## 3. 配置 MediaMTX

编辑 `D:\mediamtx\mediamtx.yml`，配置海康摄像头 RTSP 源：

```yaml
# ====== 必改项 ======
# 启用 WebRTC（WHEP 协议，推荐）
webrtc: yes
webrtcAddress: :8889

# 启用 HLS（备选）
hls: yes
hlsAddress: :8888

# 关闭不需要的协议
api: no
rtsp: no
rtmp: no

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

**MediaMTX 启动后访问地址**：

| 协议 | 地址 | 延迟 | 说明 |
|------|------|------|------|
| **WebRTC** | `http://localhost:8889/entrance` | <1 秒 | **推荐**，浏览器原生支持 |
| HLS | `http://localhost:8888/entrance/index.m3u8` | 2-5 秒 | 备选，需 hls.js |
| FLV | `http://localhost:8887/entrance` | 1-3 秒 | 备选，需 flv.js |

---

## 4. 配置 Nginx

将项目中的 `nginx.conf` 复制到 `D:\nginx\conf\nginx.conf`（覆盖默认配置）：

```bash
copy D:\AI\VideoUI\nginx.conf D:\nginx\conf\nginx.conf
```

nginx.conf 已包含以下代理规则：

| 路径 | 代理到 | 说明 |
|------|--------|------|
| `/` | `127.0.0.1:3000` | Python 页面 + API |
| `/hls/` | `127.0.0.1:8888` | HLS 视频流（备选） |
| `/flv/` | `127.0.0.1:8887` | FLV 视频流（备选） |
| `/webrtc/` | `127.0.0.1:8889` | **WebRTC WHEP 信令（推荐）** |
| `/videos/` | `D:/videos/` | 本地视频文件 |

验证配置：
```bash
cd D:\nginx
nginx -t
```

---

## 5. 配置数据上报

确保停车场客户端向以下地址 POST 数据：
```
POST http://localhost:3000/parking
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

parkid `20210001` 对应停车场（A），`20210002` 对应停车楼（B）（可通过 server.py 启动参数修改）。

---

## 6. 视频地址配置

浏览器打开 `http://localhost:3000/admin.html`，添加监控画面时填写以下格式：

| 视频类型 | 地址格式 | 示例 |
|---------|---------|------|
| **WebRTC（推荐）** | `/webrtc/<path>` | `/webrtc/parking_a1` |
| HLS 视频流 | `/hls/<path>/index.m3u8` | `/hls/entrance/index.m3u8` |
| HTTP-FLV 视频流 | `/flv/<path>` | `/flv/entrance` |
| 本地视频文件 | `/videos/<filename>` | `/videos/promo.mp4` |
| IFrame（IP 摄像头网页）| 完整 HTTP URL | `http://192.168.1.200:8080` |

> **关键**：配置完后通过 `http://localhost`（端口 80）访问大屏，不要直接访问 3000 端口，否则跨域问题仍然存在。

---

## 7. 日常启停（start-all.bat / stop-all.bat）

项目根目录提供三个批处理脚本，无需 nssm 即可管理所有服务：

| 脚本 | 功能 |
|------|------|
| `start-all.bat` | 按顺序启动 MediaMTX → Python Server → Nginx |
| `stop-all.bat` | 按逆序停止 Nginx → Python Server → MediaMTX |
| `restart-all.bat` | 先停后启 |

**日志记录**：每个服务的 stdout + stderr 写入 `logs\` 目录，按天分文件：

```
logs\
  mediamtx_20260720.log    ← MediaMTX 全部控制台输出
  server_20260720.log      ← Python 服务输出（含异常堆栈）
  nginx_20260720.log       ← Nginx 启动错误
```

脚本顶部可配置端口、ParkID、安装路径等参数。

> **注意**：`stop-all.bat` 对 Nginx 优先使用 `nginx -s quit` 优雅退出，2 秒后未退出才 `taskkill /f` 强制终止。

---

## 8. 注册 Windows 服务（开机自启 + 崩溃重启）

如需更可靠的开机自启，可通过 nssm 将各服务注册为 Windows 服务。

### 8.1 通过 nssm 注册 3 个服务

在**管理员权限**的终端中执行：

```bash
# --- MediaMTX ---
nssm install MediaMTX D:\mediamtx\mediamtx.exe
nssm set MediaMTX AppDirectory D:\mediamtx
nssm set MediaMTX AppExit Default Restart
nssm set MediaMTX Start SERVICE_AUTO_START

# --- Python Parking Server（通过 uv run 启动）---
nssm install ParkingServer uv "run python server.py --port 3000 --parkid-a 20210001 --parkid-b 20210002"
nssm set ParkingServer AppDirectory D:\AI\VideoUI
nssm set ParkingServer AppExit Default Restart
nssm set ParkingServer Start SERVICE_AUTO_START

# --- Nginx ---
nssm install ParkingNginx D:\nginx\nginx.exe
nssm set ParkingNginx AppDirectory D:\nginx
nssm set ParkingNginx AppExit Default Restart
nssm set ParkingNginx Start SERVICE_AUTO_START
```

> `nssm install ParkingServer uv ...` 使用 `uv` 命令作为入口，`uv run` 会自动激活项目的 `.venv` 环境。

### 8.2 启动服务

```bash
nssm start MediaMTX
nssm start ParkingServer
nssm start ParkingNginx
```

或者通过 Windows 服务管理器（`services.msc`）手动启动。

### 8.3 设置启动顺序

```bash
# ParkingServer 依赖于 MediaMTX（等 MediaMTX 启动后再启动）
nssm set ParkingServer DependOnService MediaMTX
# ParkingNginx 依赖两者
nssm set ParkingNginx DependOnService MediaMTX ParkingServer
```

---

## 9. Chrome 大屏自动展示

### 9.1 创建快捷方式

在 `shell:startup`（按 Win+R，输入 `shell:startup`）中创建 Chrome 快捷方式。

右键 → 新建 → 快捷方式，目标填入：

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --disable-restore-session-state --disable-session-crashed-bubble --disable-features=TranslateUI http://localhost
```

### 9.2 Chrome 参数说明

| 参数 | 说明 |
|------|------|
| `--kiosk` | 不可退出的全屏模式（按 Alt+F4 退出） |
| `--disable-restore-session-state` | 不显示"恢复上次会话"提示 |
| `--disable-session-crashed-bubble` | 抑制 Chrome 崩溃恢复气泡 |
| `--disable-features=TranslateUI` | 禁用翻译弹窗 |

### 9.3 开机后等待时机

Chrome 启动时 Nginx 可能尚未就绪。如果遇到空白页，可创建一个启动批处理延迟启动：

```batch
@echo off
timeout /t 30 /nobreak >nul
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --disable-restore-session-state --disable-session-crashed-bubble http://localhost
```

将此 `.bat` 文件放到 `shell:startup` 替代直接启动 Chrome。

---

## 10. 日常运维

### 查看服务状态（nssm 方式）
```bash
nssm status MediaMTX
nssm status ParkingServer
nssm status ParkingNginx
```

### 查看日志
```bash
# Nginx 日志
type D:\nginx\logs\error.log
type D:\nginx\logs\access.log
```

### 手动测试服务健康
```bash
# Python 服务
curl http://localhost:3000/api/parking/status

# MediaMTX WebRTC (检查 WHEP 端点是否可达)
curl http://localhost:8889/entrance

# MediaMTX HLS（备选检查）
curl http://localhost:8888/entrance/index.m3u8

# Nginx 代理（最终入口）
curl http://localhost/api/parking/status
curl http://localhost/webrtc/entrance
```

### 停止所有服务（nssm 方式）
```bash
nssm stop ParkingNginx
nssm stop ParkingServer
nssm stop MediaMTX
```

---

## 11. 故障恢复流程

| 故障现象 | 排查步骤 |
|---------|---------|
| Chrome 显示白屏 | 1. 检查 Nginx 是否运行 `tasklist \| findstr nginx` 2. 检查 Python 服务 `curl localhost:3000` |
| 视频黑屏/加载中 | 1. 检查 MediaMTX `tasklist \| findstr mediamtx` 2. 检查摄像头 RTSP 是否能通 `ffplay rtsp://...` 3. 查看 `logs\mediamtx_*.log` 日志 4. 检查 WebRTC 端点 `curl localhost:8889/<path>` |
| WebRTC 连接失败 | 1. 确认 MediaMTX 配置 `webrtc: yes` 2. 检查防火墙是否阻止 UDP 3. 查看浏览器 Console 的 WebRTC 相关错误 |
| 车位数据不更新 | 1. 检查 ParkingServer 状态 2. 确认停车场客户端 POST 是否正常 3. 查看 `logs\server_*.log` |
| 某进程反复崩溃 | 查看对应日志文件排查根因（`logs\` 目录） |
| 停电后恢复 | 若使用 nssm 服务（`SERVICE_AUTO_START`），开机自动启动；若使用 start-all.bat，需手动运行 |

---

## 12. Windows Server 2022 补充说明

Windows Server 2022 与桌面版 Windows 的几个关键差异：

### 防火墙配置

Server 2022 默认启用防火墙，需放行端口：

```powershell
# Python 服务端口
New-NetFirewallRule -DisplayName "Parking Server (3000)" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Any

# MediaMTX WebRTC 端口（UDP + TCP）
New-NetFirewallRule -DisplayName "MediaMTX WebRTC (8889)" -Direction Inbound -Protocol TCP -LocalPort 8889 -Action Allow -Profile Any
New-NetFirewallRule -DisplayName "MediaMTX WebRTC UDP" -Direction Inbound -Protocol UDP -LocalPort 8000-9000 -Action Allow -Profile Any

# Nginx 端口
New-NetFirewallRule -DisplayName "Nginx HTTP (80)" -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow -Profile Any
```

### IE 增强安全配置

Server 2022 默认开启 IE Enhanced Security Configuration，会阻止网页正常加载。建议关闭：

1. 打开 **服务器管理器** → 左侧"本地服务器"
2. 找到 **"IE 增强的安全配置"**，点击右侧的 **"启用"**
3. 将管理员和用户均设置为 **"关闭"**

### Server Core（无 GUI）

- 无法本机展示大屏页面，需另接显示设备通过网络访问
- 浏览器打开 `http://<服务器IP>`（通过 Nginx :80 入口）
- 防火墙必须放行（见上方配置）
- uv 和 MediaMTX 安装均可通过命令行完成

### 部署检查清单

| 检查项 | 命令 / 方法 |
|---|---|
| uv 已安装 | `uv --version` |
| Python 依赖已安装 | `cd D:\AI\VideoUI && uv run python -c "print('ok')"` |
| MediaMTX 已配置 | `type D:\mediamtx\mediamtx.yml` |
| Nginx 配置正确 | `cd D:\nginx && nginx -t` |
| 防火墙已放行 | `Get-NetFirewallRule -DisplayName "Parking*"` |
| 防火墙已放行 | `Get-NetFirewallRule -DisplayName "MediaMTX*"` |
| 服务正在监听 | `netstat -ano \| findstr ":3000"` |
| 服务正在监听 | `netstat -ano \| findstr ":8889"` |
| 服务正在监听 | `netstat -ano \| findstr ":80"` |
| 浏览器可打开大屏 | 访问 `http://localhost`（本机）或 `http://<IP>`（远程） |
| 开机自启正常 | 重启后再次检查以上各项 |
