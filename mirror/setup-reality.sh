#!/usr/bin/env bash
# 旅行足迹地图 · 镜像站部署（服务器的 443 端口已经被 Xray Reality 使用时用这个脚本）
#
# 做法：HAProxy 接管 443 端口，只看连接里的域名（SNI）来分流，不解密任何代理流量
#      （Debian 11 自带的 nginx 没有按域名分流的模块，所以分流交给 HAProxy，nginx 只负责网站）：
#   访问 本站域名 或 www.本站域名 → 网站（Let's Encrypt 免费证书）
#   其余所有连接（代理客户端、探测）    → 原样转给 Xray（Xray 改为只在本机 127.0.0.1 监听）
# 代理客户端的配置不用改。改 Xray 之前会备份配置；切换后自动检查网站和 Reality，
# 任何一项不通过就自动恢复原样。80 端口用来申请、续期证书，并把 http 跳转到 https。
#
# 用法（root）：
#   curl -fsSLo setup-reality.sh https://raw.githubusercontent.com/Yexika/travel-footprints/main/mirror/setup-reality.sh
#   bash setup-reality.sh 你的域名 [GitHub 仓库，默认 Yexika/travel-footprints] [分支，默认 main]
# 撤销（Xray 恢复直接监听 443，网站改回只用 http）：
#   bash setup-reality.sh --undo
set -euo pipefail

WEB=/var/www/travel-footprints
ACME=/var/www/letsencrypt
SITE_CONF=/etc/nginx/conf.d/travel-footprints.conf
HACFG=/etc/haproxy/haproxy.cfg
HADIST=/etc/haproxy/haproxy.cfg.before-travel-footprints
HAMARK="# travel-footprints: 443 SNI split"
V6=0
XCONF="${XRAY_CONFIG:-/usr/local/etc/xray/config.json}"
XBACKUP="$XCONF.before-travel-footprints"
STATE=/etc/travel-footprints-reality.env
NAME=travel-footprints-sync
PY=/tmp/travel-footprints-xray.py
XNEW=/tmp/travel-footprints-xray-new.json
XUNDO=/tmp/travel-footprints-xray-undo.json
XPORT=""; SITE_PORT=""; ORIG_LISTEN=""

say(){ printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn(){ printf '\n\033[1;33m[注意]\033[0m %s\n' "$*"; }
die(){ printf '\n\033[1;31m[停止]\033[0m %s\n' "$*" >&2; exit 1; }

port_holder(){
  ss -ltnp 2>/dev/null | awk -v p="$1" '$4 ~ ("[:.]" p "$")' | grep -o 'users:(("[^"]*' | head -1 | cut -d'"' -f2 || true
}
wait_port(){  # wait_port 端口 期望的程序名（空=没人占用） 秒数
  for _ in $(seq 1 "$3"); do [ "$(port_holder "$1")" = "$2" ] && return 0; sleep 1; done
  return 1
}
pick_port(){
  local p
  for p in "$@"; do [ -z "$(port_holder "$p")" ] && { echo "$p"; return 0; }; done
  die "本机端口 $* 都被占用了，请把这一行发给我。"
}
xray_test(){  # Xray 按扩展名判断配置格式，所以临时文件都以 .json 结尾；没通过时显示 Xray 的报错
  local out
  out="$("$XBIN" run -test -c "$1" 2>&1)" && return 0
  "$XBIN" -test -config "$1" >/dev/null 2>&1 && return 0
  printf '%s\n' "$out" | tail -n 8 >&2
  return 1
}
reality_ok(){  # 用 Reality 的伪装域名握手一次：能拿到证书说明 Reality 正常转发
  timeout 15 openssl s_client -connect "127.0.0.1:$1" -servername "$SNI" </dev/null 2>/dev/null | grep -q 'BEGIN CERTIFICATE'
}

write_py(){
cat >"$PY" <<'PY'
import json, shlex, sys
mode, path, port = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    c = json.load(open(path, encoding='utf-8'))
except Exception as e:
    print('ERR=' + shlex.quote('Xray 配置不是标准 JSON（可能带了注释）：%s' % e)); sys.exit(0)
ins = [i for i in (c.get('inbounds') or []) if str(i.get('port')) == port]
print('COUNT=%d' % len(ins))
if len(ins) == 1:
    i = ins[0]; st = i.get('streamSettings') or {}; r = st.get('realitySettings') or {}
    names = [str(n) for n in (r.get('serverNames') or []) if str(n).strip()]
    q = lambda v: shlex.quote(str(v))
    print('SECURITY=' + q(st.get('security', '')))
    print('NETWORK=' + q(st.get('network', 'tcp')))
    print('LISTEN=' + q(i.get('listen', '')))
    print('SNAMES=' + q(' '.join(names)))
    print('SNI=' + q(names[0] if names else ''))
    print('TARGET=' + q(r.get('target') or r.get('dest') or ''))
    if mode in ('move', 'back'):
        out = sys.argv[4]
        if mode == 'move':
            i['listen'] = '127.0.0.1'; i['port'] = int(sys.argv[5])
        else:
            i['port'] = 443
            if len(sys.argv) > 5 and sys.argv[5]: i['listen'] = sys.argv[5]
            else: i.pop('listen', None)
        with open(out, 'w', encoding='utf-8') as f:
            json.dump(c, f, ensure_ascii=False, indent=2); f.write('\n')
PY
}

site_locations(){
cat <<EOF
    root $WEB;
    include /etc/nginx/travel-footprints.d/*.conf;
    index index.html;
    charset utf-8;

    gzip on;
    gzip_vary on;
    gzip_comp_level 6;
    gzip_min_length 1024;
    gzip_types text/css application/javascript application/json image/svg+xml text/plain;

    # 不对外提供 .git 等隐藏文件
    location ~ /\\. { return 404; }
    # 地图组件和字体：版本固定，浏览器缓存 30 天
    location ^~ /lib/   { add_header Cache-Control "public, max-age=2592000, immutable"; }
    location ^~ /fonts/ { add_header Cache-Control "public, max-age=2592000, immutable"; }
    # 地图边界和景点数据：缓存 1 小时
    location ^~ /data/  { add_header Cache-Control "public, max-age=3600"; }
    # 网页、代码和足迹：每次都向服务器确认有没有更新
    location / {
        add_header Cache-Control "no-cache";
        try_files \$uri \$uri/ =404;
    }
EOF
}

write_site_conf(){  # serve：80 端口直接提供网站；https：80 跳转，网站在本机端口上走 https
  local v6=""
  mkdir -p /etc/nginx/travel-footprints.d   # 附加配置（比如 setup-api.sh 的 /api/ 转发）放在这里，重新生成配置时也会保留
  [ -f /proc/net/if_inet6 ] && v6="    listen [::]:80;"
  {
    echo "# 旅行足迹地图 · 镜像站（由 mirror/setup-reality.sh 生成，重新运行脚本会覆盖）"
    echo "server {"
    echo "    listen 80;"
    echo "$v6"
    echo "    server_name $NAMES;"
    echo "    location ^~ /.well-known/acme-challenge/ { root $ACME; default_type text/plain; }"
    if [ "$1" = https ]; then
      echo "    location / { return 301 https://\$host\$request_uri; }"
      echo "}"
      echo
      echo "# 443 端口由 HAProxy 按域名分流（$HACFG），访问本站的连接转到这里"
      echo "server {"
      echo "    listen 127.0.0.1:$SITE_PORT ssl http2;"
      echo "    server_name $NAMES;"
      echo "    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;"
      echo "    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;"
      echo "    ssl_protocols TLSv1.2 TLSv1.3;"
      echo "    ssl_session_cache shared:travelfp:10m;"
      echo "    ssl_session_timeout 1d;"
      echo
      site_locations
      echo "}"
    else
      echo
      site_locations
      echo "}"
    fi
  } >"$SITE_CONF"
  if [ -n "$v6" ] && ! nginx -t >/dev/null 2>&1; then sed -i '/listen \[::\]:80;/d' "$SITE_CONF"; fi
}

write_haproxy_cfg(){
  local bind="    bind *:443"
  [ "$V6" = 1 ] && bind="    bind :::443 v4v6"
  cat >"$HACFG" <<EOF
$HAMARK
# 旅行足迹地图：443 端口按域名（SNI）分流，只读取域名，不解密流量（由 mirror/setup-reality.sh 生成）
# 访问本站 → 本机 $SITE_PORT 端口的网站（nginx）；其余（代理客户端、探测）→ 本机 $XPORT 端口的 Xray
global
    log /dev/log local0 warning
    user haproxy
    group haproxy

defaults
    mode tcp
    log global
    timeout connect 5s
    timeout client 1h
    timeout server 1h

frontend travelfp_443
$bind
    tcp-request inspect-delay 5s
    tcp-request content accept if { req.ssl_hello_type 1 }
    use_backend travelfp_site if { req.ssl_sni -i $NAMES }
    default_backend travelfp_xray

backend travelfp_site
    server site 127.0.0.1:$SITE_PORT

backend travelfp_xray
    server xray 127.0.0.1:$XPORT
EOF
}

restore_original(){  # restore_original Xray配置来源：停掉 HAProxy，恢复 Xray 直接监听 443（网站改回 http）
  systemctl stop haproxy >/dev/null 2>&1 || true
  systemctl disable haproxy >/dev/null 2>&1 || true
  if [ -f "$HADIST" ]; then cp -p "$HADIST" "$HACFG"; fi
  write_site_conf serve
  nginx -t >/dev/null 2>&1 && systemctl reload nginx
  wait_port 443 "" 10 || true
  cat "$1" >"$XCONF"
  systemctl restart xray
  wait_port 443 xray 10
}

# ---------- 准备 ----------
[ "$(id -u)" -eq 0 ] || die "请用 root 运行（先执行 sudo -i 再运行）。"
command -v apt-get >/dev/null 2>&1 || die "这个脚本只支持 Debian / Ubuntu。"
[ -d /run/systemd/system ] || die "需要 systemd。"
command -v ss >/dev/null 2>&1 || { apt-get update -y </dev/null; apt-get install -y iproute2 </dev/null; }
XBIN="$(command -v xray || echo /usr/local/bin/xray)"
[ -x "$XBIN" ] || die "没找到 xray 程序。"
[ -f "$XCONF" ] || die "没找到 Xray 配置 $XCONF。"

# ---------- 撤销 ----------
if [ "${1:-}" = "--undo" ]; then
  [ -f "$XBACKUP" ] || die "没找到备份 $XBACKUP，看起来没有做过切换。"
  # shellcheck source=/dev/null
  [ -f "$STATE" ] && . "$STATE"
  DOMAIN="${DOMAIN:-localhost}"; NAMES="${NAMES:-$DOMAIN}"
  say "恢复 Xray 直接监听 443"
  command -v python3 >/dev/null 2>&1 && write_py
  # 优先只把入站端口改回 443（保留切换之后对 Xray 做的其他修改）；不行再用切换前的备份
  if [ -n "$XPORT" ] && command -v python3 >/dev/null 2>&1 \
     && python3 "$PY" back "$XCONF" "$XPORT" "$XUNDO" "$ORIG_LISTEN" | grep -q '^COUNT=1$' \
     && xray_test "$XUNDO"; then
    SRC="$XUNDO"
  else
    SRC="$XBACKUP"
  fi
  cp -p "$XCONF" "$XCONF.before-undo"
  if restore_original "$SRC"; then
    rm -f "$XUNDO"
    mv "$XBACKUP" "$XBACKUP.restored-$(date +%Y%m%d%H%M%S)"
    rm -f "$STATE"
    say "已撤销：Xray 照常监听 443。网站还在，可以用 http://$DOMAIN 访问。"
    exit 0
  fi
  die "Xray 没能重新监听 443。手动恢复：systemctl stop haproxy && cp $XBACKUP $XCONF && systemctl restart xray"
fi

DOMAIN="$(printf '%s' "${1:-}" | tr 'A-Z' 'a-z' | sed -E 's#^https?://##; s#/.*$##; s#^www\.##')"
REPO="${2:-Yexika/travel-footprints}"
BRANCH="${3:-main}"
[ -n "$DOMAIN" ] || die "请在命令最后写上域名，例如：bash setup-reality.sh jzsm734.top"
printf '%s' "$DOMAIN" | grep -Eq '^[a-z0-9.-]+\.[a-z0-9-]+$' || die "域名格式不对：$DOMAIN"
printf '%s' "$REPO" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || die "仓库要写成 用户名/仓库名"

H443="$(port_holder 443)"
if [ "$H443" = xray ]; then
  MODE=fresh
elif [ "$H443" = haproxy ] && grep -qF "$HAMARK" "$HACFG" 2>/dev/null && [ -f "$STATE" ] && [ -f "$XBACKUP" ]; then
  MODE=rerun
elif [ -z "$H443" ]; then
  die "443 端口现在没有程序在用。Xray 是不是没在运行？可以先 systemctl status xray 看看。"
else
  die "443 端口正在被 $H443 使用。这个脚本只处理 Xray Reality，没有做任何改动。"
fi
# 现在占用 443 的程序如果同时听 IPv4 和 IPv6（显示为 *:443 或 [::]:443），接管后也一样
ss -ltn 2>/dev/null | awk '$4 ~ /^(\*|\[::\]):443$/' | grep -q . && V6=1
H80="$(port_holder 80)"
[ -z "$H80" ] || [ "$H80" = nginx ] || die "80 端口正在被 $H80 使用，没有做任何改动。请把这一行发给我。"
systemctl is-active --quiet xray || die "xray 服务没有在运行（systemctl status xray 看看），没有做任何改动。"
systemctl show -p ExecStart xray 2>/dev/null | grep -q -- "$XCONF" || die "Xray 不是用 $XCONF 启动的，没有做任何改动。请把 systemctl cat xray 的输出发给我。"

command -v python3 >/dev/null 2>&1 || { apt-get update -y </dev/null; apt-get install -y python3 </dev/null; }
write_py
if [ "$MODE" = fresh ]; then
  eval "$(python3 "$PY" info "$XCONF" 443)"
else
  # shellcheck source=/dev/null
  . "$STATE"
  eval "$(python3 "$PY" info "$XCONF" "$XPORT")"
fi
[ -z "${ERR:-}" ] || die "$ERR"
[ "${COUNT:-0}" = 1 ] || die "没在 Xray 配置里找到唯一一个监听这个端口的入站（找到 ${COUNT:-0} 个），没有做任何改动。"
[ "$SECURITY" = reality ] || die "这个入站用的是 $SECURITY，不是 Reality。没有做任何改动，请把这一行发给我。"
[ -n "$SNI" ] || die "Reality 配置里没有 serverNames，没有做任何改动。"
for n in $SNAMES; do
  case "$n" in "$DOMAIN"|"www.$DOMAIN") die "Reality 的 serverNames 里有 $n，和网站域名冲突，没有做任何改动。";; esac
done
echo "Xray：Reality + $NETWORK，伪装域名 $SNAMES，转发目标 ${TARGET:-未写}"

# ---------- 1. 安装软件 ----------
say "安装 nginx、HAProxy、certbot"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y </dev/null
apt-get install -y --no-install-recommends nginx haproxy curl ca-certificates certbot openssl </dev/null \
  || die "安装 nginx / HAProxy / certbot 失败（上面是错误信息）。Xray 没有改动，请把输出发给我。"
command -v haproxy >/dev/null 2>&1 || die "HAProxy 没装上。Xray 没有改动，请把输出发给我。"
if [ -f "$HACFG" ] && ! grep -qF "$HAMARK" "$HACFG"; then cp -p "$HACFG" "$HADIST"; fi
systemctl enable nginx >/dev/null 2>&1 || true
systemctl is-active --quiet nginx || systemctl start nginx

# ---------- 2. 克隆仓库，每分钟同步 ----------
say "从 GitHub 下载网页（$REPO 的 $BRANCH 分支）"
# 同步脚本：不需要 git，只用 curl。先查 GitHub 上 $BRANCH 分支的最新提交，有变化才下载整份网页并替换
{
  printf '#!/bin/sh\n# 从 GitHub 同步网页（不需要 git）。由定时任务每分钟运行一次，也可以手动运行。\n'
  printf 'REPO=%s\nBRANCH=%s\nWEB=%s\nLOCK=/run/%s.lock\n' "$REPO" "$BRANCH" "$WEB" "$NAME"
  cat <<'SYNC'
exec 9>"$LOCK"
flock -n 9 || exit 0
sha=$(curl -fsS --max-time 20 "https://github.com/$REPO.git/info/refs?service=git-upload-pack" | grep -a -o "[0-9a-f]\{40\} refs/heads/$BRANCH\$" | head -1 | cut -c1-40)
[ -n "$sha" ] || { echo "查不到 GitHub 上的最新提交，稍后重试" >&2; exit 1; }
[ -d "$WEB" ] && [ "$sha" = "$(cat "$WEB/.sha" 2>/dev/null)" ] && exit 0
parent=$(dirname "$WEB"); mkdir -p "$parent"
tmp=$(mktemp -d "$parent/.travel-footprints-new.XXXXXX") || exit 1
if ! curl -fsSL --max-time 180 "https://codeload.github.com/$REPO/tar.gz/$sha" | tar -xz -C "$tmp" --strip-components=1 || [ ! -f "$tmp/index.html" ]; then
  rm -rf "$tmp"; echo "下载失败，稍后重试" >&2; exit 1
fi
[ -f "$WEB/mirror.json" ] && cp "$WEB/mirror.json" "$tmp/"
echo "$sha" >"$tmp/.sha"
chmod 755 "$tmp"
rm -rf "$WEB.old"
[ -d "$WEB" ] && mv "$WEB" "$WEB.old"
mv "$tmp" "$WEB" && rm -rf "$WEB.old"
echo "已同步到 $(echo "$sha" | cut -c1-7)"
SYNC
} >"/usr/local/bin/$NAME"
chmod 755 "/usr/local/bin/$NAME"
"/usr/local/bin/$NAME" || die "从 GitHub 下载网页失败。请确认仓库 $REPO 存在而且是公开的。Xray 没有改动。"
# 告诉网页“这是镜像站”：足迹从本站同步的 footprints.json 读取，连接 GitHub 时自动填好仓库名
printf '{"repo":"%s","branch":"%s"}\n' "$REPO" "$BRANCH" >"$WEB/mirror.json"
cat >"/etc/systemd/system/$NAME.service" <<EOF
[Unit]
Description=Sync travel footprints site from GitHub
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/$NAME
EOF
cat >"/etc/systemd/system/$NAME.timer" <<EOF
[Unit]
Description=Sync travel footprints site from GitHub every minute

[Timer]
OnCalendar=minutely
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now "$NAME.timer" >/dev/null 2>&1

# ---------- 3. 域名解析 ----------
say "检查域名解析"
MYIP="$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || curl -4 -fsS --max-time 8 https://ifconfig.me 2>/dev/null || true)"
res(){ getent ahostsv4 "$1" 2>/dev/null | awk 'NR==1{print $1}' || true; }
IP_APEX="$(res "$DOMAIN")"
IP_WWW="$(res "www.$DOMAIN")"
NAMES="$DOMAIN"
CERT_ARGS=(-d "$DOMAIN")
if [ -n "$IP_WWW" ] && { [ -z "$MYIP" ] || [ "$IP_WWW" = "$MYIP" ]; }; then
  NAMES="$NAMES www.$DOMAIN"; CERT_ARGS+=(-d "www.$DOMAIN")
fi
echo "这台服务器的公网 IP：${MYIP:-没查到}"
echo "$DOMAIN 解析到：${IP_APEX:-（解析不到）}"
echo "www.$DOMAIN 解析到：${IP_WWW:-（没有设置，跳过）}"
[ -n "$IP_APEX" ] || die "$DOMAIN 还解析不到 IP。等解析生效后再运行一次。Xray 没有改动。"
if [ -n "$MYIP" ] && [ "$IP_APEX" != "$MYIP" ]; then
  die "$DOMAIN 解析到的 $IP_APEX 不是这台服务器（$MYIP）。Xray 没有改动。"
fi

# ---------- 4. 申请证书（走 80 端口，不碰 443） ----------
say "申请 HTTPS 证书（Let's Encrypt）"
mkdir -p "$ACME"
if [ "$MODE" = fresh ]; then write_site_conf serve; fi
nginx -t >/dev/null 2>&1 || { nginx -t; die "nginx 配置检查没通过。Xray 没有改动。"; }
systemctl reload nginx
code="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $DOMAIN" http://127.0.0.1/.well-known/acme-challenge/none || true)"
[ "$code" = 404 ] || warn "本机访问 80 端口返回 $code，证书可能申请不下来。"
certbot certonly --webroot -w "$ACME" --cert-name "$DOMAIN" -n --agree-tos --register-unsafely-without-email \
  --keep-until-expiring --expand --deploy-hook "systemctl reload nginx" "${CERT_ARGS[@]}" </dev/null \
  || die "证书没申请下来。请确认服务器商的安全组放行了 TCP 80 端口，然后再运行一次。Xray 没有改动；网站暂时可以用 http://$DOMAIN 访问。"
systemctl enable --now certbot.timer >/dev/null 2>&1 || true

# ---------- 5. 准备分流配置并检查 ----------
say "准备 443 端口的分流配置"
if [ "$MODE" = fresh ]; then
  XPORT="$(pick_port 4430 14430 24430)"
  SITE_PORT="$(pick_port 8443 18443 28443)"
fi
cp -p "$SITE_CONF" "$SITE_CONF.prev"
if [ -f "$HACFG" ]; then cp -p "$HACFG" "$HACFG.prev"; fi
write_site_conf https
write_haproxy_cfg
if ! nginx -t >/dev/null 2>&1 || ! haproxy -c -q -f "$HACFG" >/dev/null 2>&1; then
  nginx -t || true; haproxy -c -f "$HACFG" || true
  mv "$SITE_CONF.prev" "$SITE_CONF"
  if [ -f "$HACFG.prev" ]; then mv "$HACFG.prev" "$HACFG"; fi
  systemctl reload nginx || true
  die "分流配置检查没通过（上面是错误信息），已经恢复刚才的配置，Xray 没有改动。"
fi
rm -f "$SITE_CONF.prev" "$HACFG.prev"
[ "$MODE" = fresh ] && ORIG_LISTEN="$LISTEN"
printf 'DOMAIN=%q\nNAMES=%q\nXPORT=%q\nSITE_PORT=%q\nSNI=%q\nORIG_LISTEN=%q\n' "$DOMAIN" "$NAMES" "$XPORT" "$SITE_PORT" "$SNI" "$ORIG_LISTEN" >"$STATE"

if [ "$MODE" = fresh ]; then
  BASE=0; reality_ok 443 && BASE=1
  [ "$BASE" = 1 ] || warn "切换前用 $SNI 握手也没有成功（可能是这台服务器连不上 Reality 的转发目标），切换后只检查端口。"
  cp -p "$XCONF" "$XBACKUP"
  python3 "$PY" move "$XCONF" 443 "$XNEW" "$XPORT" >/dev/null
  if ! xray_test "$XNEW"; then
    rm -f "$XNEW"; write_site_conf serve; systemctl reload nginx || true
    if [ -f "$HADIST" ]; then cp -p "$HADIST" "$HACFG"; fi
    die "改好的 Xray 配置没通过检查。Xray 没有改动。"
  fi

  # ---------- 6. 切换（代理会断开一两秒，客户端会自动重连） ----------
  say "切换：Xray 改到本机 $XPORT 端口，HAProxy 接管 443"
  cat "$XNEW" >"$XCONF"; rm -f "$XNEW"
  systemctl enable haproxy >/dev/null 2>&1 || true
  systemctl restart xray
  wait_port 443 "" 10 || true
  systemctl restart haproxy || true
  wait_port 443 haproxy 10 || true
  systemctl reload nginx || true
  sleep 1
else
  systemctl reload nginx
  systemctl reload haproxy || systemctl restart haproxy
  sleep 1
fi

# ---------- 7. 检查 ----------
say "检查网站和 Reality"
OK=1
[ "$(port_holder 443)" = haproxy ] || { warn "HAProxy 没有接管 443 端口。"; OK=0; }
[ "$(port_holder "$XPORT")" = xray ] || { warn "Xray 没有在本机 $XPORT 端口运行。"; OK=0; }
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" || true)"
if [ "$code" = 200 ]; then echo "网站 https://$DOMAIN ：正常"; else warn "网站检查没通过（返回 $code）。"; OK=0; fi
if [ "$MODE" = rerun ] || [ "${BASE:-0}" = 1 ]; then
  if reality_ok 443; then echo "Reality（伪装域名 $SNI）：正常"; else warn "Reality 检查没通过。"; OK=0; fi
fi

if [ "$OK" != 1 ]; then
  if [ "$MODE" = fresh ]; then
    warn "检查没通过，正在恢复原来的设置……"
    if restore_original "$XBACKUP"; then
      rm -f "$STATE"
      die "已恢复原样：Xray 照常监听 443，代理不受影响。网站暂时用 http://$DOMAIN 访问。请把上面的输出发给我。"
    fi
    die "自动恢复也没成功。请手动运行：systemctl stop haproxy && cp $XBACKUP $XCONF && systemctl restart xray"
  fi
  die "重新运行后检查没通过。可以用 bash $0 --undo 恢复原样，并把上面的输出发给我。"
fi

say "完成"
cat <<EOF
网址：https://$DOMAIN
网站文件：$WEB（每分钟从 github.com/$REPO 的 $BRANCH 分支同步）
立即同步：$NAME        同步记录：journalctl -u $NAME -n 20
443 分流配置：$HACFG（HAProxy）
Xray 现在监听 127.0.0.1:$XPORT，原配置备份在 $XBACKUP
代理客户端不用改。想恢复原样：bash $0 --undo
EOF
