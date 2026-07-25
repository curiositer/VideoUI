#!/usr/bin/env python3
"""停车场大屏 — 一键停止器

停止 MediaMTX、Nginx、Python 服务端所有进程。
用法: python tools/stop.py
"""

import subprocess
import sys


def kill_by_name(name):
    """按进程名强制终止。"""
    try:
        subprocess.run(
            ["taskkill", "/F", "/IM", name],
            capture_output=True, check=False,
        )
    except FileNotFoundError:
        pass


def kill_server_py():
    """终止运行 server.py 的 Python 进程（精确匹配，不影响其他 Python 程序）。"""
    # 方法1：通过窗口标题终止（ParkingServer 窗口）
    try:
        subprocess.run(
            ["taskkill", "/F", "/T", "/FI", "WINDOWTITLE eq ParkingServer"],
            capture_output=True, check=False,
        )
    except FileNotFoundError:
        pass

    # 方法2：PowerShell 兜底 — 精确查找命令行含 server.py 的 python 进程
    ps_cmd = (
        'Get-CimInstance Win32_Process -Filter "Name=\'python.exe\'" | '
        "Where-Object { $_.CommandLine -like '*server.py*' } | "
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
    )
    try:
        subprocess.run(
            ["powershell", "-Command", ps_cmd],
            capture_output=True, check=False,
        )
    except FileNotFoundError:
        pass


def main():
    print("=" * 60)
    print("  停车场大屏 — 一键停止")
    print("=" * 60)
    print()

    # ── 1. 停止 Nginx ──
    print("[1/3] 停止 Nginx...")
    kill_by_name("nginx.exe")
    print("  Nginx 已停止（如未运行则忽略）")
    print()

    # ── 2. 停止 MediaMTX ──
    print("[2/3] 停止 MediaMTX...")
    kill_by_name("mediamtx.exe")
    print("  MediaMTX 已停止（如未运行则忽略）")
    print()

    # ── 3. 停止 Python 服务端 ──
    print("[3/3] 停止 Python 服务端...")
    kill_server_py()
    print("  Python 服务端 已停止（如未运行则忽略）")

    print()
    print("=" * 60)
    print("  所有服务已停止。")
    print("  需要重新启动？双击「启动.bat」。")
    print("=" * 60)
    print()


if __name__ == "__main__":
    main()
