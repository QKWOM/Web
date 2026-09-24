#!/usr/bin/env python3
"""本地运行网页，并代为请求 dblp（绕过浏览器的跨域限制）。

用法：
    python3 server.py          # 默认端口 8000
    python3 server.py 8080     # 指定端口

只用到 Python 标准库，不需要安装任何依赖。
"""

import http.server
import json
import os
import shutil
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
PREFIX = '/dblp-proxy/'
ALLOWED_PATHS = {'search/venue/api', 'search/publ/api'}
UPSTREAMS = ['https://dblp.org', 'https://dblp.uni-trier.de']
TIMEOUT = 20
USER_AGENT = 'conference-paper-finder (local)'


class UpstreamError(Exception):
    pass


def fetch_with_curl(url):
    """部分 macOS 上的 Python 缺少根证书，这时改用系统自带的 curl。"""
    if not shutil.which('curl'):
        return None
    result = subprocess.run(
        ['curl', '-sS', '--fail', '--max-time', str(TIMEOUT), '-A', USER_AGENT, url],
        capture_output=True,
    )
    return result.stdout if result.returncode == 0 else None


def fetch_upstream(path_and_query):
    errors = []
    for base in UPSTREAMS:
        url = f'{base}/{path_and_query}'
        request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as e:
            if e.code >= 500 and base != UPSTREAMS[-1]:
                errors.append(f'{base}: HTTP {e.code}')
                continue  # 服务器出错时换镜像试试
            return e.code, e.read()
        except Exception as e:  # 网络错误、超时、证书问题等
            reason = getattr(e, 'reason', e)
            if isinstance(reason, ssl.SSLError):
                body = fetch_with_curl(url)
                if body is not None:
                    return 200, body
            errors.append(f'{base}: {reason}')
    raise UpstreamError('；'.join(errors))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        if self.path.startswith(PREFIX):
            self.proxy()
        else:
            super().do_GET()

    def proxy(self):
        path_and_query = self.path[len(PREFIX):]
        if path_and_query.split('?', 1)[0] not in ALLOWED_PATHS:
            self.send_json(404, {'error': 'not found'})
            return
        try:
            status, body = fetch_upstream(path_and_query)
        except UpstreamError as e:
            message = f'本地服务器也无法连接 dblp，请检查网络（例如是否需要开代理）。详情：{e}'
            self.log_message('%s', message)
            self.send_json(502, {'error': message})
            return
        self.send_body(status, body, 'application/json; charset=utf-8')

    def send_json(self, status, data):
        self.send_body(status, json.dumps(data, ensure_ascii=False).encode('utf-8'),
                       'application/json; charset=utf-8')

    def send_body(self, status, body, content_type):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    try:
        # 只监听本机，避免中转服务暴露到局域网
        server = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
    except OSError:
        print(f'端口 {port} 已被占用（之前启动的服务可能还在运行）。')
        print(f'请先关掉它，或者换个端口：python3 server.py {port + 1}')
        sys.exit(1)
    url = f'http://localhost:{port}/'
    print(f'会议论文速查已启动：{url}')
    print('按 Ctrl + C 停止。')
    try:
        webbrowser.open(url)
    except Exception:
        pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止。')


if __name__ == '__main__':
    main()
