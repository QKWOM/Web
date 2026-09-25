#!/usr/bin/env python3
"""本地运行网页，并代为查询 dblp 和 OpenReview（绕过浏览器的跨域限制）。

用法：
    python3 server.py            # 默认端口 8000
    python3 server.py 8080       # 指定端口
    python3 server.py --logout   # 删除保存的 OpenReview 登录令牌

OpenReview 要求登录后才能查询。首次启动时会提示输入 OpenReview 账号，
只在本机保存一个一周有效的令牌（.openreview_token），不保存密码。
也可以用环境变量 OPENREVIEW_USERNAME、OPENREVIEW_PASSWORD 提供账号。

只用到 Python 标准库，不需要安装任何依赖。
"""

import getpass
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
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
# dblp 官方 SPARQL 服务，以及弗莱堡大学 QLever 上的 dblp 数据（备用）
UPSTREAMS = ['https://sparql.dblp.org/sparql', 'https://qlever.cs.uni-freiburg.de/api/dblp']
# OpenReview API，用来补充 dblp 尚未收录的年份
OPENREVIEW = 'https://api2.openreview.net'
TOKEN_FILE = os.path.join(ROOT, '.openreview_token')
TOKEN_LIFETIME = 7 * 24 * 3600  # OpenReview 允许的最长有效期：一周
TIMEOUT = 60
USER_AGENT = 'conference-paper-finder (local)'


class UpstreamError(Exception):
    def __init__(self, message, network_only=True):
        super().__init__(message)
        self.network_only = network_only


def fetch_with_curl(url, accept, headers=None, data=None):
    """部分 macOS 上的 Python 缺少根证书，这时改用系统自带的 curl。返回 (状态码, 内容) 或 None。"""
    if not shutil.which('curl'):
        return None
    args = ['curl', '-sS', '--max-time', str(TIMEOUT), '-A', USER_AGENT, '-w', '\n%{http_code}']
    if data is None:
        # 请求头（可能含登录令牌）通过标准输入传给 curl，避免出现在进程列表里
        config = ''.join(f'header = "{k}: {v}"\n' for k, v in {'Accept': accept, **(headers or {})}.items())
        result = subprocess.run(args + ['-K', '-', url], input=config.encode(), capture_output=True)
    else:
        # 登录请求：密码放在标准输入里
        args += ['-H', f'Accept: {accept}', '-H', 'Content-Type: application/json', '--data-binary', '@-']
        result = subprocess.run(args + [url], input=data, capture_output=True)
    if result.returncode != 0:
        return None
    body, _, code = result.stdout.rpartition(b'\n')
    return int(code or 0), body


def http_request(url, accept='application/sparql-results+json', headers=None, data=None):
    """GET（或提供 data 时 POST JSON），返回 (状态码, 内容, Content-Type)；连不上时抛出 UpstreamError。"""
    all_headers = {'User-Agent': USER_AGENT, 'Accept': accept, **(headers or {})}
    if data is not None:
        all_headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(url, data=data, headers=all_headers)
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
            result = fetch_with_curl(url, accept, headers, data)
            if result is not None:
                return result[0], result[1], ''
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
            status, body, content_type = http_request(f'{base}?{query_string}')
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


# ---------------- OpenReview 登录 ----------------

_auth = {'token': None, 'username': None, 'password': None}
_auth_lock = threading.Lock()

CHALLENGE_HINT = ('OpenReview 现在要求登录后才能列出整个会场的论文（按标题搜索单篇论文不受影响）。'
                  '要在这里列出论文，请在终端按 Ctrl + C 停止 server.py，重新运行 python3 server.py，按提示登录 OpenReview 账号。')


def openreview_login(username, password):
    """登录 OpenReview，返回令牌。"""
    payload = json.dumps({'id': username, 'password': password, 'expiresIn': TOKEN_LIFETIME}).encode('utf-8')
    status, body, _ = http_request(f'{OPENREVIEW}/login', 'application/json', data=payload)
    try:
        data = parse_json(body)
    except ValueError:
        data = {}
    data = data if isinstance(data, dict) else {}
    if status != 200:
        raise UpstreamError(f'OpenReview 登录失败：{data.get("message") or f"HTTP {status}"}', network_only=False)
    if data.get('mfaPending'):
        raise UpstreamError('这个 OpenReview 账号开启了两步验证，server.py 暂不支持。', network_only=False)
    if not data.get('token'):
        raise UpstreamError('OpenReview 登录失败：返回里没有令牌', network_only=False)
    return data['token']


def load_saved_token():
    try:
        with open(TOKEN_FILE, encoding='utf-8') as f:
            data = json.load(f)
        if data.get('expires', 0) > time.time() + 3600:
            return data.get('token')
    except (OSError, ValueError, AttributeError):
        pass
    return None


def save_token(token):
    try:
        fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump({'token': token, 'expires': int(time.time()) + TOKEN_LIFETIME}, f)
        os.chmod(TOKEN_FILE, 0o600)
    except OSError:
        pass


def forget_token(token):
    with _auth_lock:
        if _auth['token'] == token:
            _auth['token'] = None
            try:
                os.remove(TOKEN_FILE)
            except OSError:
                pass


def relogin(old_token):
    """令牌过期时，用环境变量里的账号重新登录。成功返回 True。"""
    with _auth_lock:
        if _auth['token'] != old_token:
            return True  # 别的请求已经刷新过了
        if not (_auth['username'] and _auth['password']):
            return False
        try:
            _auth['token'] = openreview_login(_auth['username'], _auth['password'])
        except UpstreamError:
            return False
        return True


def setup_openreview(interactive=True):
    """启动时准备 OpenReview 令牌：环境变量 → 保存的令牌 → 在终端询问。"""
    user = os.environ.get('OPENREVIEW_USERNAME', '').strip()
    password = os.environ.get('OPENREVIEW_PASSWORD', '')
    if user and password:
        _auth.update(username=user, password=password)  # 保留账号，令牌过期或启动时登录失败都能再登录
        try:
            _auth['token'] = openreview_login(user, password)
            print('✓ 已用环境变量中的账号登录 OpenReview')
        except UpstreamError as e:
            print(f'✗ {e}')
        return
    token = load_saved_token()
    if token:
        _auth['token'] = token
        return
    if not (interactive and sys.stdin.isatty()):
        return
    print('OpenReview 现在要求登录后才能查询，用来补充 dblp 尚未收录的最新年份（例如 CoRL 2025）。')
    print('登录后只在本机保存一个一周有效的令牌，不保存密码。')
    while True:
        try:
            user = input('OpenReview 登录邮箱（直接回车跳过）：').strip()
        except EOFError:
            return
        if not user:
            print('已跳过 OpenReview 登录，dblp 的数据不受影响。')
            return
        password = getpass.getpass('密码（输入时不显示）：')
        try:
            token = openreview_login(user, password)
        except UpstreamError as e:
            print(f'✗ {e}')
            continue
        _auth['token'] = token
        save_token(token)
        print('✓ 已登录 OpenReview')
        return


# ---------------- OpenReview 查询 ----------------

# 网页只需要这两种查询；参数限定死，返回的字段也只保留需要的，避免借登录身份读到其他数据
OPENREVIEW_QUERIES = {
    'notes': {'content.venueid', 'limit', 'offset'},
    'groups': {'id'},
}
NOTE_FIELDS = ('title', 'authors', 'pdf', 'venue', 'venueid')


def error_json(message):
    return json.dumps({'error': message}, ensure_ascii=False).encode('utf-8')


def slim(path, data):
    if path == 'notes':
        notes = [{
            'id': n.get('id'),
            'forum': n.get('forum'),
            'content': {k: v for k, v in (n.get('content') or {}).items() if k in NOTE_FIELDS},
        } for n in data.get('notes') or [] if isinstance(n, dict)]
        return {'notes': notes, 'count': data.get('count')}
    return {'groups': [{'id': g.get('id'), 'members': g.get('members') or []}
                       for g in data.get('groups') or [] if isinstance(g, dict)]}


def fetch_openreview(path, query_string):
    """请求 OpenReview API，返回 (状态码, 发给浏览器的 JSON 内容)。"""
    params = urllib.parse.parse_qs(query_string, keep_blank_values=True)
    if path not in OPENREVIEW_QUERIES or not set(params) <= OPENREVIEW_QUERIES[path] \
            or (path == 'groups' and params.get('id') != ['venues']):
        return 400, error_json('不支持的 OpenReview 查询')
    url = f'{OPENREVIEW}/{path}?{urllib.parse.urlencode(params, doseq=True)}'
    if not _auth['token'] and _auth['username']:
        relogin(None)  # 配置了账号但还没有令牌（例如启动时网络不通），先补登录

    for attempt in range(2):
        token = _auth['token']
        headers = {'Authorization': f'Bearer {token}'} if token else {}
        try:
            status, body, content_type = http_request(url, 'application/json', headers)
        except UpstreamError as e:
            raise UpstreamError(f'{OPENREVIEW}: {e}') from None
        if status == 401 and token and attempt == 0 and relogin(token):
            continue  # 令牌过期，重新登录后再试一次
        break

    if status == 401 and token:
        forget_token(token)
        return 401, error_json('OpenReview 登录已过期。请在终端按 Ctrl + C 停止 server.py，重新运行并登录。')
    if status == 403 and b'Challenge' in body:
        hint = CHALLENGE_HINT if not token else f'OpenReview 要求人机验证，登录后仍被拦截：{preview(body)}'
        return 403, error_json(hint)
    if status != 200:
        return status, body
    try:
        data = parse_json(body)
    except ValueError:
        data = None
    if not isinstance(data, dict) or not ('notes' in data or 'groups' in data):
        raise UpstreamError(f'{OPENREVIEW}: 返回的不是 API 数据（Content-Type: {content_type or "未知"}，'
                            f'开头内容：{preview(body)}）', network_only=False)
    return 200, json.dumps(slim(path, data), ensure_ascii=False).encode('utf-8')


def upstream_error_message(e, name='dblp 查询服务'):
    if e.network_only:
        return f'本地服务器也无法连接 {name}，请检查网络（例如是否需要开代理）。详情：{e}'
    return f'{name} 返回的数据无法使用。详情：{e}'


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        # 只接受本机地址访问，防止恶意网站通过 DNS 重绑定借用中转服务（以及 OpenReview 登录身份）
        port = self.server.server_address[1]
        if self.headers.get('Host', '') not in (f'127.0.0.1:{port}', f'localhost:{port}'):
            self.send_json(403, {'error': 'forbidden host'})
            return
        route, _, rest = self.path.lstrip('/').partition('/')
        if route in ('dblp-proxy', 'openreview-proxy'):
            self.proxy(route, *rest.partition('?')[::2])
        else:
            super().do_GET()

    def proxy(self, route, path, query_string):
        try:
            if route == 'dblp-proxy' and path == 'sparql':
                status, body, _ = fetch_upstream(query_string)
            elif route == 'openreview-proxy' and path in OPENREVIEW_QUERIES:
                status, body = fetch_openreview(path, query_string)
            else:
                self.send_json(404, {'error': 'not found'})
                return
        except UpstreamError as e:
            name = 'dblp 查询服务' if route == 'dblp-proxy' else 'OpenReview'
            message = upstream_error_message(e, name)
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
    """启动时试着查询一次 dblp 和 OpenReview，把结果打印出来，方便排查网络问题。"""
    query = urllib.parse.urlencode({'query': (
        'SELECT ?title WHERE { <https://dblp.org/streams/conf/cvpr> '
        '<https://dblp.org/rdf/schema#streamTitle> ?title } LIMIT 1'
    )})
    try:
        status, body, base = fetch_upstream(query)
        if status == 200:
            print(f'✓ dblp 查询服务连接正常（{base}）')
        else:
            print(f'✗ dblp 查询服务返回 HTTP {status}：{preview(body)}')
    except UpstreamError as e:
        print(f'✗ {upstream_error_message(e)}')

    query = urllib.parse.urlencode({'content.venueid': 'ICLR.cc/2025/Conference', 'limit': 1})
    try:
        status, body = fetch_openreview('notes', query)
        if status == 200:
            login = '，已登录' if _auth['token'] else ''
            print(f'✓ OpenReview 连接正常（用于补充 dblp 尚未收录的年份{login}）')
        else:
            try:
                detail = json.loads(body).get('error') or preview(body)
            except (ValueError, AttributeError):
                detail = preview(body)
            print(f'✗ OpenReview：{detail}')
    except UpstreamError as e:
        print(f'✗ {upstream_error_message(e, "OpenReview")}（dblp 尚未收录的年份将无法补充）')


def main():
    args = sys.argv[1:]
    if '--logout' in args:
        try:
            os.remove(TOKEN_FILE)
            print('已删除保存的 OpenReview 登录令牌。')
        except OSError:
            print('没有保存的 OpenReview 登录令牌。')
        return
    preferred = int(args[0]) if args else 8000
    try:
        setup_openreview()
    except KeyboardInterrupt:
        print('\n已取消。')
        return
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
