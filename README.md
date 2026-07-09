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
│                            │ 停车场空  978│ ← 绿色
│                            │ 闲车位       │
│                            │              │
│                            │ 停车楼空  120│ ← 绿色
│                            │ 闲车位       │
└────────────────────────────┴──────────────┘
  ←──────── 3/4 ────────→  ←─── 1/4 ───→
```

- **左 3/4**：实时监控画面
- **右 1/4**：停车场名称 + 总停车位（红色）+ 停车场空闲车位（绿色）+ 停车楼空闲车位（绿色）
- 所有车位信息同时展示，不再轮换

## 架构

```
RTSP 摄像头 → MediaMTX → HLS (端口 8888) → hls.js → Chrome/Edge <video> 播放
停车场客户端 → POST /api/parkingspace → server.py (内存) ← GET /api/parking/status ← 前端(poll)
```

- **MediaMTX**：将 RTSP 视频流实时转为 HLS 格式，供浏览器播放（单进程，Windows 免安装）
- **server.py**：Python 内置模块实现的 HTTP 服务端，零外部依赖
  - 接收停车场客户端 POST 上报的车位数据
  - 按 parkid 分别存储，供前端轮询
  - 同时托管静态文件（index.html / admin.html / css / js）
- **前端**：纯静态页面，每 N 秒轮询本地服务端获取最新数据，同时展示停车场 + 停车楼信息
  - hls.js 库负责在 Chrome/Edge 上解码 HLS 视频流
  - flv.js 库备用（需新版 MediaMTX 支持 HTTP-FLV）
- 停车场客户端在车位变动时主动 POST，无需前端配置外部 API 地址

## 本地部署

### 启动服务端

```bash
cd VideoUI

# 默认启动（parkid-a=20210001, parkid-b=20210002, port=8080）
python server.py

# 自定义参数
python server.py --port 8080 --parkid-a 20210001 --parkid-b 20210002
```

浏览器打开：
- 大屏展示页：`http://localhost:8080`
- 配置管理页：`http://localhost:8080/admin.html`

## RTSP 视频流转换（MediaMTX）

浏览器无法直接播放 RTSP 视频流。使用 **MediaMTX** 将 RTSP 转为 HLS 格式，前端通过 **hls.js** 在 Chrome/Edge 上播放。

### 架构

```
RTSP 摄像头 → MediaMTX → HLS (http://localhost:8888/<path>/index.m3u8) → hls.js → Chrome/Edge <video>
```

### 1. 下载 MediaMTX

从 [MediaMTX Releases](https://github.com/bluenviron/mediamtx/releases) 下载 Windows 版本（`mediamtx_vX.X.X_windows_amd64.zip`），解压到项目目录（与 `server.py` 同级）。

### 2. 配置 MediaMTX

将仓库中的 `mediamtx.yml.example` 复制为 `mediamtx.yml`，修改以下部分：

```yaml
# 日志级别
logLevel: info

# 关闭不需要的协议（本项目只用到 HLS）
api: no
rtsp: no
rtmp: no
webrtc: no

# HLS 服务器（前端通过 hls.js 播放）
hls: yes
hlsAddress: :8888

# 摄像头路径配置
paths:
  entrance:                          # 路径名，决定 HLS 地址的 /<path> 部分
    source: rtsp://127.0.0.1:8554/video   # RTSP 流地址
  # 可添加多个摄像头
  # exit:
  #   source: rtsp://192.168.1.100:554/Streaming/Channels/101
```

**常见摄像头 RTSP URL 格式：**

| 品牌 | RTSP 地址格式 |
|------|-------------|
| 海康威视 | `rtsp://username:password@ip:554/Streaming/Channels/101` |
| 大华 | `rtsp://username:password@ip:554/cam/realmonitor?channel=1&subtype=0` |
| 宇视 | `rtsp://username:password@ip:554/media/video1` |
| 通用 ONVIF | `rtsp://username:password@ip:554/onvif1` |
| VLC 模拟流 | `rtsp://127.0.0.1:8554/video` |

### 3. 启动 MediaMTX

```powershell
# 在项目目录下，双击运行或命令行启动
.\mediamtx.exe
```

启动成功后终端日志应显示：
```
[path entrance] [RTSP source] started
[path entrance] [RTSP source] ready
[path entrance] stream is available and online, 2 tracks (MPEG-1/2 Audio, H264)
```

此时 HLS 流地址为：`http://localhost:8888/entrance/index.m3u8`

> **注意**：`entrance` 对应配置文件中 `paths:` 下的键名。如果你用了其他路径名（如 `video`），HLS 地址也相应变为 `http://localhost:8888/video/index.m3u8`。

### 4. 在前端配置视频流

1. 打开 `http://localhost:8080/admin.html`
2. 在"监控画面"区域点击"添加监控画面"
3. 视频类型选择 **HLS**
4. 视频地址填入 `http://localhost:8888/entrance/index.m3u8`（按实际路径名修改）
5. 画面名称填写描述文字（如"停车场入口"）
6. 点击"保存配置"

刷新 `http://localhost:8080` 即可看到视频。

### 5. MediaMTX 开机自启

MediaMTX 需要和 `server.py` 一起开机启动。推荐使用**任务计划程序**：

1. 打开任务计划程序（`Win + R` → `taskschd.msc`）
2. 创建任务：

| 选项卡 | 设置项 | 值 |
|--------|--------|-----|
| 常规 | 名称 | `MediaMTX` |
| 常规 | 安全选项 | "不管用户是否登录都要运行" |
| 触发器 | 开始任务 | "启动时" |
| 触发器 | 延迟任务时间 | `10 秒`（确保系统网络就绪） |
| 操作 | 程序或脚本 | `D:\AI\VideoUI\mediamtx.exe` |
| 操作 | 起始于 | `D:\AI\VideoUI` |
| 设置 | 如果任务失败，重新启动间隔 | `1 分钟` |

> **启动顺序**：MediaMTX 先启动（延迟 10s），`server.py` 后启动（延迟 15s）。前端页面没有视频流时显示"暂无信号"，MediaMTX 就绪后自动恢复。

### 6. 故障排查

| 现象 | 可能原因 | 解决办法 |
|------|----------|----------|
| 页面黑屏，无视频 | RTSP 源未推流 | 检查摄像头 / VLC 推流是否正常 |
| `no stream is available` | MediaMTX 连不上 RTSP 源 | 检查 RTSP 地址、网络、账号密码 |
| `UDP timeout` | RTSP 源断连 | 重启摄像头推流，MediaMTX 会自动重连 |
| 浏览器无法加载视频 | CORS 跨域 | 见下方 CORS 说明 |
| HLS 地址 404 | 路径名不匹配 | 确认 `paths:` 下的键名与 URL 中的路径一致 |

**CORS 跨域说明**：页面（`localhost:8080`）和 HLS 流（`localhost:8888`）端口不同，可能被浏览器 CORS 策略拦截。两种解决办法：

- **方式一（推荐，专用展示机）**：Chrome 启动时加 `--disable-web-security --disable-features=IsolateOrigins,site-per-process --user-data-dir=C:\temp\chrome-unsafe`
- **方式二**：在 `server.py` 中配置 HLS 代理路由，将 MediaMTX 的请求转为同源

---

## 开机自启（Windows）

部署到户外大屏的电脑需要配置开机自启，防止意外关机重启后服务中断。提供两种方案：

### 方案一：任务计划程序（推荐）

Windows 任务计划程序支持**系统启动时自动运行**、**未登录也能运行**、**失败后自动重启**，是最可靠的方案。

**步骤：**

1. **确认 `start_server.bat` 能正常启动**

   双击运行仓库根目录下的 `start_server.bat`，确认服务正常启动后关闭窗口。

2. **打开任务计划程序**

   按 `Win + R`，输入 `taskschd.msc`，回车。

3. **创建任务**

   右侧点击 **"创建任务"**（不是"创建基本任务"），配置以下选项卡：

   **常规** 选项卡：
   | 设置项 | 值 |
   |---|---|
   | 名称 | `ParkingDisplayServer` |
   | 描述 | 停车场大屏展示服务端 |
   | 安全选项 | **"不管用户是否登录都要运行"** |
   | 使用最高权限 | ✅ 勾选 |

   > "不管用户是否登录都要运行"确保未登录时也能启动，系统重启后无需人工干预。勾选后会提示输入当前用户的 Windows 登录密码。

   **触发器** 选项卡 → 新建：
   | 设置项 | 值 |
   |---|---|
   | 开始任务 | **"启动时"** |

   **操作** 选项卡 → 新建：
   | 设置项 | 值 |
   |---|---|
   | 操作 | 启动程序 |
   | 程序或脚本 | `D:\AI\VideoUI\start_server.bat` |
   | 起始于 | `D:\AI\VideoUI` |

   > 请根据实际路径修改。路径中不要有空格，如有空格需要用英文双引号包裹。

   **条件** 选项卡 → **取消勾选**以下两项（防止休眠/省电导致服务停止）：
   - ❌ "只有在计算机使用交流电源时才启动此任务"
   - ❌ "使用电池供电时停止"

   **设置** 选项卡：
   | 设置项 | 值 |
   |---|---|
   | 如果任务失败，重新启动间隔 | `1 分钟` |
   | 尝试重新启动的次数 | `5 次` |
   | 如果已在运行，采取以下操作 | "停止现有实例" |

4. **测试**

   右键新建的任务 → **"运行"**，用浏览器打开 `http://localhost:8080` 确认大屏页面正常。确认后重启电脑测试是否自动启动。

### 方案二：启动文件夹（备选，需自动登录）

适合已配置 Windows 自动登录的展示机，实现更简单：

1. 按 `Win + R`，输入 `shell:startup`，回车
2. 右键 → 新建 → 快捷方式
3. 位置填入：`D:\AI\VideoUI\start_server.bat`（按实际路径修改）
4. 命名为 `ParkingDisplayServer`，完成

> **注意**：此方式需要用户登录后才能启动。如果系统重启后停在登录界面，服务不会运行。建议配合 Windows **自动登录**（`netplwiz`）使用。

### 验证自启是否生效

```bash
# 在命令行查看服务端是否在监听
netstat -ano | findstr ":8080"
```

浏览器打开 `http://localhost:8080`，能正常显示大屏页面即为成功。

---

## Windows Server 2022 部署说明

Windows Server 2022 与桌面版 Windows 有几个关键差异：默认开启防火墙、IE 增强安全配置、可能无 GUI（Server Core）。以下为完整部署流程。

### 1. 环境准备

#### 安装 Python 3.12+

Server 2022 默认不带 Python，需手动安装。

**有桌面体验（Desktop Experience）：**

1. 下载 [Python 3.12+](https://www.python.org/downloads/) Windows installer（64-bit）
2. 安装时勾选 **"Add Python to PATH"**
3. 验证：打开 PowerShell，执行 `python --version`

**Server Core（无 GUI）：**

```powershell
# 使用 winget 安装（推荐）
winget install Python.Python.3.12

# 或通过 Chocolatey
choco install python312
```

#### 配置防火墙

Server 2022 默认启用 Windows Defender 防火墙，需放行 8080 端口，否则其他设备无法访问大屏页面。

```powershell
# 以管理员身份运行 PowerShell，添加入站规则
New-NetFirewallRule -DisplayName "Parking Display Server (8080)" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 8080 `
  -Action Allow `
  -Profile Any
```

> **注意**：如果仅本机展示（大屏直接连服务器），不需要放行端口；如果停车场客户端需从其他机器 POST 上报，则必须放行。

#### 关闭 IE 增强安全配置

Server 2022 默认开启 IE Enhanced Security Configuration，会阻止网页正常加载。如果使用 Edge/Chrome 打开大屏展示页，建议关闭：

1. 打开 **服务器管理器** → 左侧"本地服务器"
2. 找到 **"IE 增强的安全配置"**，点击右侧的 **"启用"**
3. 将管理员和用户均设置为 **"关闭"**

### 2. 部署服务端

#### 方式一：任务计划程序（推荐）

与桌面版步骤一致（见上一章节），额外注意：

- **操作 → 程序或脚本**：指向 `D:\AI\VideoUI\start_server.bat`（按实际路径修改）
- 如果 Server 未配置自动登录，**"不管用户是否登录都要运行"** 是必须的

#### 方式二：nssm 注册为 Windows 服务

[nssm](https://nssm.cc/)（Non-Sucking Service Manager）可将任何程序注册为 Windows 服务，比任务计划程序更"原生"：

```powershell
# 1. 下载 nssm（约 500KB，单文件，免安装）
Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile "$env:TEMP\nssm.zip"
Expand-Archive "$env:TEMP\nssm.zip" -DestinationPath "C:\nssm"

# 2. 注册服务（管理员 PowerShell）
C:\nssm\nssm-2.24\win64\nssm.exe install ParkingDisplayServer

# 弹出 GUI 窗口，配置：
#   Application Path:  C:\Users\<用户名>\.venv\Scripts\python.exe
#                       （或系统 Python：C:\Program Files\Python312\python.exe）
#   Startup Directory: D:\AI\VideoUI
#   Arguments:         server.py --port 8080 --parkid-a 20210001 --parkid-b 20210002
#   Service name:      ParkingDisplayServer
#
# 点击 "Details" 选项卡，设置：
#   Startup type: Automatic (Delayed Start)
#
# 点击 "Install service"

# 3. 立即启动服务
Start-Service ParkingDisplayServer

# 4. 验证
Get-Service ParkingDisplayServer
```

**nssm 方式 vs 任务计划程序：**

| | nssm 服务 | 任务计划程序 |
|---|---|---|
| 启动时机 | 系统启动后自动启动 | 系统启动时触发 |
| 失败重试 | 需配合 recovery 设置 | 内置重试机制 |
| 管理方式 | `services.msc` / PowerShell | `taskschd.msc` |
| 额外依赖 | 需下载 nssm.exe | 系统自带 |

### 3. 大屏展示（浏览器设置）

Server 2022 上打开 `http://localhost:8080` 展示大屏页面：

- **有桌面体验**：直接用 Edge 或 Chrome 全屏模式（`F11`），设置浏览器主页为 `http://localhost:8080`
- **推荐 Kiosk 模式**：
  ```
  # Edge Kiosk 模式（开机自动全屏打开指定页面）
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
    --kiosk http://localhost:8080 --edge-kiosk-type=fullscreen --no-first-run
  ```
  将以上命令配置为开机自启（添加到任务计划程序，延迟 10 秒启动，确保服务端先启动）。

### 4. Server Core（无 GUI）注意事项

如果安装的是 Server Core（无桌面体验），需注意：

- **无法本机展示大屏页面**：Server Core 没有浏览器 GUI，需另接一台显示设备通过网络访问
- **显示设备配置**：在另一台电脑/大屏上，浏览器打开 `http://<服务器IP>:8080`
- **防火墙必须放行**：见上文防火墙配置
- **Python 和 nssm 安装均通过命令行完成**

### Server 2022 部署检查清单

| 检查项 | 命令 / 方法 |
|---|---|
| Python 已安装 | `python --version` |
| 防火墙已放行 8080 | `Get-NetFirewallRule -DisplayName "Parking*"` |
| 服务正在监听 | `netstat -ano \| findstr ":8080"` |
| 浏览器可打开大屏 | 访问 `http://localhost:8080`（本机）或 `http://<IP>:8080`（远程） |
| 开机自启正常 | 重启后再次检查以上各项 |

---

## 停车场客户端上报

停车场在车位变动时，向我方服务端发送 POST 请求：

```bash
curl -X POST http://<server>:8080/api/parkingspace \
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

### POST 报文字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| service | string | 固定值 `"parkingspace"` |
| parkid | string | 车场唯一标识，用于区分停车场 / 停车楼 |
| spacetotal | number | 总车位数 |
| spaceLeft | number | 空闲车位数 |
| spaceused | number | 已用车位数（可选） |
| time | string | 上报时间（可选） |
| remark | string | 备注（可选） |

## 前端 API

### GET /api/parking/status

返回两个车场的最新数据：

```json
{
  "a": { "total": 1000, "available": 978 },
  "b": { "total": 500, "available": 120 }
}
```

- `a` / `b` 分别对应 `--parkid-a`（停车场）/ `--parkid-b`（停车楼）
- 前端展示：总停车位 = a.total + b.total，停车场空闲 = a.available，停车楼空闲 = b.available
- 如果某个车场尚未收到过上报，对应值为 `null`

## 配置管理

打开 `admin.html` 页面进行配置，所有设置保存在浏览器 localStorage 中。

| 配置项 | 说明 | 默认值 |
|---|---|---|
| 景区名称 | 大屏顶部显示的停车场名称 | xxxx景区游客中心停车场 |
| 停车场 ParkID | 停车场标识，需与服务端 --parkid-a 一致 | 20210001 |
| 停车楼 ParkID | 停车楼标识，需与服务端 --parkid-b 一致 | 20210002 |
| 数据刷新间隔 | 前端轮询服务端的频率（秒） | 2 |
| 监控画面 | 多路视频流列表，每路含名称 / 类型 / 地址 | 空 |
| 画面切换间隔 | 多路画面轮播切换间隔（秒） | 10 |

> **提示**：监控视频流可能涉及跨域问题。如使用 iframe 嵌入摄像头页面，需确保摄像头服务允许被嵌入（`X-Frame-Options`）。HLS 流（.m3u8）在非 Safari 浏览器上可能需要 HLS.js 播放器支持。

## 工作流程

1. 启动 `server.py`，监听 8080 端口
2. 停车场客户端在车位变动时 POST 上报数据到 `/api/parkingspace`
3. 前端页面每 2 秒轮询 `GET /api/parking/status`，更新缓存
4. 页面同时显示：总停车位（A+B 合计，红色）、停车场空闲车位（绿色）、停车楼空闲车位（绿色）
5. 管理页修改配置后，大屏页面自动热更新（跨标签页 storage 事件）

## 错误处理

- 前端轮询失败保留上次有效值
- 连续 3 次失败 → 显示 `--`，状态指示灯变红
- 恢复后自动切回正常显示

## 文件结构

```
VideoUI/
├── server.py              # HTTP 服务端（接收 POST + 托管静态文件）
├── start_server.bat       # 开机自启脚本
├── mediamtx.yml.example   # MediaMTX 配置模板
├── index.html             # 大屏展示页
├── admin.html             # 配置管理页
├── css/
│   └── style.css          # 样式（9:4 自适应、户外大字体）
├── js/
│   ├── config.js          # 配置读写（localStorage）
│   ├── main.js            # 大屏逻辑（数据轮询、视频轮播、动画）
│   ├── admin.js           # 管理页表单逻辑
│   ├── hls.min.js         # hls.js 库（HLS 解码，Chrome/Edge 推荐）
│   └── flv.min.js         # flv.js 库（HTTP-FLV 解码，新版 MediaMTX 备用）
└── README.md
```

## 浏览器兼容

支持所有现代浏览器（Chrome、Edge、Firefox、Safari）。
