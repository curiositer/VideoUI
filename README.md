# 停车场大屏实时监控

9:4 宽屏停车场实时监控展示页面，面向户外大屏游客场景，无需登录。

## 页面布局

```
┌────────────────────────────┬──────────┐
│                            │ A 停车场  │
│                            │          │
│       监控画面              │ 空闲 128  │  ← 绿色
│    （A/B 10秒轮换）          │ 总 200   │  ← 红色
│                            │          │
│                            │   个     │
└────────────────────────────┴──────────┘
  ←──────── 3/4 ────────→  ←── 1/4 ──→
```

- **左 3/4**：实时监控画面，A/B 停车场自动轮换
- **右 1/4**：当前停车场名称 + 空闲车位（绿色大字）+ 总车位（红色大字）
- **轮换间隔**：默认 10 秒，可在管理页配置

## 架构

```
停车场客户端 → POST /api/parkingspace → server.py (内存) ← GET /api/parking/status ← 前端(poll)
```

- **server.py**：Python 内置模块实现的 HTTP 服务端，零外部依赖
  - 接收停车场客户端 POST 上报的车位数据
  - 按 parkid 分别存储，供前端轮询
  - 同时托管静态文件（index.html / admin.html / css / js）
- **前端**：纯静态页面，每 N 秒轮询本地服务端获取最新数据
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

- `a` / `b` 分别对应 `--parkid-a` / `--parkid-b` 指定的车场
- 如果某个车场尚未收到过上报，对应值为 `null`

## 配置管理

打开 `admin.html` 页面进行配置，所有设置保存在浏览器 localStorage 中。

| 配置项 | 说明 | 默认值 |
|---|---|---|
| ParkID A / B | 车场标识，需与服务端启动参数一致 | 20210001 / 20210002 |
| 数据刷新间隔 | 前端轮询服务端的频率（秒） | 2 |
| A/B 切换间隔 | 两个车场轮换显示的间隔（秒） | 10 |
| 视频 URL (A/B) | 监控画面地址（IP 摄像头网页或 .m3u8 流） | 空（显示占位符） |
| 视频嵌入方式 | iframe（摄像头网页）/ hls（.m3u8 流） | iframe |
| 车场显示名称 | 卡片上显示的名称 | 停车场 / 停车楼 |

## 工作流程

1. 启动 `server.py`，监听 8080 端口
2. 停车场客户端在车位变动时 POST 上报数据到 `/api/parkingspace`
3. 前端页面每 2 秒轮询 `GET /api/parking/status`，更新缓存
4. 默认显示 A 车场（视频 + 车位信息）
5. 每 10 秒切换到 B 车场，循环往复
6. 管理页修改配置后，大屏页面自动热更新（跨标签页 storage 事件）

## 错误处理

- 前端轮询失败保留上次有效值
- 连续 3 次失败 → 显示 `--`，状态指示灯变红
- 恢复后自动切回正常显示
- A/B 各自独立追踪错误状态

## 文件结构

```
VideoUI/
├── server.py       # HTTP 服务端（接收 POST + 托管静态文件）
├── index.html      # 大屏展示页
├── admin.html      # 配置管理页
├── css/
│   └── style.css   # 样式（9:4 自适应、户外大字体）
├── js/
│   ├── config.js   # 配置读写（localStorage）
│   ├── main.js     # 大屏逻辑（轮换、数据轮询、动画）
│   └── admin.js    # 管理页表单逻辑
└── README.md
```

## 浏览器兼容

支持所有现代浏览器（Chrome、Edge、Firefox、Safari）。

> **提示**：监控视频流可能涉及跨域问题。如使用 iframe 嵌入摄像头页面，需确保摄像头服务允许被嵌入（`X-Frame-Options`）。HLS 流（.m3u8）在非 Safari 浏览器上可能需要 HLS.js 播放器支持。
