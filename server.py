#!/usr/bin/env python3
"""Minimal production server for the static icon preflight app."""

from __future__ import annotations

import os
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


APP_DIR = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "8080"))


class AppHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/healthcheck":
            payload = b'{"status":"ok"}\n'
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)
            return
        super().do_GET()

    def end_headers(self):
        path = self.path.split("?", 1)[0]
        if path == "/healthcheck":
            pass
        elif path in {"/", "/index.html", "/service-worker.js", "/manifest.webmanifest"}:
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "public, max-age=3600")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), AppHandler)
    print(f"Serving 百宝箱图标预审 on 0.0.0.0:{PORT}", flush=True)
    server.serve_forever()
