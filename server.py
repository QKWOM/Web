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
import socket
import ssl
import subprocess
import sys
import threading
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


def port_in_use(port):
    """检查本机 IPv4 和 IPv6 地址上是否已有程序在监听这个端口。

    macOS 上 python3 -m http.server 会监听 IPv6，这时本服务仍能在 IPv4 上启动成功，
    但浏览器访问 localhost 时可能连到旧服务，所以两个都要检查。
    """
    for family, host in ((socket.AF_INET, '127.0.0.1'), (socket.AF_INET6, '::1')):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as s:
                s.settimeout(0.3)
                if s.connect_ex((host, port)) == 0:
                    return True
        except OSError:
            pass
    return False


def start_server(preferred_port):
    for port in range(preferred_port, preferred_port + 20):
        if port_in_use(port):
            continue
        try:
            # 只监听本机，避免中转服务暴露到局域网
            return http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler), port
        except OSError:
            continue
    print(f'端口 {preferred_port}-{preferred_port + 19} 都被占用了，请换个端口：python3 server.py 9000')
    sys.exit(1)


def check_dblp():
    """启动时试着连一次 dblp，把结果打印出来，方便排查网络问题。"""
    try:
        status, _ = fetch_upstream('search/venue/api?q=CVPR&format=json&h=1')
    except UpstreamError as e:
        print(f'✗ 无法连接 dblp：{e}')
        print('  请检查网络；如果需要代理才能访问 dblp，请先设置 HTTPS_PROXY 再启动。')
        return
    if status == 200:
        print('✓ dblp 连接正常')
    else:
        print(f'✗ dblp 返回 HTTP {status}')


def main():
    preferred = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server, port = start_server(preferred)
    if port != preferred:
        print(f'端口 {preferred} 已被其他程序占用（可能是之前的 python3 -m http.server），改用 {port}。')
    # 用 127.0.0.1 而不是 localhost，避免浏览器连到监听 IPv6 的其他程序
    url = f'http://127.0.0.1:{port}/'
    print(f'会议论文速查已启动，请打开：{url}')
    print('按 Ctrl + C 停止。')
    threading.Thread(target=check_dblp, daemon=True).start()
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
