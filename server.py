#!/usr/bin/env python3
"""本地运行网页，并代为查询 dblp 的 SPARQL 服务（绕过浏览器的跨域限制）。

用法：
    python3 server.py          # 默认端口 8000
    python3 server.py 8080     # 指定端口

只用到 Python 标准库，不需要安装任何依赖。
"""

import gzip
import http.server
import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
PREFIX = '/dblp-proxy/'
ALLOWED_PATHS = {'sparql'}
# dblp 官方 SPARQL 服务，以及弗莱堡大学 QLever 上的 dblp 数据（备用）
UPSTREAMS = ['https://sparql.dblp.org/sparql', 'https://qlever.cs.uni-freiburg.de/api/dblp']
TIMEOUT = 60
USER_AGENT = 'conference-paper-finder (local)'


class UpstreamError(Exception):
    def __init__(self, message, network_only=True):
        super().__init__(message)
        self.network_only = network_only


def fetch_with_curl(url):
    """部分 macOS 上的 Python 缺少根证书，这时改用系统自带的 curl。"""
    if not shutil.which('curl'):
        return None
    result = subprocess.run(
        ['curl', '-sS', '--fail', '--max-time', str(TIMEOUT), '-A', USER_AGENT,
         '-H', 'Accept: application/sparql-results+json', url],
        capture_output=True,
    )
    return result.stdout if result.returncode == 0 else None


def http_get(url):
    """返回 (状态码, 内容, Content-Type)；连不上时抛出 UpstreamError。"""
    request = urllib.request.Request(url, headers={
        'User-Agent': USER_AGENT,
        'Accept': 'application/sparql-results+json',
    })
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            body = response.read()
            if response.headers.get('Content-Encoding', '').lower() == 'gzip':
                body = gzip.decompress(body)
            return response.status, body, response.headers.get('Content-Type', '')
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get('Content-Type', '')
    except Exception as e:  # 网络错误、超时、证书问题等
        reason = getattr(e, 'reason', e)
        if isinstance(reason, ssl.SSLError):
            body = fetch_with_curl(url)
            if body is not None:
                return 200, body, ''
        raise UpstreamError(str(reason))


def parse_json(body):
    """宽松地解析 JSON：允许字符串里有控制字符，并修复无效的反斜杠转义。"""
    text = body.decode('utf-8-sig', errors='replace')
    try:
        return json.loads(text, strict=False)
    except ValueError:
        pass
    repaired = re.sub(r'\\(.)', lambda m: m.group(0) if m.group(1) in '"\\/bfnrtu' else '\\\\' + m.group(1),
                      text, flags=re.S)
    return json.loads(repaired, strict=False)


def preview(body, limit=200):
    text = ' '.join(body[:limit * 2].decode('utf-8', errors='replace').split())
    return text[:limit] or '（空）'


def fetch_upstream(query_string):
    """查询 SPARQL 服务，返回 (状态码, 发给浏览器的 JSON 内容, 实际使用的服务地址)。"""
    errors = []
    network_only = True
    for base in UPSTREAMS:
        try:
            status, body, content_type = http_get(f'{base}?{query_string}')
        except UpstreamError as e:
            errors.append(f'{base}: {e}')
            continue
        if status >= 500 and base != UPSTREAMS[-1]:
            network_only = False
            errors.append(f'{base}: HTTP {status}')
            continue  # 服务器出错时换备用服务试试
        if status != 200:
            return status, body, base  # 例如查询语句有误（400），原样交给网页显示
        try:
            data = parse_json(body)
        except ValueError:
            data = None
        if not isinstance(data, dict) or 'results' not in data:
            network_only = False
            errors.append(f'{base}: 返回的不是查询结果（Content-Type: {content_type or "未知"}，开头内容：{preview(body)}）')
            continue
        # 重新序列化，保证浏览器一定能解析
        return 200, json.dumps(data, ensure_ascii=False).encode('utf-8'), base
    raise UpstreamError('；'.join(errors), network_only)


def upstream_error_message(e):
    if e.network_only:
        return f'本地服务器也无法连接 dblp 查询服务，请检查网络（例如是否需要开代理）。详情：{e}'
    return f'dblp 查询服务返回的数据无法使用。详情：{e}'


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        if self.path.startswith(PREFIX):
            self.proxy()
        else:
            super().do_GET()

    def proxy(self):
        path, _, query_string = self.path[len(PREFIX):].partition('?')
        if path not in ALLOWED_PATHS:
            self.send_json(404, {'error': 'not found'})
            return
        try:
            status, body, _ = fetch_upstream(query_string)
        except UpstreamError as e:
            message = upstream_error_message(e)
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
    """启动时试着查询一次 dblp，把结果打印出来，方便排查网络问题。"""
    query = urllib.parse.urlencode({'query': (
        'SELECT ?title WHERE { <https://dblp.org/streams/conf/cvpr> '
        '<https://dblp.org/rdf/schema#streamTitle> ?title } LIMIT 1'
    )})
    try:
        status, body, base = fetch_upstream(query)
    except UpstreamError as e:
        print(f'✗ {upstream_error_message(e)}')
        return
    if status == 200:
        print(f'✓ dblp 查询服务连接正常（{base}）')
    else:
        print(f'✗ dblp 查询服务返回 HTTP {status}：{preview(body)}')


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
