#!/usr/bin/env python3
"""Parking Display Server — receives POST from parking lot clients, serves frontend.

Usage:
    python server.py --port 8080 --parkid-a 20210001 --parkid-b 20210002

Endpoints:
    GET  /                   → index.html (main display page)
    GET  /admin.html         → admin config page
    GET  /css/*, /js/*       → static assets
    POST /parking            → parking lot client reports space data
    GET  /api/parking/status → frontend polls this for latest data
    GET  /api/video-list     → list video files in configured folder
"""

import argparse
import glob
import json
import os
import re
import sys
import threading
import time
from datetime import datetime, timedelta
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import parse_qs, urlparse


# ---------------------------------------------------------------------------
# In-memory store: latest parking data keyed by parkid
# ---------------------------------------------------------------------------
_store_lock = threading.Lock()
_store = {}  # type: ignore[var-annotated]

# --- 诊断日志 ---
DIAG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
DIAG_MAX_DAYS = 30  # 自动清理 30 天前的日志
_DIAG_WRITE_LOCK = threading.Lock()
_SERVER_START_TIME = time.time()


def update_parking_data(parkid: str, data: dict) -> None:
    """Thread-safe update of in-memory parking data."""
    with _store_lock:
        _store[parkid] = {
            "total": data["spacetotal"],
            "available": data["spaceLeft"],
            "used": data.get("spaceused", 0),
            "time": data.get("time", ""),
            "updated_at": time.time(),
        }


def get_status(parkid_a: str, parkid_b: str) -> dict:
    """Return {a: {...}, b: {...}} for frontend consumption."""
    with _store_lock:
        a = _store.get(parkid_a)
        b = _store.get(parkid_b)

    def fmt(entry):
        if entry is None:
            return None
        return {"total": entry["total"], "available": entry["available"]}

    return {"a": fmt(a), "b": fmt(b)}


# ---------------------------------------------------------------------------
# Diagnostic log helpers
# ---------------------------------------------------------------------------

def _diag_log_path(date_str: str = None) -> str:
    """返回指定日期的诊断日志文件路径，默认今天。"""
    if date_str is None:
        date_str = time.strftime("%Y-%m-%d")
    # 安全检查：日期格式必须是 YYYY-MM-DD
    if not re.match(r'^\d{4}-\d{2}-\d{2}$', date_str):
        raise ValueError("Invalid date format")
    return os.path.join(DIAG_DIR, f"{date_str}.jsonl")


def save_diagnostics(events: list) -> int:
    """追加事件到今天的日志文件（JSON Lines 格式）。
    返回实际写入的事件数。
    """
    if not events:
        return 0
    os.makedirs(DIAG_DIR, exist_ok=True)
    filepath = _diag_log_path()
    count = 0
    with _DIAG_WRITE_LOCK:
        try:
            with open(filepath, "a", encoding="utf-8") as f:
                for evt in events:
                    f.write(json.dumps(evt, ensure_ascii=False) + "\n")
                    count += 1
        except OSError as e:
            print(f"[ERROR] 无法写入诊断日志: {e}", file=sys.stderr)
    return count


def read_diagnostics(date_str: str, level: str = None,
                     category: str = None, limit: int = 200,
                     offset: int = 0) -> tuple:
    """读取指定日期的诊断事件。
    返回 (events_list, total_count)。
    """
    filepath = _diag_log_path(date_str)
    if not os.path.isfile(filepath):
        return [], 0

    all_events = []
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    evt = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if level and evt.get("level") != level:
                    continue
                if category and evt.get("category") != category:
                    continue
                all_events.append(evt)
    except OSError as e:
        print(f"[ERROR] 无法读取诊断日志 {filepath}: {e}", file=sys.stderr)
        return [], 0

    # 按时间倒序（最新的在前）
    all_events.sort(key=lambda e: e.get("ts", ""), reverse=True)
    total = len(all_events)
    return all_events[offset:offset + limit], total


def summary_diagnostics(date_str: str) -> dict:
    """计算指定日期的诊断事件摘要。"""
    filepath = _diag_log_path(date_str)
    result = {
        "date": date_str,
        "total": 0,
        "byCategory": {},
        "byLevel": {"error": 0, "warn": 0, "info": 0},
        "highlights": [],  # 所有 error 级别的事件
        "failoverCount": 0,
        "freezeCount": 0,
        "cameraStats": {},
    }

    if not os.path.isfile(filepath):
        return result

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    evt = json.loads(line)
                except json.JSONDecodeError:
                    continue

                result["total"] += 1

                # 按级别统计
                lvl = evt.get("level", "info")
                if lvl in result["byLevel"]:
                    result["byLevel"][lvl] += 1

                # 按分类统计
                cat = evt.get("category", "system")
                result["byCategory"][cat] = result["byCategory"].get(cat, 0) + 1

                # 收集 error 级别高亮
                if lvl == "error":
                    result["highlights"].append({
                        "ts": evt.get("ts", ""),
                        "message": evt.get("message", ""),
                        "category": cat,
                    })

                # 故障切换计数
                msg = evt.get("message", "")
                if "故障切换" in msg or "failover" in msg.lower():
                    result["failoverCount"] += 1
                if "冻结" in msg or "freeze" in msg.lower():
                    result["freezeCount"] += 1

                # 摄像头统计（按 detail 中的 label 或 url）
                detail = evt.get("detail", {})
                if detail and isinstance(detail, dict):
                    cam_key = detail.get("label") or detail.get("url") or ""
                    if cam_key and ("故障切换" in msg or "冻结" in msg):
                        if cam_key not in result["cameraStats"]:
                            result["cameraStats"][cam_key] = {"failovers": 0, "freezes": 0}
                        if "故障切换" in msg or "failover" in msg.lower():
                            result["cameraStats"][cam_key]["failovers"] += 1
                        if "冻结" in msg or "freeze" in msg.lower():
                            result["cameraStats"][cam_key]["freezes"] += 1

    except OSError as e:
        print(f"[ERROR] 无法读取诊断日志 {filepath}: {e}", file=sys.stderr)

    # highlights 只保留最近 50 条
    result["highlights"].sort(key=lambda e: e.get("ts", ""), reverse=True)
    result["highlights"] = result["highlights"][:50]

    return result


def cleanup_old_logs():
    """删除超过 DIAG_MAX_DAYS 天的日志文件。"""
    if not os.path.isdir(DIAG_DIR):
        return
    cutoff = datetime.now() - timedelta(days=DIAG_MAX_DAYS)
    pattern = os.path.join(DIAG_DIR, "*.jsonl")
    for filepath in glob.glob(pattern):
        try:
            mtime = datetime.fromtimestamp(os.path.getmtime(filepath))
            if mtime < cutoff:
                os.remove(filepath)
                print(f"[CLEANUP] 已删除过期日志: {os.path.basename(filepath)}")
        except OSError as e:
            print(f"[CLEANUP] 删除失败 {filepath}: {e}", file=sys.stderr)


def _cleanup_loop():
    """后台线程：每小时清理一次过期日志。"""
    while True:
        time.sleep(3600)
        try:
            cleanup_old_logs()
        except Exception as e:
            print(f"[CLEANUP] 清理线程异常: {e}", file=sys.stderr)


# ---------------------------------------------------------------------------
# MIME type helpers
# ---------------------------------------------------------------------------
MIME_MAP = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


def guess_mime(path: str) -> str:
    _, ext = os.path.splitext(path)
    return MIME_MAP.get(ext.lower(), "application/octet-stream")


# ---------------------------------------------------------------------------
# Request Handler
# ---------------------------------------------------------------------------
class ParkingServer(SimpleHTTPRequestHandler):
    """Custom handler: API routes + static file fallback."""

    # Injected by server factory
    parkid_a: str = ""
    parkid_b: str = ""
    video_dir: str = ""

    def __init__(self, *args, **kwargs):
        # Serve from the script's directory
        self.directory = os.path.dirname(os.path.abspath(__file__))
        super().__init__(*args, directory=self.directory, **kwargs)

    def log_message(self, format, *args):
        """Override to include timestamp and write full log line."""
        timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
        message = format % args if args else format
        sys.stderr.write(f"[{timestamp}] {message}\n")

    # ---- Routing ----------------------------------------------------------

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/parking/status":
            self._handle_status()
        elif path == "/api/video-list":
            self._handle_video_list()
        elif path == "/api/diagnostics":
            self._handle_diagnostics_query()
        elif path == "/api/diagnostics/summary":
            self._handle_diagnostics_summary()
        elif path == "/api/health":
            self._handle_health()
        elif path.startswith("/videos/"):
            self._serve_video_file(path)
        elif path == "/":
            self._serve_file("index.html")
        else:
            # Static files (e.g. /admin.html, /css/style.css, /js/main.js)
            self._serve_static(path)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/parking":
            self._handle_parkingspace()
        elif path == "/api/diagnostics":
            self._handle_diagnostics_post()
        else:
            self.send_error(404, "Not Found")

    # ---- API handlers -----------------------------------------------------

    def _handle_parkingspace(self):
        """Receive parking data from a parking lot client."""
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length == 0:
                self._json_error(400, "Empty body")
                return

            raw = self.rfile.read(content_length)
            body = json.loads(raw.decode("utf-8"))

            # Validate required fields
            parkid = str(body.get("parkid", ""))
            if not parkid:
                self._json_error(400, "Missing parkid")
                return
            if "spacetotal" not in body or "spaceLeft" not in body:
                self._json_error(400, "Missing spacetotal or spaceLeft")
                return

            update_parking_data(parkid, body)

            # Log to console
            known = "A" if parkid == self.parkid_a else ("B" if parkid == self.parkid_b else "?")
            print(
                f"[PARKING] parkid={parkid} ({known}) "
                f"total={body['spacetotal']} left={body['spaceLeft']}"
            )

            self._json_ok({"status": "ok", "parkid": parkid})

        except json.JSONDecodeError:
            self._json_error(400, "Invalid JSON")
        except Exception as e:
            print(f"[ERROR] POST /parking: {e}", file=sys.stderr)
            self._json_error(500, str(e))

    def _handle_status(self):
        """Return latest data for both A and B lots."""
        try:
            status = get_status(self.parkid_a, self.parkid_b)
            self._json_ok(status)
        except Exception as e:
            self._json_error(500, str(e))

    def _handle_video_list(self):
        """List video files in the configured video directory (or subfolder)."""
        try:
            parsed = urlparse(self.path)
            params = parse_qs(parsed.query)
            folder = params.get("folder", [""])[0]

            # Security: prevent directory traversal
            if ".." in folder or os.path.isabs(folder):
                self._json_error(403, "Forbidden")
                return

            base = self.video_dir or r"D:\videos"
            target = os.path.normpath(os.path.join(base, folder))

            # Ensure target is still within base directory
            if not target.startswith(os.path.normpath(base)):
                self._json_error(403, "Forbidden")
                return

            if not os.path.isdir(target):
                self._json_ok([])
                return

            VIDEO_EXTS = {".mp4", ".webm", ".mkv", ".mov", ".avi"}
            files = sorted([
                f for f in os.listdir(target)
                if os.path.splitext(f)[1].lower() in VIDEO_EXTS
                and os.path.isfile(os.path.join(target, f))
            ])

            self._json_ok(files)

        except Exception as e:
            print(f"[ERROR] GET /api/video-list: {e}", file=sys.stderr)
            self._json_error(500, str(e))

    def _handle_diagnostics_post(self):
        """接收前端批量上报的诊断事件（fire-and-forget）。"""
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length == 0 or content_length > 512 * 1024:
                self._json_ok({"status": "ok", "received": 0})
                return
            raw = self.rfile.read(content_length)
            events = json.loads(raw.decode("utf-8"))
            if not isinstance(events, list):
                self._json_ok({"status": "ok", "received": 0})
                return
            # 限制单批最多 200 条
            count = save_diagnostics(events[:200])
            self._json_ok({"status": "ok", "received": count})
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._json_ok({"status": "ok", "received": 0})
        except Exception as e:
            print(f"[ERROR] POST /api/diagnostics: {e}", file=sys.stderr)
            self._json_ok({"status": "ok", "received": 0})

    def _handle_diagnostics_query(self):
        """查询指定日期的事件列表。"""
        try:
            parsed = urlparse(self.path)
            params = parse_qs(parsed.query)
            date_str = params.get("date", [time.strftime("%Y-%m-%d")])[0]
            level = params.get("level", [None])[0]
            category = params.get("category", [None])[0]
            limit = min(int(params.get("limit", ["200"])[0]), 1000)
            offset = int(params.get("offset", ["0"])[0])

            events, total = read_diagnostics(date_str, level, category, limit, offset)
            self._json_ok({"events": events, "total": total})
        except ValueError as e:
            self._json_error(400, str(e))
        except Exception as e:
            print(f"[ERROR] GET /api/diagnostics: {e}", file=sys.stderr)
            self._json_error(500, str(e))

    def _handle_diagnostics_summary(self):
        """查询指定日期的诊断摘要。"""
        try:
            parsed = urlparse(self.path)
            params = parse_qs(parsed.query)
            date_str = params.get("date", [time.strftime("%Y-%m-%d")])[0]

            result = summary_diagnostics(date_str)
            self._json_ok(result)
        except ValueError as e:
            self._json_error(400, str(e))
        except Exception as e:
            print(f"[ERROR] GET /api/diagnostics/summary: {e}", file=sys.stderr)
            self._json_error(500, str(e))

    def _handle_health(self):
        """综合健康检查。"""
        try:
            parking_a = None
            parking_b = None
            has_data_a = False
            has_data_b = False

            with _store_lock:
                a = _store.get(self.parkid_a)
                b = _store.get(self.parkid_b)

            if a:
                has_data_a = True
                parking_a = {
                    "total": a["total"],
                    "available": a["available"],
                    "lastReport": time.strftime(
                        "%Y-%m-%dT%H:%M:%S",
                        time.localtime(a["updated_at"])
                    ),
                }
            if b:
                has_data_b = True
                parking_b = {
                    "total": b["total"],
                    "available": b["available"],
                    "lastReport": time.strftime(
                        "%Y-%m-%dT%H:%M:%S",
                        time.localtime(b["updated_at"])
                    ),
                }

            # 判断健康状态
            now = time.time()
            status = "ok"
            warnings = []

            # 检查当天诊断日志中 error 数量
            today_events, _ = read_diagnostics(time.strftime("%Y-%m-%d"), limit=1)
            summary = summary_diagnostics(time.strftime("%Y-%m-%d"))
            errors_today = summary.get("byLevel", {}).get("error", 0)
            failovers_today = summary.get("failoverCount", 0)

            if errors_today > 20:
                status = "degraded"
                warnings.append(f"今日错误数较多: {errors_today}")
            if failovers_today > 10:
                status = "degraded"
                warnings.append(f"今日故障切换次数较多: {failovers_today}")

            # 检查停车数据是否有最近 10 分钟内的上报
            stale_threshold = now - 600  # 10 分钟
            if has_data_a and a.get("updated_at", 0) < stale_threshold:
                warnings.append("停车场 A 数据超过 10 分钟未更新")
                status = "degraded"
            if has_data_b and b.get("updated_at", 0) < stale_threshold:
                warnings.append("停车楼 B 数据超过 10 分钟未更新")
                status = "degraded"
            if not has_data_a and not has_data_b:
                status = "error"
                warnings.append("两个车场均无数据上报")

            health = {
                "status": status,
                "uptime": int(now - _SERVER_START_TIME),
                "serverTime": time.strftime("%Y-%m-%d %H:%M:%S"),
                "parking": {"a": parking_a, "b": parking_b},
                "diagnosticsToday": summary["total"],
                "errorsToday": errors_today,
                "failoversToday": failovers_today,
                "warnings": warnings,
            }

            self._json_ok(health)
        except Exception as e:
            print(f"[ERROR] GET /api/health: {e}", file=sys.stderr)
            self._json_error(500, str(e))

    def _serve_video_file(self, path: str):
        """Serve video files from the configured video_dir."""
        # Strip /videos/ prefix and join with video_dir
        relative = path[len("/videos/"):]
        # Security: prevent directory traversal
        safe = os.path.normpath(relative)
        if safe.startswith("..") or os.path.isabs(safe):
            self.send_error(403, "Forbidden")
            return

        base = self.video_dir or r"D:\videos"
        filepath = os.path.join(base, safe)
        if not os.path.isfile(filepath):
            self.send_error(404, "File not found")
            return

        try:
            with open(filepath, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", guess_mime(filepath))
            self.send_header("Content-Length", len(content))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            self.wfile.write(content)
        except OSError:
            self.send_error(500, "Read error")

    # ---- Static file helpers ----------------------------------------------

    def _serve_file(self, filename: str):
        """Serve a named file from the server root."""
        filepath = os.path.join(self.directory, filename)
        try:
            with open(filepath, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", guess_mime(filename))
            self.send_header("Content-Length", len(content))
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
            self.wfile.write(content)
        except FileNotFoundError:
            self.send_error(404, "File not found")

    def _serve_static(self, path: str):
        """Serve any static file, normalising leading slash."""
        # Security: prevent directory traversal
        safe = os.path.normpath(path.lstrip("/"))
        if safe.startswith("..") or os.path.isabs(safe):
            self.send_error(403, "Forbidden")
            return
        filepath = os.path.join(self.directory, safe)
        if not os.path.isfile(filepath):
            self.send_error(404, "File not found")
            return
        try:
            with open(filepath, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", guess_mime(filepath))
            self.send_header("Content-Length", len(content))
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
            self.wfile.write(content)
        except OSError:
            self.send_error(500, "Read error")

    # ---- JSON response helpers --------------------------------------------

    def _json_ok(self, data: dict):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", len(body))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _json_error(self, code: int, message: str):
        body = json.dumps({"error": message}, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", len(body))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    # ---- CORS preflight ---------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


# ---------------------------------------------------------------------------
# Server factory (binds parkid config to handler)
# ---------------------------------------------------------------------------
def make_server(port: int, parkid_a: str, parkid_b: str, video_dir: str) -> HTTPServer:
    """Create an HTTPServer with our custom handler and injected config."""
    # Bind config as class attributes
    ParkingServer.parkid_a = parkid_a
    ParkingServer.parkid_b = parkid_b
    ParkingServer.video_dir = video_dir

    server = HTTPServer(("0.0.0.0", port), ParkingServer)
    return server


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Parking Display Server — receives POST from parking lot clients"
    )
    parser.add_argument("--port", type=int, default=8080, help="Listen port (default: 8080)")
    parser.add_argument(
        "--parkid-a", type=str, default="20210001",
        help="ParkID mapped to slot A / 停车场 (default: 20210001)"
    )
    parser.add_argument(
        "--parkid-b", type=str, default="20210002",
        help="ParkID mapped to slot B / 停车楼 (default: 20210002)"
    )
    parser.add_argument(
        "--video-dir", type=str, default=r"D:\videos",
        help="Directory for ad videos, used by /api/video-list (default: D:\\videos)"
    )
    args = parser.parse_args()

    server = make_server(args.port, args.parkid_a, args.parkid_b, args.video_dir)

    # 启动后台日志清理线程（守护线程，每小时运行一次）
    cleanup_thread = threading.Thread(target=_cleanup_loop, daemon=True)
    cleanup_thread.start()
    # 首次启动时立即清理一次
    try:
        cleanup_old_logs()
    except Exception as e:
        print(f"[CLEANUP] 首次清理失败: {e}", file=sys.stderr)

    print(f"=" * 60)
    print(f"  Parking Display Server")
    print(f"  Listening on:  http://0.0.0.0:{args.port}")
    print(f"  ParkID A (停车场): {args.parkid_a}")
    print(f"  ParkID B (停车楼): {args.parkid_b}")
    print(f"  Video dir:      {args.video_dir}")
    print(f"  POST endpoint:  http://0.0.0.0:{args.port}/parking")
    print(f"  GET  endpoint:  http://0.0.0.0:{args.port}/api/parking/status")
    print(f"  Video list API: http://0.0.0.0:{args.port}/api/video-list?folder=")
    print(f"  Display page:   http://localhost:{args.port}")
    print(f"  Admin page:     http://localhost:{args.port}/admin.html")
    print(f"=" * 60)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
