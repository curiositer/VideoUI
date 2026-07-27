#!/usr/bin/env python3
"""配置生成器 —— 从 config.json 生成 MediaMTX 和前端所需的配置文件。

用法:
    uv run python tools/generate_config.py

产物:
    D:/mediamtx/mediamtx.yml  — MediaMTX 配置文件（摄像头 RTSP → WebRTC 桥接）
    ./cameras.json             — 前端首次加载时使用的摄像头列表（含主备流）
"""

import json
import os
import sys

# ---------------------------------------------------------------------------
# 路径常量
# ---------------------------------------------------------------------------
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(PROJECT_ROOT, "config.json")
MEDIAMTX_DIR = r"D:\mediamtx"
MEDIAMTX_CONFIG_PATH = os.path.join(MEDIAMTX_DIR, "mediamtx.yml")
CAMERAS_JSON_PATH = os.path.join(PROJECT_ROOT, "cameras.json")

# MediaMTX 配置模板（固定部分）
MEDIAMTX_TEMPLATE = """# ============================================================================
# MediaMTX 配置 — 由 tools/generate_config.py 自动生成
# 修改摄像头请编辑项目根目录的 config.json，然后重新运行「启动.bat」
# ============================================================================

logLevel: info
api: yes
rtsp: no
rtmp: no
hls: yes
hlsAddress: :8888
webrtc: yes
webrtcAddress: :8889

paths:
{paths}
"""


def load_config():
    """读取项目根目录的 config.json。"""
    if not os.path.isfile(CONFIG_PATH):
        print(f"[错误] 找不到配置文件: {CONFIG_PATH}")
        print("请确保 config.json 存在于项目根目录。")
        sys.exit(1)

    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            config = json.load(f)
    except json.JSONDecodeError as e:
        print(f"[错误] config.json 格式不正确: {e}")
        print("请检查 JSON 语法（逗号、引号等），可用 https://jsonlint.com/ 在线检查。")
        sys.exit(1)

    # 校验必填字段
    cameras = config.get("cameras", [])
    if not cameras:
        print("[警告] config.json 中没有配置任何摄像头（cameras 数组为空）。")
        print("大屏将只显示车位信息，不显示监控画面。")
    else:
        for i, cam in enumerate(cameras):
            if not cam.get("name"):
                print(f"[错误] 第 {i + 1} 个摄像头缺少 name 字段")
                sys.exit(1)
            if not cam.get("rtsp"):
                print(f"[错误] 摄像头「{cam.get('name', '未知')}」缺少 rtsp 字段")
                sys.exit(1)

            # 校验备用流（温和警告，不阻断启动）
            for j, bak in enumerate(cam.get("backups", [])):
                if "rtsp" not in bak:
                    print(f"[警告] 摄像头「{cam['name']}」的第 {j + 1} 个备用流"
                          f"缺少 rtsp 字段，将被跳过")
                elif "name" not in bak:
                    print(f"[提示] 摄像头「{cam['name']}」的第 {j + 1} 个备用流"
                          f"缺少 name，将使用默认名称")

    return config


# ---------------------------------------------------------------------------
# 收集所有 RTSP 流（包括主画面和备用流），统一分配 MediaMTX 路径名
# ---------------------------------------------------------------------------

def collect_rtsp_entries(cameras):
    """遍历所有摄像头及其备用流，返回 (路径名, RTSP地址, 标签) 列表。

    路径命名规则:
      - 主画面: cam_1, cam_2, ...
      - 备用流: cam_1_bak_1, cam_1_bak_2, ...
    """
    entries = []
    for i, cam in enumerate(cameras):
        cam_idx = i + 1
        # 主画面
        entries.append((
            f"cam_{cam_idx}",
            cam["rtsp"],
            cam.get("name", f"摄像头{cam_idx}"),
        ))
        # 备用 RTSP 流
        for j, bak in enumerate(cam.get("backups", [])):
            if "rtsp" not in bak:
                continue
            bak_idx = j + 1
            entries.append((
                f"cam_{cam_idx}_bak_{bak_idx}",
                bak["rtsp"],
                bak.get("name", f"备用{bak_idx}"),
            ))
    return entries


def generate_mediamtx_yml(rtsp_entries):
    """根据 RTSP 流列表生成 MediaMTX 配置文件的 paths 部分。"""
    if not rtsp_entries:
        return MEDIAMTX_TEMPLATE.format(paths="  # （无摄像头配置）")

    path_entries = []
    for path_name, rtsp_url, label in rtsp_entries:
        path_entries.append(
            f"  # {label}\n"
            f"  {path_name}:\n"
            f"    source: {rtsp_url}\n"
            f"    rtspTransport: tcp\n"
            f"    sourceOnDemand: yes"
        )

    return MEDIAMTX_TEMPLATE.format(paths="\n".join(path_entries))


def generate_cameras_json(cameras):
    """生成前端 cameras.json —— 摄像头列表（含主备流，videoStreams 格式）。

    备用流全部为 RTSP 摄像头，自动分配 MediaMTX 路径 /webrtc/cam_X_bak_Y。
    """
    streams = []
    for i, cam in enumerate(cameras):
        cam_idx = i + 1
        label = cam.get("name", f"摄像头{cam_idx}")

        # 构建备用流列表（全部为 webrtc 类型）
        backups = []
        for j, bak in enumerate(cam.get("backups", [])):
            if "rtsp" not in bak:
                continue
            bak_idx = j + 1
            backups.append({
                "url": f"/webrtc/cam_{cam_idx}_bak_{bak_idx}",
                "type": "webrtc",
            })

        streams.append({
            "url": f"/webrtc/cam_{cam_idx}",
            "type": "webrtc",
            "label": label,
            "backups": backups,
        })

    return streams


def write_file(path, content):
    """写入文件，自动创建父目录。"""
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"  [OK] 已生成: {path}")


def main():
    print("=" * 60)
    print("  停车场大屏 — 配置生成器")
    print("=" * 60)

    # 1. 读取配置
    print("\n[1/4] 读取 config.json ...")
    config = load_config()
    cameras = config.get("cameras", [])
    print(f"  发现 {len(cameras)} 个摄像头")

    # 统计备用流
    rtsp_entries = collect_rtsp_entries(cameras)
    total_bak = len(rtsp_entries) - len(cameras)
    print(f"  共 {len(rtsp_entries)} 个 RTSP 流（{len(cameras)} 主画面 + {total_bak} 备用）")

    # 2. 打印摄像头与备用流概览
    for i, cam in enumerate(cameras):
        bak_count = len(cam.get("backups", []))
        bak_info = f" ({bak_count} 个备用流)" if bak_count > 0 else ""
        print(f"    cam_{i + 1}: {cam.get('name', '未知')}{bak_info}")

    # 3. 生成 mediamtx.yml
    print(f"\n[2/4] 生成 MediaMTX 配置 ...")
    if not os.path.isdir(MEDIAMTX_DIR):
        print(f"  [警告] MediaMTX 目录不存在: {MEDIAMTX_DIR}")
        print(f"  已生成文件，但请确保 MediaMTX 安装在此目录。")
    mediamtx_yml = generate_mediamtx_yml(rtsp_entries)
    write_file(MEDIAMTX_CONFIG_PATH, mediamtx_yml)

    # 4. 生成 cameras.json（前端用）
    print(f"\n[3/4] 生成前端摄像头列表（含主备流）...")
    camera_list = generate_cameras_json(cameras)
    cameras_json = json.dumps(camera_list, ensure_ascii=False, indent=2)
    write_file(CAMERAS_JSON_PATH, cameras_json)

    # 5. 汇总
    print("\n[4/4] 汇总")
    print("=" * 60)
    print("  配置生成完毕！")
    print("=" * 60)
    print(f"\n摄像头 WHEP 地址（主画面）:")
    for i, cam in enumerate(cameras):
        print(f"  {cam.get('name', '未知')}: http://localhost/webrtc/cam_{i + 1}/whep")
        for j, bak in enumerate(cam.get("backups", [])):
            if "rtsp" in bak:
                print(f"    备用 {j + 1}: http://localhost/webrtc/cam_{i + 1}_bak_{j + 1}/whep")
    print()


if __name__ == "__main__":
    main()
