# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

停车场大屏展示页面 — 面向游客的 9:4 宽屏实时监控画面。左 3/4 为监控画面，右 1/4 为车位信息（总车位红色、空闲车位绿色）。同一时间只展示停车场或停车楼的画面及车位信息，两个车场的画面及车位信息每 10s 切换更新。纯静态页面，无登录。

## 常用命令

```bash
# 启动服务端（接收停车场 POST + 托管静态文件）
python server.py --port 8080 --parkid-a 20210001 --parkid-b 20210002

# 模拟停车场上报
curl -X POST http://localhost:8080/api/parkingspace \
  -H "Content-Type: application/json" \
  -d '{"service":"parkingspace","parkid":"20210001","spacetotal":1000,"spaceLeft":978,"spaceused":22,"time":"2021-02-01 18:24:25","remark":""}'
```

浏览器打开 `http://localhost:8080` 查看大屏，`http://localhost:8080/admin.html` 进入配置管理。

## 架构

```
停车场客户端 → POST /api/parkingspace → server.py (内存存储) ← GET /api/parking/status ← 前端轮询
```

```
server.py           → HTTP 服务端：接收 POST、提供 GET、托管静态文件
index.html          → 主展示页：左 3/4 视频 (CSS Grid 堆叠) + 右 1/4 车位卡片
admin.html          → 配置管理页：所有设置写入 localStorage
css/style.css       → 全局样式：9:4 自适应容器、卡片、视频面板、管理页表单
js/config.js        → 配置读写模块：getConfig() / saveConfig() / resetConfig()
js/main.js          → 主屏逻辑：轮询 GET /api/parking/status、A/B 旋转、数字动画、错误降级
js/admin.js         → 管理页表单：加载当前配置、保存、重置
```

### 数据流

1. 停车场客户端在车位变动时 POST 到 `/api/parkingspace`，server.py 按 parkid 存入内存
2. 前端 `main.js` 按 `pollInterval` 秒轮询 `GET /api/parking/status`，获取 A/B 两个车场最新数据
3. 数据缓存到 `lastData.A` / `lastData.B`，只更新当前显示的车场 UI
4. 旋转定时器按 `rotationInterval` 秒切换 A/B，切换时从缓存取数据显示
5. 配置在另一标签页修改时，`main.js` 通过 `storage` 事件自动热重载

### ParkID 映射

- server.py 通过 `--parkid-a` / `--parkid-b` 启动参数指定 A/B 对应的 parkid
- 前端 `config.js` 中的 `parkIdA` / `parkIdB` 需与服务端一致
- GET `/api/parking/status` 返回 `{a: {total, available}, b: {total, available}}`，其中 a/b 对应 parkid-a/parkid-b
- 某车场尚未收到上报时对应值为 `null`

### API 约定

- **POST `/api/parkingspace`**：停车场客户端上报，body 包含 `parkid`、`spacetotal`、`spaceLeft` 等
- **GET `/api/parking/status`**：前端轮询，返回 `{a: {total, available}, b: {total, available}}`

### 错误处理策略

- 前端轮询超时依赖浏览器默认行为（本地服务器响应快）
- 单次失败保留上次有效值
- 连续 3 次失败 → 显示 "--"，状态指示点变红
- 恢复后自动切回正常显示
- A/B 各自独立追踪错误状态
