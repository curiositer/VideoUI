# 停车场大屏 — 部署运维手册

## 1. 系统拓扑

```
海康摄像头 ──RTSP──→ MediaMTX ─WebRTC─→ Nginx :80 ──→ Chrome 全屏
  rtsp://ip:port        :8889 (WHEP)   统一入口         kiosk 模式
  /Streaming/           :8888 (HLS备用)
  Channels/101
                                           ├─ /        → Python :3000 (页面+API)
                                           ├─ /webrtc/ → WebRTC (WHEP) 信令
                                           └─ /videos/ → 本地 MP4 文件
```

所有请求统一到 `http://localhost:80`，从根源消除跨域。

---

## 2. 快速启动（推荐 ★）

日常使用只需两步，无需技术背景。

### 2.1 编辑配置文件

用记事本打开项目根目录的 **`config.json`**，修改摄像头 RTSP 地址：

```json
{
  "parkid_a": "cbssstcc",
  "parkid_b": "cbsjqtcl",
  "cameras": [
    {
      "name": "入口",
      "rtsp": "rtsp://admin:password@192.168.1.100:554/Streaming/Channels/101",
      "backups": [
        {
          "name": "入口备用机（不同角度）",
          "rtsp": "rtsp://admin:password@192.168.1.101:554/Streaming/Channels/101"
        }
      ]
    },
    { 
      "name": "停车场A", 
      "rtsp": "rtsp://admin:password@192.168.1.102:554/Streaming/Channels/101",
      "backups": [
        {
          "name": "入口备用机（不同角度）",
          "rtsp": "rtsp://admin:password@192.168.1.101:554/Streaming/Channels/101"
        }
      ]
    }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `parkid_a` | 停车场（地面）ParkID，需与停车场上报系统一致 |
| `parkid_b` | 停车楼 ParkID |
| `cameras[].name` | 摄像头名称，如"入口""停车场A"，会显示在大屏上 |
| `cameras[].rtsp` | 海康摄像头 RTSP 地址，替换 IP、账号、密码 |
| `cameras[].backups` | **（可选）** 该摄像头的备用 RTSP 流列表，主画面断流时自动切换 |
| `backups[].name` | 备用流名称，用于 MediaMTX 配置注释 |
| `backups[].rtsp` | 备用摄像头的 RTSP 地址 |
| `video_dir` | 本地视频存放目录，默认 `D:/videos` |
| `server_port` | 服务端口号，一般不需要改 |

> **RTSP 地址格式参考**：海康威视主码流 `rtsp://用户名:密码@摄像头IP:554/Streaming/Channels/101`

> **主备切换说明**：多个摄像头按轮播间隔循环切换，每个摄像头的备用流在主画面断流时依次切换（主 → 备1 → 备2 → … → 下一个摄像头）。主画面持续可达 3 分钟后自动切回。没有备用流时单摄像头也能自愈（原地重建连接）。无需备用流时，`backups` 字段可以省略或设为 `[]`。

### 2.2 启动和停止

| 操作 | 方法 |
|------|------|
| **启动系统** | 双击 `启动.bat` → 等待 5 秒 → 浏览器自动打开大屏 |
| **停止系统** | 双击 `停止.bat` → 关闭所有服务及 Chrome 大屏 |

`启动.bat` 自动完成以下工作（用户无需关心）：
1. 根据 `config.json` 自动生成 MediaMTX 配置（`D:\mediamtx\mediamtx.yml`）
2. 自动生成前端摄像头列表（`cameras.json`）
3. 启动 MediaMTX（RTSP → WebRTC 桥接）
4. 启动 Nginx（反向代理，统一 :80 入口）
5. 启动 Python 服务端（页面 + 停车数据 API）
6. 打开浏览器访问 `http://localhost`

> **提示**：关闭三个服务窗口不会停止系统 — 服务在后台运行。需要停止时请双击 `停止.bat`。
>
> **定时自动启停**：安装 `setup_scheduled_tasks.bat` 后，上述操作每天 06:00 / 15:00 自动执行（见第 12 章）。

### 2.3 修改摄像头

摄像头信息变更时：
1. 双击 `停止.bat` 停止系统
2. 编辑 `config.json` 中的 `cameras` 数组
3. 双击 `启动.bat` 重新启动

如需更多配置（轮播间隔、广告视频等），打开浏览器访问 `http://localhost:3000/admin.html` 进行设置，保存后刷新大屏页面即可生效。

---

## 3. 环境准备（仅首次部署时需要）

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

## 4. 配置 MediaMTX（高级用法 — 启动.bat 已自动处理，日常不需要手动操作）

> 以下为手动配置流程。日常使用请直接用「启动.bat」，它会根据 config.json 自动生成 mediamtx.yml。

将项目中的 `mediamtx.yml.example` 复制为 `mediamtx.yml`，编辑海康摄像头 RTSP 源：

```yaml
# ====== 必改项 ======
api: yes

# ====== 摄像头路径 ======
paths:
  entrance:
    source: rtsp://admin:password@192.168.1.100:554/Streaming/Channels/101
  parking_a:
    source: rtsp://admin:password@192.168.1.101:554/Streaming/Channels/101
  # 更多摄像头按同样格式添加
```

> **海康摄像头说明**：所有海康摄像头 RTSP 路径统一为 `/Streaming/Channels/101`（主码流），仅 IP 和端口不同。如需子码流，路径改为 `/Streaming/Channels/102`。

**WebRTC 访问地址**（MediaMTX 启动后）：
- 入口摄像头 WHEP：`http://localhost:8889/entrance/whep`
- 停车场 A WHEP：`http://localhost:8889/parking_a/whep`

---

## 5. 配置 Nginx（高级用法 — 首次部署时配置一次即可）

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

## 6. 配置数据上报

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

parkid `20210001` 对应停车场，`20210002` 对应停车楼（可通过 server.py 启动参数修改）。

---

## 7. 视频地址配置

浏览器打开 `http://localhost:3000/admin.html`，添加监控画面时填写以下格式：

| 视频类型 | 地址格式 | 示例 |
|---------|---------|------|
| WebRTC 视频流 | `/webrtc/<path>` | `/webrtc/entrance` |
| 本地视频文件 | `/videos/<filename>` | `/videos/promo.mp4` |

> **关键**：配置完后通过 `http://localhost`（端口 80）访问大屏，不要直接访问 3000 端口，否则跨域问题仍然存在。

---

## 8. 注册 Windows 服务（开机自启 + 崩溃重启）

### 7.1 通过 nssm 注册 3 个服务

在**管理员权限**的终端中执行：

```bash
# --- MediaMTX ---
nssm install MediaMTX D:\mediamtx\mediamtx.exe
nssm set MediaMTX AppDirectory D:\mediamtx
nssm set MediaMTX AppExit Default Restart
nssm set MediaMTX Start SERVICE_AUTO_START

# --- Python Parking Server ---
nssm install ParkingServer python "D:\AI\VideoUI\server.py --port 3000 --parkid-a 20210001 --parkid-b 20210002 --video-dir D:\videos"
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

## 9. Chrome 大屏自动展示

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

## 10. 日常运维

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

# 健康检查
curl http://localhost:3000/api/health

# MediaMTX WebRTC（WHEP 信令地址应可达）
curl -I http://localhost:8889/entrance

# Nginx 代理（最终入口）
curl http://localhost/api/parking/status
curl http://localhost/webrtc/entrance
```

### 停止所有服务
```bash
nssm stop ParkingNginx
nssm stop ParkingServer
nssm stop MediaMTX
```

---

## 11. 故障恢复流程

| 故障现象 | 排查步骤 |
|---------|---------|
| Chrome 显示白屏 | 1. 检查 Nginx 是否运行 `nssm status ParkingNginx` 2. 检查 Python 服务 `curl localhost:3000` |
| 视频黑屏/加载中 | 1. 检查 MediaMTX `nssm status MediaMTX` 2. 检查摄像头 RTSP 是否能通 3. 查看 status.html 诊断仪表盘 |
| 车位数据不更新 | 1. 检查 ParkingServer 状态 2. 确认停车场客户端 POST 是否正常 |
| 某进程反复崩溃 | nssm 会自动重启，检查 status.html 诊断日志排查根因 |
| 停电后恢复 | 所有服务已注册为 `SERVICE_AUTO_START`，开机自动启动，无需人工干预 |

### 诊断工具

打开 `http://localhost:3000/status.html` 可查看：
- 系统健康状态（正常/部分异常/严重异常）
- 今日错误/警告/信息事件统计
- 事件时间线（可按级别筛选）
- 摄像头故障切换详情
- 服务运行时长

---

## 12. 每日定时自动启停（推荐 ⭐）

### 背景

长期运行可能导致 WebRTC 连接老化、内存泄漏等问题累积，最终崩溃。每天定时重启相当于"每日自愈"——即使某天下午崩溃了，第二天早上 6:00 也会自动恢复，无需人工介入。

### 一次性安装

右键 **`setup_scheduled_tasks.bat`** → **以管理员身份运行**（确保在自动登录的那个 Windows 账号下执行）。

脚本会创建两个 Windows 定时任务：

| 任务名称 | 时间 | 操作 |
|---------|------|------|
| `ParkingDisplay_Start` | 每天 06:00 | 先停止残留进程 → 启动 MediaMTX / Nginx / Python 服务 → 打开 Chrome 大屏 |
| `ParkingDisplay_Stop` | 每天 15:00 | 停止 Nginx / MediaMTX / Python 服务 → 关闭 Chrome 大屏 |

### 日志

- 启动日志：`logs\scheduled_start.log`（含每次健康检查 HTTP 状态码）
- 停止日志：`logs\scheduled_stop.log`
- 每天追加几 KB，可随时删除

### 手动测试

```bash
# 手动触发启动（测试用）
schtasks /Run /TN "ParkingDisplay_Start"

# 手动触发停止
schtasks /Run /TN "ParkingDisplay_Stop"

# 查看任务详情（含下次运行时间）
schtasks /Query /TN "ParkingDisplay_Start" /V
```

### 修改时间

```bash
# 改启动时间为 7:00
schtasks /Change /TN "ParkingDisplay_Start" /ST 07:00

# 改停止时间为 16:00
schtasks /Change /TN "ParkingDisplay_Stop" /ST 16:00
```

### 卸载

```bash
schtasks /Delete /TN "ParkingDisplay_Start" /F
schtasks /Delete /TN "ParkingDisplay_Stop" /F
```

### 前提与注意事项

- **电脑需保持开机并已登录**（任务仅在交互桌面会话中运行，Chrome 需要桌面才能显示）
- **建议开启 Windows 自动登录**：按 Win+R → `netplwiz` → 取消勾选"要使用本计算机，用户必须输入用户名和密码" → 输入密码确认
- **电源选项关闭睡眠**：设置 → 电源 → 睡眠 → 改为"从不"（睡眠状态下定时任务不会触发）
- **错过补跑**：如果电脑夜间关机导致错过 6:00 启动，打开 `taskschd.msc`（任务计划程序）→ 右键任务 → 属性 → 设置 → 勾选"如果错过计划的开始时间，则尽快启动任务"

### 与手动启停的关系

- 定时任务使用独立脚本 `scheduled_start.bat` / `scheduled_stop.bat`（无人值守，无 `pause`）
- 手动操作请继续使用原来的 `启动.bat` / `停止.bat`（有 `pause`，方便查看输出）
- 两者互不干扰，可同时存在
