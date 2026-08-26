#!/usr/bin/env python3
"""swing 生词本 - PC 本地同步助手

作用：
1. 在本机启动一个小型 HTTP 服务（默认 http://127.0.0.1:8765），
   托管 生词本-单文件版.html，让浏览器通过 localhost 访问；
2. 提供 /dav-proxy 代理端点：坚果云 WebDAV 不允许网页跨域直连（无 CORS 头），
   浏览器页面把 WebDAV 请求发给本助手，由助手代为转发到坚果云。

用法：双击 start_sync.bat，或 python tools/sync_server.py [端口]
"""
import base64
import json
import os
import sys
import urllib.request
import urllib.error
from http.server import HTTPServer, SimpleHTTPRequestHandler

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(BASE)


class Handler(SimpleHTTPRequestHandler):

    def _json(self, code, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path.rstrip("/") != "/dav-proxy":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as e:
            self._json(400, {"ok": False, "error": "bad request: %s" % e})
            return

        url = str(req.get("url") or "")
        if not url.startswith("https://dav.") and ".jianguoyun.com" not in url \
                and "dav." not in url[:12]:
            # 仅允许代理到 WebDAV 地址，防止被滥用为开放代理
            self._json(403, {"ok": False, "error": "only WebDAV urls allowed"})
            return

        headers = {"User-Agent": "swing-vocab-sync/1.0"}
        if req.get("user") is not None:
            token = base64.b64encode(
                ("%s:%s" % (req.get("user"), req.get("pass"))).encode("utf-8"))
            headers["Authorization"] = "Basic " + token.decode("ascii")
        for k, v in (req.get("headers") or {}).items():
            headers[k] = v

        body = None
        if req.get("body64"):
            body = base64.b64decode(req["body64"])

        r = urllib.request.Request(url, data=body, method=req.get("method", "GET"))
        for k, v in headers.items():
            r.add_header(k, v)

        try:
            with urllib.request.urlopen(r, timeout=30) as resp:
                resp_body = resp.read()
                self._json(200, {"ok": True, "status": resp.status,
                                 "body64": base64.b64encode(resp_body).decode("ascii")})
        except urllib.error.HTTPError as e:
            resp_body = e.read() if hasattr(e, "read") else b""
            self._json(200, {"ok": True, "status": e.code,
                             "body64": base64.b64encode(resp_body).decode("ascii")})
        except Exception as e:
            self._json(200, {"ok": False, "status": 0,
                             "error": "%s: %s" % (type(e).__name__, e)})

    def log_message(self, fmt, *args):
        sys.stderr.write("[sync-helper] %s\n" % (fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = HTTPServer(("127.0.0.1", port), Handler)
    print("=" * 52)
    print(" swing 生词本 同步助手已启动")
    print(" 请在浏览器打开:  http://127.0.0.1:%d/" % port)
    print(" 关闭本窗口即停止服务。保持窗口开着即可同步。")
    print("=" * 52)
    try:
        import webbrowser
        webbrowser.open("http://127.0.0.1:%d/%E7%94%9F%E8%AF%8D%E6%9C%AC-%E5%8D%95%E6%96%87%E4%BB%B6%E7%89%88.html" % port)
    except Exception:
        pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
