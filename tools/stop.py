#!/usr/bin/env python3
"""停车场大屏 — 一键停止器

停止 MediaMTX、Nginx、Python 服务端、Chrome Kiosk 所有进程。
用法: python tools/stop.py [--log-file <path>]
      --log-file  可选，同时将输出写入指定日志文件（用于定时任务无人值守）
"""

import argparse
import os
import subprocess
import sys


class TeeWriter:
    """同时写入原始 stdout 和日志文件。"""
    def __init__(self, original_stdout, log_path):
        self.original = original_stdout
        log_dir = os.path.dirname(log_path)
        if log_dir:
            os.makedirs(log_dir, exist_ok=True)
        self.log = open(log_path, 'a', encoding='utf-8')

    def write(self, data):
        self.original.write(data)
        self.log.write(data)

    def flush(self):
        try:
            self.original.flush()
        except (ValueError, OSError):
            pass
        try:
            self.log.flush()
        except (ValueError, OSError):
            pass

    def close(self):
        self.log.close()


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


def kill_chrome_kiosk():
    """终止 kiosk 模式的 Chrome 窗口（仅关闭含 --kiosk 参数的 Chrome 进程，不影响普通 Chrome 窗口）。"""
    ps_cmd = (
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | "
        "Where-Object { $_.CommandLine -like '*--kiosk*' } | "
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
    parser = argparse.ArgumentParser(description='停车场大屏 — 一键停止器')
    parser.add_argument('--log-file', type=str, default=None,
                        help='日志文件路径，同时将输出写入该文件')
    args = parser.parse_args()

    # 如果指定了日志文件，将输出同时写入日志
    tee = None
    if args.log_file:
        tee = TeeWriter(sys.stdout, args.log_file)
        sys.stdout = tee

    print("=" * 60)
    print("  停车场大屏 — 一键停止")
    print("=" * 60)
    print()

    # ── 1. 停止 Nginx ──
    print("[1/4] 停止 Nginx...")
    kill_by_name("nginx.exe")
    print("  Nginx 已停止（如未运行则忽略）")
    print()

    # ── 2. 停止 MediaMTX ──
    print("[2/4] 停止 MediaMTX...")
    kill_by_name("mediamtx.exe")
    print("  MediaMTX 已停止（如未运行则忽略）")
    print()

    # ── 3. 停止 Python 服务端 ──
    print("[3/4] 停止 Python 服务端...")
    kill_server_py()
    print("  Python 服务端 已停止（如未运行则忽略）")
    print()

    # ── 4. 关闭 Chrome 大屏（kiosk）──
    print("[4/4] 关闭 Chrome 大屏（kiosk）...")
    kill_chrome_kiosk()
    print("  Chrome 已关闭（如未运行则忽略）")

    print()
    print("=" * 60)
    print("  所有服务已停止。")
    print("  需要重新启动？双击「启动.bat」。")
    print("=" * 60)
    print()

    if tee:
        tee.close()


if __name__ == "__main__":
    main()
