#!/usr/bin/env python3
"""停车场大屏 — 一键启动器

读取 config.json，自动生成配置并启动所有服务。
用法: python tools/launch.py
"""

import json
import os
import subprocess
import sys
import time

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(PROJECT_ROOT, "config.json")


def load_config():
    if not os.path.isfile(CONFIG_PATH):
        print("[错误] 找不到 config.json，请确保文件存在于项目根目录。")
        sys.exit(1)
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def run_python(script_path):
    """使用项目 venv 中的 Python 执行脚本。"""
    venv_python = os.path.join(PROJECT_ROOT, ".venv", "Scripts", "python.exe")
    if os.path.isfile(venv_python):
        return subprocess.run([venv_python, script_path], cwd=PROJECT_ROOT, check=False)
    else:
        return subprocess.run([sys.executable, script_path], cwd=PROJECT_ROOT, check=False)


def start_process(exe_path, work_dir, title):
    """后台启动一个进程（最小化窗口）。"""
    if not os.path.isfile(exe_path):
        print(f"  [警告] 找不到 {exe_path}，跳过")
        return None
    # 用 cmd start /MIN 启动，窗口标题设为 title
    cmd = f'start "{title}" /MIN "{exe_path}"'
    return subprocess.Popen(
        cmd, shell=True, cwd=work_dir,
        creationflags=subprocess.CREATE_NEW_CONSOLE if sys.platform == "win32" else 0,
    )


def main():
    print("=" * 60)
    print("  停车场大屏 — 一键启动")
    print("=" * 60)
    print()

    config = load_config()

    # ── 1. 生成配置文件 ──
    print("[1/4] 生成配置文件...")
    generate_script = os.path.join(PROJECT_ROOT, "tools", "generate_config.py")
    result = run_python(generate_script)
    if result.returncode != 0:
        print()
        print("[错误] 配置生成失败，请检查 config.json 是否正确。")
        print("常见问题：JSON 格式错误（逗号、引号）。")
        print("可以用 https://jsonlint.com/ 在线检查 JSON 语法。")
        return
    print()

    # ── 2. 启动 MediaMTX ──
    print("[2/4] 启动 MediaMTX（RTSP 转 WebRTC）...")
    mediamtx_path = config.get("mediamtx_path", r"D:\mediamtx\mediamtx.exe")
    mediamtx_dir = os.path.dirname(mediamtx_path)
    start_process(mediamtx_path, mediamtx_dir, "MediaMTX")
    print("  已启动")
    print()

    # ── 3. 启动 Nginx ──
    print("[3/4] 启动 Nginx（Web 反向代理）...")
    nginx_path = config.get("nginx_path", r"D:\nginx\nginx.exe")
    nginx_dir = os.path.dirname(nginx_path)
    start_process(nginx_path, nginx_dir, "Nginx")
    print("  已启动")
    print()

    # ── 4. 启动 Python 服务端 ──
    print("[4/4] 启动 Python 服务端...")
    port = config.get("server_port", 3000)
    parkid_a = config.get("parkid_a", "cbssstcc")
    parkid_b = config.get("parkid_b", "cbsjqtcl")
    video_dir = config.get("video_dir", "D:/videos")

    server_py = os.path.join(PROJECT_ROOT, "server.py")
    venv_python = os.path.join(PROJECT_ROOT, ".venv", "Scripts", "python.exe")
    python_exe = venv_python if os.path.isfile(venv_python) else sys.executable

    server_cmd = (
        f'start "ParkingServer" /MIN cmd /c "'
        f'title ParkingServer && '
        f'"{python_exe}" "{server_py}" '
        f'--port {port} --parkid-a {parkid_a} --parkid-b {parkid_b} '
        f'--video-dir "{video_dir}" && pause"'
    )
    subprocess.Popen(server_cmd, shell=True, cwd=PROJECT_ROOT)
    print("  已启动")
    print()

    # ── 等待服务就绪 ──
    print("等待服务就绪（5 秒）...")
    time.sleep(5)

    # ── 打开 Chrome 浏览器（全屏 Kiosk 模式）──
    print("打开 Chrome 浏览器...")
    chrome_paths = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    ]
    chrome_exe = None
    for p in chrome_paths:
        if os.path.isfile(p):
            chrome_exe = p
            break

    if chrome_exe:
        subprocess.Popen(
            [chrome_exe, "--kiosk", "--disable-restore-session-state",
             "--disable-session-crashed-bubble", "--disable-features=TranslateUI",
             "http://localhost"],
            close_fds=True,
        )
    else:
        print("  [警告] 找不到 Chrome，使用默认浏览器打开")
        subprocess.run(["cmd", "/c", "start", "http://localhost"], shell=True)

    print()
    print("=" * 60)
    print("  启动完成！浏览器已打开大屏页面。")
    print()
    print("  关闭本窗口不会影响服务运行。")
    print("  需要停止服务？双击「停止.bat」。")
    print("=" * 60)
    print()


if __name__ == "__main__":
    main()
