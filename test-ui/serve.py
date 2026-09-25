#!/usr/bin/env python3
"""Serve test-ui on http://127.0.0.1:5500 with caching turned off.

python3 -m http.server lets Chrome keep an old copy of index.html, so after
index.html is updated the browser can keep running the previous version.
This server tells the browser never to cache, so a normal reload (F5)
always picks up the newest file.

Run from anywhere:  python3 serve.py
"""
import functools
import http.server
import os

PORT = 5500
HERE = os.path.dirname(os.path.abspath(__file__))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    handler = functools.partial(NoCacheHandler, directory=HERE)
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler) as httpd:
        print(f"test-ui: http://127.0.0.1:{PORT}/index.html  (no-cache; Ctrl+C to stop)")
        httpd.serve_forever()
