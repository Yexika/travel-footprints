#!/usr/bin/env bash
# 旅行足迹地图 · 登录编辑服务（v3.0）
#
# 作用：让别人在网页上点「登录编辑」，输入你给的账号密码后，就能和你一样修改地图。
#       GitHub Pages 和镜像站两个网址都用这个服务登录，改的是同一份 footprints.json。
#       账号密码由这台服务器验证；改动由服务器用它自己保存的 GitHub 令牌提交，令牌不会发给浏览器。
#
# 前提：已经用 setup-reality.sh（或 setup.sh）部署好镜像站。
# 用法（root，在 Xshell 里直接运行，中途会提示粘贴 GitHub 令牌、设置你自己的账号）：
#   bash setup-api.sh
# 之后管理账号：
#   travel-footprints-user add 名字      添加账号
#   travel-footprints-user passwd 名字   改密码
#   travel-footprints-user del 名字      删除账号
#   travel-footprints-user list          列出账号
# 重复运行是安全的：会更新程序，已有的账号和令牌都保留。
set -euo pipefail

APP_DIR=/opt/travel-footprints-api
CONF_DIR=/etc/travel-footprints-api
SVC=travel-footprints-api
SVC_USER=travelfp
PORT=8787
WEB=/var/www/travel-footprints
SITE_CONF=/etc/nginx/conf.d/travel-footprints.conf
INC_DIR=/etc/nginx/travel-footprints.d
STATE=/etc/travel-footprints-reality.env

say(){ printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn(){ printf '\n\033[1;33m[注意]\033[0m %s\n' "$*"; }
die(){ printf '\n\033[1;31m[停止]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行（先执行 sudo -i 再运行）。"
[ -d /run/systemd/system ] || die "需要 systemd。"
[ -f "$SITE_CONF" ] || die "还没有部署镜像站（没找到 $SITE_CONF）。请先运行 setup-reality.sh 或 setup.sh。"
command -v python3 >/dev/null 2>&1 || die "没找到 python3。"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)' || die "python3 版本太旧（需要 3.7 以上）。"

# ---------- 读取镜像站的设置 ----------
REPO="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["repo"])' "$WEB/mirror.json" 2>/dev/null || true)"
BRANCH="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("branch","main"))' "$WEB/mirror.json" 2>/dev/null || echo main)"
printf '%s' "$REPO" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || die "没从 $WEB/mirror.json 读到仓库名，请先重新运行 setup-reality.sh。"
DOMAIN="${1:-}"
if [ -z "$DOMAIN" ] && [ -f "$STATE" ]; then DOMAIN="$(sed -n 's/^DOMAIN=//p' "$STATE" | head -1)"; fi
if [ -z "$DOMAIN" ]; then DOMAIN="$(awk '/server_name/{print $2; exit}' "$SITE_CONF" | tr -d ';')"; fi
DOMAIN="$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z' | sed -E 's#^https?://##; s#/.*$##; s#^www\.##')"
printf '%s' "$DOMAIN" | grep -Eq '^[a-z0-9.-]+\.[a-z0-9-]+$' || die "没读到域名，请这样运行：bash setup-api.sh 你的域名"
OWNER="$(printf '%s' "${REPO%%/*}" | tr 'A-Z' 'a-z')"
ORIGINS="${TF_ORIGINS:-https://$DOMAIN,https://www.$DOMAIN,https://$OWNER.github.io}"
echo "仓库：$REPO（$BRANCH 分支）"
echo "允许登录的网站：$ORIGINS"

# ---------- 1. 程序和配置 ----------
say "安装登录服务"
id "$SVC_USER" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$APP_DIR"
cat >"$APP_DIR/server.py" <<'PYCODE'
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""旅行足迹地图 · 登录编辑服务（只用 Python 标准库）

网页上的「登录编辑」会调用这个服务：
  POST /api/login        账号密码登录，返回登录凭证（30 天有效）
  GET  /api/me           查看当前登录的账号
  GET  /api/footprints   读取最新足迹（直接从 GitHub 读）
  POST /api/footprints   提交改动：{"ops":[{"c":"marks"|"pins","k":编号,"v":内容或 null}]}
                         服务器在 GitHub 上最新的 footprints.json 上应用这些改动并提交，
                         所以几个人同时改不同的地方不会互相覆盖。
GitHub 令牌只保存在服务器上，不会发给浏览器。密码只保存加盐的 PBKDF2 哈希。

命令行（root）：
  travel-footprints-user add 名字      添加账号（会提示输入密码）
  travel-footprints-user passwd 名字   改密码（这个账号已登录的设备都需要重新登录）
  travel-footprints-user del 名字      删除账号
  travel-footprints-user list          列出账号
  travel-footprints-user logout 名字   让这个账号在所有设备上退出登录
  travel-footprints-user token         更换服务器上的 GitHub 令牌
  travel-footprints-user check         检查配置和 GitHub 令牌
"""
import base64
import collections
import getpass
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONF_DIR = os.environ.get('TFAPI_DIR', '/etc/travel-footprints-api')
ITERATIONS = 310000
SESSION_DAYS = 30
MAX_BODY = 4 * 1024 * 1024
MAX_OPS = 30000
MAX_MARKS = 20000
MAX_PINS = 5000
W2CN = {'TW': '710000', 'HK': '810000', 'MO': '820000'}
KEY_RE = re.compile(r'^([A-Z]{2,3}|\d{6}|s-\d{2}-[a-z0-9]{1,20})$')
PIN_RE = re.compile(r'^[A-Za-z0-9_-]{1,40}$')
USER_RE = re.compile(r'^[\w.\-]{1,32}$')


# ---------------------------------------------------------------- 文件
def cpath(name):
    return os.path.join(CONF_DIR, name)


def read_json(name, default):
    try:
        with open(cpath(name), encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def write_private(name, text):
    """原子写入，权限 600；root 运行时把文件交给配置目录的所有者（服务账号）。"""
    p = cpath(name)
    tmp = p + '.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(text)
    if os.geteuid() == 0:
        st = os.stat(CONF_DIR)
        os.chown(tmp, st.st_uid, st.st_gid)
    os.replace(tmp, p)


def write_json(name, obj):
    write_private(name, json.dumps(obj, ensure_ascii=False, indent=2) + '\n')


def b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def b64url_dec(s):
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


# ---------------------------------------------------------------- 配置与账号
class Store:
    def __init__(self):
        self._users = None
        self._users_mtime = None
        self.config = read_json('config.json', {})
        with open(cpath('secret'), encoding='utf-8') as f:
            self.secret = bytes.fromhex(f.read().strip())

    @property
    def repo(self):
        return self.config['repo']

    @property
    def branch(self):
        return self.config.get('branch', 'main')

    @property
    def api(self):
        return self.config.get('github_api', 'https://api.github.com').rstrip('/')

    @property
    def origins(self):
        return set(self.config.get('origins', []))

    def token(self):
        try:
            with open(cpath('github-token'), encoding='utf-8') as f:
                return f.read().strip()
        except FileNotFoundError:
            return ''

    def users(self):
        try:
            m = os.stat(cpath('users.json')).st_mtime_ns
        except FileNotFoundError:
            return {}
        if m != self._users_mtime:
            self._users = read_json('users.json', {}).get('users', {})
            self._users_mtime = m
        return self._users


def hash_password(pw, salt=None, iterations=ITERATIONS):
    salt = salt or secrets.token_bytes(16)
    h = hashlib.pbkdf2_hmac('sha256', pw.encode('utf-8'), salt, iterations)
    return salt.hex(), h.hex(), iterations


DUMMY = hash_password('travel-footprints-dummy')


def verify_password(rec, pw):
    salt, want, it = (rec['salt'], rec['hash'], rec['iter']) if rec else DUMMY
    _, got, _ = hash_password(pw, bytes.fromhex(salt), it)
    return bool(rec) and hmac.compare_digest(got, want)


def make_session(store, user, ver):
    exp = int(time.time()) + SESSION_DAYS * 86400
    payload = b64url(('%s\n%d\n%d' % (user, exp, ver)).encode('utf-8'))
    sig = b64url(hmac.new(store.secret, payload.encode(), hashlib.sha256).digest())
    return payload + '.' + sig, exp


def check_session(store, tok):
    try:
        payload, sig = tok.split('.', 1)
        want = b64url(hmac.new(store.secret, payload.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, want):
            return None
        user, exp, ver = b64url_dec(payload).decode('utf-8').split('\n')
        rec = store.users().get(user)
        if not rec or int(exp) < time.time() or int(ver) != rec.get('ver', 1):
            return None
        return user, int(exp)
    except Exception:
        return None


# ---------------------------------------------------------------- 防暴力破解
class Limiter:
    """同一个账号 15 分钟内输错 5 次就暂停；全站 5 分钟内错 30 次就全部暂停 1 分钟。"""
    def __init__(self):
        self.lock = threading.Lock()
        self.fails = {}
        self.all = collections.deque()

    def wait(self, user):
        now = time.time()
        with self.lock:
            while self.all and now - self.all[0] > 300:
                self.all.popleft()
            q = self.fails.get(user)
            while q and now - q[0] > 900:
                q.popleft()
            if q is not None and not q:
                self.fails.pop(user, None)
            if q and len(q) >= 5:
                return int(900 - (now - q[0])) + 1
            if len(self.all) >= 30:
                return int(60 - (now - self.all[-1])) + 1 if now - self.all[-1] < 60 else 0
            return 0

    def fail(self, user):
        now = time.time()
        with self.lock:
            if len(self.fails) > 2000:
                self.fails.clear()
            self.fails.setdefault(user, collections.deque()).append(now)
            self.all.append(now)

    def ok(self, user):
        with self.lock:
            self.fails.pop(user, None)


# ---------------------------------------------------------------- 数据校验（和网页里的规则一致）
def s_(v, n):
    return v[:n] if isinstance(v, str) else ''


def num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0
    if f != f or f in (float('inf'), float('-inf')):
        return 0
    return int(f) if f == int(f) else f


def clean_mark(o):
    if not isinstance(o, dict) or o.get('s') not in ('been', 'want'):
        return None
    return {'s': o['s'], 'date': s_(o.get('date'), 40), 'note': s_(o.get('note'), 300), 't': num(o.get('t'))}


def clean_pin(o):
    if not isinstance(o, dict) or o.get('s') not in ('been', 'want'):
        return None
    try:
        lon, lat = float(o.get('lon')), float(o.get('lat'))
    except (TypeError, ValueError):
        return None
    if lon != lon or lat != lat or abs(lat) > 90 or abs(lon) > 180:
        return None
    return {'s': o['s'], 'name': s_(o.get('name'), 60) or '未命名地点', 'lon': num(lon), 'lat': num(lat),
            'date': s_(o.get('date'), 40), 'note': s_(o.get('note'), 300), 't': num(o.get('t'))}


def norm_marks(o):
    n = {}
    if isinstance(o, dict):
        for k, v in o.items():
            k = W2CN.get(k, k)
            c = clean_mark(v)
            if c and isinstance(k, str) and KEY_RE.match(k):
                n[k] = c
    return n


def norm_pins(o):
    n = {}
    if isinstance(o, dict):
        for k, v in o.items():
            c = clean_pin(v)
            if c and isinstance(k, str) and PIN_RE.match(k):
                n[k] = c
    return n


class BadRequest(Exception):
    pass


def check_ops(ops):
    if not isinstance(ops, list) or not ops:
        raise BadRequest('没有要保存的改动')
    if len(ops) > MAX_OPS:
        raise BadRequest('一次改动太多了')
    out = []
    for op in ops:
        if not isinstance(op, dict):
            raise BadRequest('改动格式不对')
        c, k, v = op.get('c'), op.get('k'), op.get('v')
        if c == 'marks':
            k = W2CN.get(k, k)
            if not isinstance(k, str) or not KEY_RE.match(k):
                raise BadRequest('地点编号不对：%r' % (k,))
            if v is not None:
                v = clean_mark(v)
                if v is None:
                    raise BadRequest('标记内容不对')
        elif c == 'pins':
            if not isinstance(k, str) or not PIN_RE.match(k):
                raise BadRequest('地点编号不对：%r' % (k,))
            if v is not None:
                v = clean_pin(v)
                if v is None:
                    raise BadRequest('地点内容不对')
        else:
            raise BadRequest('改动格式不对')
        out.append((c, k, v))
    return out


def apply_ops(data, ops):
    marks, pins = norm_marks(data.get('marks')), norm_pins(data.get('pins'))
    for c, k, v in ops:
        d = marks if c == 'marks' else pins
        if v is None:
            d.pop(k, None)
        else:
            d[k] = v
    if len(marks) > MAX_MARKS or len(pins) > MAX_PINS:
        raise BadRequest('标记数量超过上限')
    return marks, pins


# ---------------------------------------------------------------- GitHub
class GHError(Exception):
    def __init__(self, status, msg=''):
        super().__init__(msg or str(status))
        self.status = status


class GitHub:
    def __init__(self, store):
        self.store = store
        self.lock = threading.Lock()

    def _req(self, method, url, body=None, token=None):
        token = token if token is not None else self.store.token()
        headers = {'Accept': 'application/vnd.github+json', 'User-Agent': 'travel-footprints-api',
                   'X-GitHub-Api-Version': '2022-11-28'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        data = None
        if body is not None:
            data = json.dumps(body).encode('utf-8')
            headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw) if raw else None
            except ValueError:
                return e.code, None
        except (urllib.error.URLError, OSError) as e:
            raise GHError(0, 'network: %s' % e)

    def _file_url(self):
        st = self.store
        return '%s/repos/%s/contents/footprints.json' % (st.api, st.repo)

    def check_repo(self, token=None):
        return self._req('GET', '%s/repos/%s' % (self.store.api, self.store.repo), token=token)

    def get(self):
        st = self.store
        code, j = self._req('GET', self._file_url() + '?ref=' + urllib.parse.quote(st.branch))
        if code == 404:
            return None, {}
        if code != 200 or not isinstance(j, dict):
            raise GHError(code)
        content = j.get('content') or ''
        if not content and j.get('sha'):  # 超过 1MB 的文件要从 blob 接口取
            code, b = self._req('GET', '%s/repos/%s/git/blobs/%s' % (st.api, st.repo, j['sha']))
            if code != 200:
                raise GHError(code)
            content = b.get('content') or ''
        try:
            data = json.loads(base64.b64decode(content).decode('utf-8') or '{}')
        except ValueError:
            data = {}
        return j.get('sha'), data if isinstance(data, dict) else {}

    def put(self, sha, marks, pins, message):
        doc = {'v': 2, 'updated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'marks': marks, 'pins': pins}
        body = {'message': message, 'branch': self.store.branch,
                'content': base64.b64encode(json.dumps(doc, ensure_ascii=False, indent=1).encode('utf-8')).decode()}
        if sha:
            body['sha'] = sha
        code, j = self._req('PUT', self._file_url(), body)
        if code in (200, 201):
            return (j.get('content') or {}).get('sha')
        if code in (409, 422):
            return None
        raise GHError(code)

    def edit(self, ops, user):
        """在最新的 footprints.json 上应用改动并提交；碰上别人同时提交就重新读取再试。"""
        with self.lock:
            for attempt in range(4):
                sha, data = self.get()
                old = (norm_marks(data.get('marks')), norm_pins(data.get('pins')))
                marks, pins = apply_ops(data, ops)
                if (marks, pins) == old and sha:
                    return sha, marks, pins
                new_sha = self.put(sha, marks, pins, '更新旅行足迹（%s）' % user)
                if new_sha:
                    return new_sha, marks, pins
                time.sleep(0.4 * (attempt + 1))
            raise GHError(409)


def gh_message(e):
    if e.status == 0:
        return 502, '服务器暂时连不上 GitHub，请稍后再试。'
    if e.status in (401, 403):
        return 502, '服务器上的 GitHub 令牌无效、过期或没有写入权限，请联系地图主人。'
    if e.status == 404:
        return 502, '服务器找不到 GitHub 仓库，或者令牌没有访问它的权限，请联系地图主人。'
    if e.status == 409:
        return 503, '这会儿改的人比较多，请稍后再试。'
    return 502, 'GitHub 返回了错误（%s），请稍后再试。' % e.status


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = 'travel-footprints-api'
    sys_version = ''
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (self.command or '-', fmt % args))

    @property
    def app(self):
        return self.server.app

    def _origin_ok(self):
        o = self.headers.get('Origin')
        return o is None or o in self.app.store.origins

    def _send(self, code, obj, extra=None):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        o = self.headers.get('Origin')
        if o and o in self.app.store.origins:
            self.send_header('Access-Control-Allow-Origin', o)
            self.send_header('Vary', 'Origin')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _err(self, code, msg, extra=None):
        self._send(code, {'error': msg}, extra)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > MAX_BODY:
            raise BadRequest('提交的内容太大了')
        raw = self.rfile.read(n) if n else b''
        try:
            return json.loads(raw.decode('utf-8') or '{}')
        except ValueError:
            raise BadRequest('提交的内容不是有效的 JSON')

    def _user(self):
        a = self.headers.get('Authorization') or ''
        return check_session(self.app.store, a[7:].strip()) if a.startswith('Bearer ') else None

    def do_OPTIONS(self):
        o = self.headers.get('Origin')
        if not o or o not in self.app.store.origins:
            self._err(403, '不允许从这个网站访问')
            return
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', o)
        self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Access-Control-Max-Age', '600')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        self._route('GET')

    def do_POST(self):
        self._route('POST')

    def _route(self, method):
        path = urllib.parse.urlsplit(self.path).path.rstrip('/')
        try:
            if not self._origin_ok():
                return self._err(403, '不允许从这个网站访问')
            if path == '/api/health' and method == 'GET':
                return self._send(200, {'ok': True})
            if path == '/api/login' and method == 'POST':
                return self._login()
            if path == '/api/me' and method == 'GET':
                u = self._user()
                return self._send(200, {'user': u[0], 'exp': u[1]}) if u else self._err(401, '请先登录')
            if path == '/api/footprints':
                u = self._user()
                if not u:
                    return self._err(401, '登录已过期，请重新登录')
                if method == 'GET':
                    sha, data = self.app.gh.get()
                    return self._send(200, {'sha': sha, 'marks': norm_marks(data.get('marks')), 'pins': norm_pins(data.get('pins'))})
                ops = check_ops(self._body().get('ops'))
                sha, marks, pins = self.app.gh.edit(ops, u[0])
                self.log_message('edit by %s: %d ops', u[0], len(ops))
                return self._send(200, {'sha': sha, 'marks': marks, 'pins': pins})
            return self._err(404, '没有这个接口')
        except BadRequest as e:
            return self._err(400, str(e))
        except GHError as e:
            self.log_message('github error %s', e)
            code, msg = gh_message(e)
            return self._err(code, msg)
        except Exception as e:  # 不把内部错误细节返回给浏览器
            self.log_message('internal error %r', e)
            return self._err(500, '服务器出错了，请稍后再试。')

    def _login(self):
        b = self._body()
        user, pw = b.get('user'), b.get('password')
        if not isinstance(user, str) or not isinstance(pw, str) or not user.strip() or not pw:
            raise BadRequest('请填写账号和密码')
        user = user.strip()[:64]
        lim = self.app.limiter
        wait = lim.wait(user)
        if wait:
            return self._err(429, '尝试次数太多，请 %d 分钟后再试。' % max(1, (wait + 59) // 60), {'Retry-After': str(wait)})
        rec = self.app.store.users().get(user)
        if not verify_password(rec, pw[:200]):
            lim.fail(user)
            time.sleep(0.4)
            self.log_message('login failed for %r', user)
            return self._err(401, '账号或密码不对')
        lim.ok(user)
        tok, exp = make_session(self.app.store, user, rec.get('ver', 1))
        self.log_message('login ok for %s', user)
        return self._send(200, {'token': tok, 'user': user, 'exp': exp})


class App:
    def __init__(self):
        self.store = Store()
        self.gh = GitHub(self.store)
        self.limiter = Limiter()


def serve():
    app = App()
    host, port = app.store.config.get('listen', '127.0.0.1:8787').rsplit(':', 1)
    srv = ThreadingHTTPServer((host, int(port)), Handler)
    srv.daemon_threads = True
    srv.app = app
    sys.stderr.write('travel-footprints-api listening on %s:%s for %s\n' % (host, port, app.store.repo))
    srv.serve_forever()


# ---------------------------------------------------------------- 命令行
def ask_password(stdin=False):
    if stdin:
        pw = sys.stdin.readline().rstrip('\n')
    else:
        pw = getpass.getpass('密码（至少 6 位，输入时不显示）：')
        if pw != getpass.getpass('再输一次：'):
            sys.exit('两次输入的密码不一样，没有保存。')
    if len(pw) < 6:
        sys.exit('密码至少要 6 位，没有保存。')
    return pw


def load_users():
    return read_json('users.json', {'users': {}}).get('users', {})


def save_users(users):
    write_json('users.json', {'users': users})


def admin(argv):
    if not argv or argv[0] in ('-h', '--help', 'help'):
        print(__doc__.split('命令行（root）：')[1].rstrip())
        return
    cmd, args = argv[0], argv[1:]
    stdin = '--password-stdin' in args or '--stdin' in args
    args = [a for a in args if not a.startswith('--')]
    users = load_users()
    if cmd in ('add', 'passwd', 'del', 'logout'):
        if len(args) != 1:
            sys.exit('用法：travel-footprints-user %s 名字' % cmd)
        name = args[0]
        if not USER_RE.match(name):
            sys.exit('账号名只能用中文、字母、数字和 _ . -，最长 32 个字。')
        if cmd == 'add':
            if name in users:
                sys.exit('账号 %s 已经有了。想改密码用：travel-footprints-user passwd %s' % (name, name))
            salt, h, it = hash_password(ask_password(stdin))
            users[name] = {'salt': salt, 'hash': h, 'iter': it, 'ver': 1, 'created': time.strftime('%Y-%m-%d %H:%M')}
            save_users(users)
            print('已添加账号：%s' % name)
            return
        if name not in users:
            sys.exit('没有账号 %s。现有账号：%s' % (name, '、'.join(users) or '（无）'))
        if cmd == 'passwd':
            salt, h, it = hash_password(ask_password(stdin))
            users[name].update(salt=salt, hash=h, iter=it, ver=users[name].get('ver', 1) + 1)
            save_users(users)
            print('已修改 %s 的密码，之前登录的设备需要重新登录。' % name)
        elif cmd == 'del':
            del users[name]
            save_users(users)
            print('已删除账号：%s' % name)
        else:
            users[name]['ver'] = users[name].get('ver', 1) + 1
            save_users(users)
            print('%s 已在所有设备上退出登录。' % name)
        return
    if cmd == 'list':
        if not users:
            print('还没有账号。添加：travel-footprints-user add 名字')
        for n, r in users.items():
            print('%s\t（添加于 %s）' % (n, r.get('created', '')))
        return
    store = Store()
    gh = GitHub(store)
    if cmd == 'token':
        tok = sys.stdin.readline().strip() if stdin else getpass.getpass('粘贴 GitHub 令牌（github_pat_ 开头，输入时不显示）：').strip()
        if not tok:
            sys.exit('没有输入令牌，没有保存。')
        code, j = gh.check_repo(tok)
        if code != 200:
            sys.exit('这个令牌访问不了仓库 %s（GitHub 返回 %s），没有保存。请确认令牌完整、没过期，并且勾选了这个仓库。' % (store.repo, code))
        write_private('github-token', tok + '\n')
        print('已保存 GitHub 令牌，可以访问仓库 %s。' % store.repo)
        return
    if cmd == 'check':
        print('仓库：%s（%s 分支）' % (store.repo, store.branch))
        print('允许的网站：%s' % '、'.join(sorted(store.origins)))
        print('账号：%s' % ('、'.join(users) or '（还没有）'))
        if not store.token():
            sys.exit('还没有设置 GitHub 令牌：travel-footprints-user token')
        try:
            code, j = gh.check_repo()
        except GHError as e:
            sys.exit('连不上 GitHub：%s' % e)
        if code != 200:
            sys.exit('GitHub 令牌访问不了仓库（返回 %s），请用 travel-footprints-user token 更换。' % code)
        try:
            sha, data = gh.get()
            print('GitHub 令牌：正常；footprints.json 里有 %d 个标记、%d 个地点。' % (len(norm_marks(data.get('marks'))), len(norm_pins(data.get('pins')))))
        except GHError as e:
            sys.exit('读取 footprints.json 失败（%s）。' % e.status)
        return
    sys.exit('不认识的命令：%s。可用：add、passwd、del、list、logout、token、check' % cmd)


def init(argv):
    """安装脚本调用：写 config.json，没有 secret 时生成一个。"""
    opts = dict(a.split('=', 1) for a in argv if '=' in a)
    cfg = read_json('config.json', {})
    for k in ('repo', 'branch', 'github_api', 'listen'):
        if opts.get(k):
            cfg[k] = opts[k]
    if opts.get('origins'):
        cfg['origins'] = [o for o in opts['origins'].split(',') if o]
    cfg.setdefault('branch', 'main')
    cfg.setdefault('listen', '127.0.0.1:8787')
    write_json('config.json', cfg)
    if not os.path.exists(cpath('secret')):
        write_private('secret', secrets.token_hex(32) + '\n')


if __name__ == '__main__':
    a = sys.argv[1:]
    if a[:1] == ['serve']:
        serve()
    elif a[:1] == ['admin']:
        admin(a[1:])
    elif a[:1] == ['init']:
        init(a[1:])
    else:
        sys.exit('用法：server.py serve | admin 命令 | init key=value…')
PYCODE
chmod 755 "$APP_DIR/server.py"
python3 -m py_compile "$APP_DIR/server.py" || die "程序文件损坏，请重新上传脚本。"
mkdir -p "$CONF_DIR"
chown "$SVC_USER:$SVC_USER" "$CONF_DIR"
chmod 700 "$CONF_DIR"
INIT_ARGS=("repo=$REPO" "branch=$BRANCH" "origins=$ORIGINS" "listen=127.0.0.1:$PORT")
[ -n "${TF_GITHUB_API:-}" ] && INIT_ARGS+=("github_api=$TF_GITHUB_API")
TFAPI_DIR="$CONF_DIR" python3 "$APP_DIR/server.py" init "${INIT_ARGS[@]}"

cat >/usr/local/bin/travel-footprints-user <<EOF
#!/bin/sh
# 旅行足迹地图：管理登录账号（add / passwd / del / list / logout / token / check）
[ "\$(id -u)" -eq 0 ] || { echo "请用 root 运行" >&2; exit 1; }
TFAPI_DIR=$CONF_DIR exec python3 $APP_DIR/server.py admin "\$@"
EOF
chmod 755 /usr/local/bin/travel-footprints-user

# ---------- 2. GitHub 令牌（只存在这台服务器上） ----------
if [ -s "$CONF_DIR/github-token" ]; then
  echo "已经有 GitHub 令牌（要更换：travel-footprints-user token）"
else
  say "设置服务器用的 GitHub 令牌"
  cat <<EOF
服务器要用一个 GitHub 令牌替登录的人提交改动。可以用你浏览器里正在用的那个，
更推荐新建一个专门给服务器用（以后想停掉服务器的修改权限，删掉它就行）：
  GitHub 右上角头像 → Settings → Developer settings → Personal access tokens
  → Fine-grained tokens → Generate new token
  Repository access 选 Only select repositories，只勾 $REPO；
  Permissions → Repository permissions → Contents 选 Read and write。
EOF
  travel-footprints-user token || die "GitHub 令牌没有设置成功，请重新运行这个脚本。"
fi

# ---------- 3. 第一个账号 ----------
if python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("users") else 1)' "$CONF_DIR/users.json" 2>/dev/null; then
  echo "已有账号：$(travel-footprints-user list | cut -f1 | tr '\n' ' ')"
else
  say "添加你自己的账号"
  NAME=""
  while [ -z "$NAME" ]; do read -r -p "账号名（中文、字母、数字都行）：" NAME; done
  travel-footprints-user add "$NAME" || die "账号没有添加成功，请重新运行这个脚本。"
fi

# ---------- 4. 后台服务 ----------
say "启动登录服务"
cat >"/etc/systemd/system/$SVC.service" <<EOF
[Unit]
Description=Travel footprints login and edit API
Wants=network-online.target
After=network-online.target

[Service]
User=$SVC_USER
Group=$SVC_USER
Environment=TFAPI_DIR=$CONF_DIR
ExecStart=/usr/bin/env python3 $APP_DIR/server.py serve
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SVC" >/dev/null 2>&1 || true
systemctl restart "$SVC"
for _ in $(seq 1 10); do
  curl -fsS --noproxy '*' "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1
done
curl -fsS --noproxy '*' "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 \
  || die "登录服务没有启动成功。请把 journalctl -u $SVC -n 30 的输出发给我。"

# ---------- 5. 网站转发 /api/ 到登录服务 ----------
say "配置网站的 /api/ 转发"
mkdir -p "$INC_DIR"
cat >"$INC_DIR/api.conf" <<EOF
# 旅行足迹地图：登录编辑服务（由 mirror/setup-api.sh 生成）
location ^~ /api/ {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header Connection "";
    proxy_read_timeout 90s;
    client_max_body_size 4m;
}
EOF
if ! grep -qF "include $INC_DIR/*.conf;" "$SITE_CONF"; then
  cp -p "$SITE_CONF" "$SITE_CONF.before-api"
  sed -i "s|^    root $WEB;\$|&\n    include $INC_DIR/*.conf;|" "$SITE_CONF"
  grep -qF "include $INC_DIR/*.conf;" "$SITE_CONF" || { mv "$SITE_CONF.before-api" "$SITE_CONF"; die "没找到网站配置里的 root 行，没有改动。请把 $SITE_CONF 的内容发给我。"; }
fi
if ! nginx -t >/dev/null 2>&1; then
  nginx -t || true
  [ -f "$SITE_CONF.before-api" ] && mv "$SITE_CONF.before-api" "$SITE_CONF"
  rm -f "$INC_DIR/api.conf"
  die "nginx 配置检查没通过（上面是错误信息），已经恢复原来的网站配置。"
fi
rm -f "$SITE_CONF.before-api"
systemctl reload nginx

# ---------- 6. 检查 ----------
say "检查"
sleep 1
code="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" || true)"
if [ "$code" = 200 ]; then echo "https://$DOMAIN/api/ ：正常"; else warn "通过网址访问登录服务返回 $code（应该是 200），请把上面的输出发给我。"; fi
travel-footprints-user check || warn "检查没有全部通过，请看上面的提示。"

say "完成"
cat <<EOF
别人打开 https://$DOMAIN 或 https://$OWNER.github.io/${REPO#*/}/ ，点地图上方的「登录编辑」，
输入你给的账号密码，就能一起修改地图。

管理账号（在服务器上用 root 运行）：
  travel-footprints-user add 名字      添加账号（会提示设置密码）
  travel-footprints-user passwd 名字   改密码（这个账号已登录的设备需要重新登录）
  travel-footprints-user del 名字      删除账号
  travel-footprints-user list          列出账号
  travel-footprints-user logout 名字   让这个账号在所有设备上退出登录
  travel-footprints-user token         更换服务器上的 GitHub 令牌
服务状态：systemctl status $SVC      运行记录：journalctl -u $SVC -n 50
EOF
