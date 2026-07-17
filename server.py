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
import json
import os
import sys
import threading
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import parse_qs, urlparse


# ---------------------------------------------------------------------------
# In-memory store: latest parking data keyed by parkid
# ---------------------------------------------------------------------------
_store_lock = threading.Lock()
_store = {}  # type: ignore[var-annotated]


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
        """Override to include timestamp."""
        timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
        sys.stderr.write(f"[{timestamp}] {args[0]}\n")

    # ---- Routing ----------------------------------------------------------

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/parking/status":
            self._handle_status()
        elif path == "/api/video-list":
            self._handle_video_list()
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
