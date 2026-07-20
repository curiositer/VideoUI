# 停车场大屏实时监控

9:4 宽屏停车场实时监控展示页面，面向户外大屏游客场景，无需登录。

视频流通过 **WebRTC** 传输（MediaMTX WHEP），延迟 <1 秒，浏览器原生支持。Python 环境由 **uv** 管理。

## 页面布局

```
┌────────────────────────────┬──────────────┐
│                            │ xxxx景区     │
│                            │ 游客中心停车场│
│                            │              │
│       监控画面              │ 总停车位 1000│ ← 红色
│                            │              │
│                            │ 总空闲车位   │ ← 绿色
│                            │   1098       │
│                            │              │
│                            │              │
│                            │              │
└────────────────────────────┴──────────────┘
  ←──────── 3/4 ────────→  ←─── 1/4 ───→
```

- **左 3/4**：实时监控画面（WebRTC 超低延迟）
- **右 1/4**：停车场名称 + 总停车位（红色）+ 总空闲车位（绿色）
- 总停车位 = 停车场 A + 停车楼 B 合计
- 总空闲车位 = 停车场 A + 停车楼 B 空闲合计

## 架构

```
RTSP 摄像头 → MediaMTX → WebRTC WHEP (:8889) → Nginx :80 → Chrome <video> (原生)
停车场客户端 → POST /parking → server.py (内存) ← GET /api/parking/status ← 前端轮询
```

- **MediaMTX**：将 RTSP 视频流实时转为 WebRTC 格式，通过 WHEP 协议供浏览器播放（单进程，Windows 免安装）
- **server.py**：Python 内置模块实现的 HTTP 服务端，零外部依赖
  - 接收停车场客户端 POST 上报的车位数据
  - 按 parkid 分别存储，供前端轮询
  - 同时托管静态文件（index.html / admin.html / css / js）
- **前端**：纯静态页面，每 N 秒轮询本地服务端获取最新数据
  - 使用浏览器原生 `RTCPeerConnection` API 播放 WebRTC 视频流，无需第三方 JS 库
  - 支持 HLS / FLV 作为备选方案
- 停车场客户端在车位变动时主动 POST，无需前端配置外部 API 地址

## 环境准备

### uv（Python 包管理器）

项目使用 [uv](https://docs.astral.sh/uv/) 管理 Python 运行环境和依赖。

**Windows 安装 uv：**

```powershell
# 方式一：PowerShell 一键安装（推荐）
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# 方式二：通过 winget
winget install --id=astral-sh.uv -e

# 方式三：通过 pip
pip install uv
```

安装后验证：
```bash
uv --version
```

**安装项目依赖：**
```bash
cd D:\AI\VideoUI
uv sync          # 读取 pyproject.toml，自动创建 .venv 并安装依赖
```

## 本地部署

### 启动服务端

```bash
cd D:\AI\VideoUI

# 通过 uv 运行（自动使用 .venv 环境）
uv run python server.py --port 3000 --parkid-a 20210001 --parkid-b 20210002
```

浏览器打开：
- 大屏展示页：`http://localhost:3000`
- 配置管理页：`http://localhost:3000/admin.html`

## RTSP 视频流转 WebRTC（MediaMTX）

浏览器无法直接播放 RTSP 视频流。使用 **MediaMTX** 将 RTSP 转为 **WebRTC**（WHEP 协议），前端通过浏览器原生 `RTCPeerConnection` 播放，延迟 <1 秒，无需任何第三方 JS 库。

### 架构

```
RTSP 摄像头 → MediaMTX → WebRTC (http://localhost:8889/<path>) → Nginx :80 → 浏览器原生 WebRTC
```

### 1. 下载 MediaMTX

从 [MediaMTX Releases](https://github.com/bluenviron/mediamtx/releases) 下载 Windows 版本（`mediamtx_vX.X.X_windows_amd64.zip`），解压到 `D:\mediamtx\`。

### 2. 配置 MediaMTX

将仓库中的 `mediamtx.yml.example` 复制为 `mediamtx.yml`，修改以下部分：

```yaml
# 日志级别
logLevel: info

# 启用 WebRTC（WHEP 协议）
webrtc: yes
webrtcAddress: :8889

# 关闭不需要的协议
api: no
rtsp: no
rtmp: no

# HLS 备选（可选）
hls: yes
hlsAddress: :8888

# 摄像头路径配置
paths:
  entrance:                          # 路径名，决定 WHEP 地址
    source: rtsp://admin:password@192.168.1.100:554/Streaming/Channels/101
  # 可添加多个摄像头
  # parking_a:
  #   source: rtsp://192.168.1.101:554/Streaming/Channels/101
```

**常见摄像头 RTSP URL 格式：**

| 品牌 | RTSP 地址格式 |
|------|-------------|
| 海康威视 | `rtsp://username:password@ip:554/Streaming/Channels/101` |
| 大华 | `rtsp://username:password@ip:554/cam/realmonitor?channel=1&subtype=0` |
| 宇视 | `rtsp://username:password@ip:554/media/video1` |
| 通用 ONVIF | `rtsp://username:password@ip:554/onvif1` |

### 3. 启动 MediaMTX

```powershell
# 进入 MediaMTX 目录，双击运行或命令行启动
cd D:\mediamtx
.\mediamtx.exe
```

启动成功后终端日志应显示：
```
[path entrance] [RTSP source] started
[path entrance] [RTSP source] ready
[path entrance] stream is available and online, 2 tracks (H264, MPEG-4 Audio)
```

此时 WebRTC 地址为：`http://localhost:8889/entrance`

> **注意**：`entrance` 对应配置文件中 `paths:` 下的键名。如果你用了其他路径名（如 `parking_a1`），地址也相应变为 `http://localhost:8889/parking_a1`。

### 4. 在前端配置视频流

1. 打开 `http://localhost:3000/admin.html`
2. 在"监控画面"区域点击"添加监控画面"
3. 视频类型选择 **WebRTC**
4. 视频地址填入 `/webrtc/parking_a1`（相对路径，经 Nginx 代理）
5. 画面名称填写描述文字（如"停车场入口"）
6. 点击"保存配置"

刷新 `http://localhost`（Nginx 统一入口 :80）即可看到视频。

> **为什么使用 Nginx 反向代理**：页面（:3000）和 WebRTC 信令（:8889）端口不同，通过 Nginx 统一到 :80，从根源消除跨域问题，无需禁用浏览器安全策略。

### 5. WebRTC 优势

| 特性 | WebRTC | HLS | FLV |
|------|--------|-----|-----|
| 延迟 | **<1 秒** | 2-5 秒 | 1-3 秒 |
| 浏览器支持 | **原生**（无需 JS 库） | 需 hls.js | 需 flv.js |
| 协议 | UDP（WHEP） | TCP (HTTP) | TCP (HTTP) |
| 适用场景 | 实时监控 | 点播/回放 | 直播 |

### 6. 故障排查

| 现象 | 可能原因 | 解决办法 |
|------|----------|----------|
| 页面黑屏，无视频 | RTSP 源未推流 | 检查摄像头 / RTSP 流是否正常 |
| `no stream is available` | MediaMTX 连不上 RTSP 源 | 检查 RTSP 地址、网络、账号密码 |
| WebRTC 连接失败 | 网络不通 / UDP 被阻断 | 检查防火墙，确保 :8889 可达 |
| `UDP timeout` | RTSP 源断连 | 重启摄像头推流，MediaMTX 会自动重连 |
| 信令 404 | 路径名不匹配 | 确认 `paths:` 下的键名与 URL 中的路径一致 |
| CORS 跨域报错 | 直接访问 :8889 | 改为通过 Nginx :80 代理访问（`/webrtc/...`） |

> **CORS 说明**：始终通过 Nginx 统一入口（`http://localhost`）访问大屏，不要直接访问 `:3000` 或 `:8889` 端口。Nginx 将所有资源代理到 :80，同源无跨域。

---

## 开机自启（Windows）

部署到户外大屏的电脑需要配置开机自启，防止意外关机重启后服务中断。

### 方式一：任务计划程序（推荐，无需额外软件）

Windows 任务计划程序支持**系统启动时自动运行**、**未登录也能运行**、**失败后自动重启**。

**为每个服务创建计划任务：**

1. **MediaMTX 任务**：程序 `D:\mediamtx\mediamtx.exe`，起始于 `D:\mediamtx`，延迟 10 秒
2. **Python 服务任务**：程序 `uv`，参数 `run python server.py --port 3000 --parkid-a 20210001 --parkid-b 20210002`，起始于 `D:\AI\VideoUI`，延迟 15 秒
3. **Nginx 任务**：程序 `D:\nginx\nginx.exe`，起始于 `D:\nginx`，延迟 5 秒

每个任务配置：
- **常规** → "不管用户是否登录都要运行" + "使用最高权限"
- **触发器** → "启动时"
- **设置** → 失败后重启间隔 `1 分钟`，最多 `5 次`

详细配置步骤参考 `deploy.md`。

### 方式二：启动文件夹（备选，需自动登录）

1. 将 `start-all.bat` 创建快捷方式
2. 按 `Win + R`，输入 `shell:startup`，回车
3. 将快捷方式拖入启动文件夹

> **注意**：此方式需要用户登录后才能启动。建议配合 Windows **自动登录**（`netplwiz`）使用。

### 方式三：nssm 注册 Windows 服务

详见 `deploy.md`。

### 验证自启是否生效

```bash
# 检查各服务端口是否在监听
netstat -ano | findstr ":3000"    # Python 服务
netstat -ano | findstr ":8889"    # MediaMTX WebRTC
netstat -ano | findstr ":80"      # Nginx
```

浏览器打开 `http://localhost`，能正常显示大屏页面即为成功。

---

## 停车场客户端上报

停车场在车位变动时，向服务端发送 POST 请求：

```bash
curl -X POST http://<server>:3000/parking \
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
- 前端展示：总停车位 = a.total + b.total，总空闲车位 = a.available + b.available
- 如果某个车场尚未收到过上报，对应值为 `null`

## 配置管理

打开 `admin.html` 页面进行配置，所有设置保存在浏览器 localStorage 中。

| 配置项 | 说明 | 默认值 |
|---|---|---|
| 景区名称 | 大屏顶部显示的停车场名称 | xxxx景区游客中心停车场 |
| 停车场 ParkID | 停车场标识，需与服务端 --parkid-a 一致 | 20210001 |
| 停车楼 ParkID | 停车楼标识，需与服务端 --parkid-b 一致 | 20210002 |
| 数据刷新间隔 | 前端轮询服务端的频率（秒） | 2 |
| 监控画面 | 视频流列表，类型选 **WebRTC**，地址填 `/webrtc/<path>` | 空 |
| 画面切换间隔 | 多路画面轮播切换间隔（秒） | 10 |
| 本地视频目录 | `/videos/` 下的子文件夹，用于广告轮播 | 空 |

## 工作流程

1. 启动 MediaMTX → 连接 RTSP 摄像头，提供 WebRTC WHEP 信令端点
2. 启动 `server.py`（通过 `uv run`），监听 3000 端口
3. 启动 Nginx 反向代理，统一 :80 入口
4. 停车场客户端在车位变动时 POST 上报数据到 `/parking`
5. 前端页面每 N 秒轮询 `GET /api/parking/status`，更新车位数字
6. 前端通过浏览器原生 WebRTC API 连接 WHEP 端点，渲染视频到 `<video>` 标签
7. 管理页修改配置后，大屏页面自动热更新（跨标签页 storage 事件）

## 错误处理

- 前端轮询失败保留上次有效值
- 连续 3 次失败 → 显示 `--`，状态指示灯变红
- WebRTC 连接断开 → 自动重连
- 恢复后自动切回正常显示

## 文件结构

```
VideoUI/
├── server.py              # HTTP 服务端（接收 POST + 托管静态文件）
├── start-all.bat          # 一键启动所有服务
├── stop-all.bat           # 一键停止所有服务
├── restart-all.bat        # 一键重启所有服务
├── nginx.conf             # Nginx 反向代理配置
├── mediamtx.yml.example   # MediaMTX 配置模板（WebRTC + HLS）
├── pyproject.toml         # Python 项目配置（uv 管理）
├── index.html             # 大屏展示页
├── admin.html             # 配置管理页
├── css/
│   └── style.css          # 样式（9:4 自适应、户外大字体）
├── js/
│   ├── config.js          # 配置读写（localStorage）
│   ├── main.js            # 大屏逻辑（数据轮询、视频轮播、数字动画）
│   └── admin.js           # 管理页表单逻辑
├── logs/                  # 服务运行日志（按天分文件）
└── README.md
```

## 浏览器兼容

支持所有现代浏览器（Chrome、Edge、Firefox、Safari）。WebRTC 在所有主流浏览器上原生支持。
