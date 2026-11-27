#!/usr/bin/env bash
# 旅行足迹地图 · 镜像站一键部署
#
# 用途：在自己的服务器上放一份网页副本（比如给国内访问用），每分钟自动从 GitHub 同步一次。
#       在 GitHub Pages 或镜像站上标记的足迹都会保存到 GitHub，镜像站一分钟内就能同步到。
#
# 用法（在服务器上用 root 运行）：
#   curl -fsSLo setup.sh https://raw.githubusercontent.com/Yexika/travel-footprints/main/mirror/setup.sh
#   bash setup.sh 你的域名 [GitHub 仓库，默认 Yexika/travel-footprints] [分支，默认 main]
#
# 它会：安装 nginx、certbot → 把网页下载到 /var/www/travel-footprints → 设置每分钟同步
#      → 配置 gzip 压缩和缓存 → 申请免费 HTTPS 证书（Let's Encrypt，自动续期）。
# 重复运行是安全的：会更新配置，已有的证书会保留。服务器上不需要 GitHub 令牌。
set -euo pipefail

DOMAIN="${1:-}"
REPO="${2:-Yexika/travel-footprints}"
BRANCH="${3:-main}"
WEB=/var/www/travel-footprints
CONF=/etc/nginx/conf.d/travel-footprints.conf
NAME=travel-footprints-sync

say(){ printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn(){ printf '\n\033[1;33m[注意]\033[0m %s\n' "$*"; }
die(){ printf '\n\033[1;31m[出错]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行（先执行 sudo -i 再运行）。"
DOMAIN="$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z' | sed -E 's#^https?://##; s#/.*$##; s#^www\.##')"
[ -n "$DOMAIN" ] || die "请在命令最后写上域名，例如：bash setup.sh jzsm734.top"
printf '%s' "$DOMAIN" | grep -Eq '^[a-z0-9.-]+\.[a-z0-9-]+$' || die "域名格式不对：$DOMAIN"
printf '%s' "$REPO" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || die "仓库要写成 用户名/仓库名，例如 Yexika/travel-footprints"

if [ -d /www/server/panel ]; then
  die "这台服务器装了宝塔面板，它自带的 nginx 会和这个脚本冲突。请在宝塔里新建站点，再把仓库克隆进站点目录，并添加每分钟执行 git pull 的计划任务。"
fi
# 80/443 端口如果已经被别的程序（比如代理服务）占用，直接停下，什么都不改
port_holder(){
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | awk -v p="$1" '$4 ~ ("[:.]" p "$")' | grep -o 'users:(("[^"]*' | head -1 | cut -d'"' -f2 || true
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltnp 2>/dev/null | awk -v p="$1" '$4 ~ ("[:.]" p "$") {print $7}' | head -1 | cut -d/ -f2- || true
  fi
}
for port in 80 443; do
  holder="$(port_holder "$port")"
  if [ "$holder" = xray ] && [ "$port" = 443 ]; then
    die "443 端口正在被 Xray 使用，脚本没有做任何改动。如果是 Xray Reality，请改用同目录下的 setup-reality.sh：它让网站和 Xray 共用 443 端口，代理客户端不用改。"
  fi
  if [ -n "$holder" ] && [ "$holder" != nginx ]; then
    die "$port 端口正在被 $holder 使用。为了不影响它，脚本没有做任何改动。请把这一行发给我，我按你服务器上的配置调整。"
  fi
done
if command -v nginx >/dev/null 2>&1 && nginx -T 2>/dev/null | grep -Eq '^[[:space:]]*stream[[:space:]]*\{'; then
  die "服务器上的 nginx 已经配置了 stream 转发（常见于代理服务）。为了不影响它，脚本没有做任何改动。请把这一行发给我。"
fi

# ---------- 1. 安装软件 ----------
say "安装 nginx、certbot"
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y </dev/null
  apt-get install -y --no-install-recommends nginx curl ca-certificates </dev/null
  apt-get install -y --no-install-recommends certbot python3-certbot-nginx </dev/null || warn "certbot 没装上，先只开 HTTP。"
elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
  PM="$(command -v dnf || command -v yum)"
  "$PM" install -y epel-release </dev/null || true
  "$PM" install -y nginx curl ca-certificates tar gzip </dev/null
  "$PM" install -y certbot python3-certbot-nginx </dev/null || warn "certbot 没装上，先只开 HTTP。"
else
  die "没认出系统的软件包管理器。支持 Ubuntu、Debian、CentOS、Rocky、AlmaLinux 等。"
fi
command -v flock >/dev/null 2>&1 || die "缺少 flock 命令（通常在 util-linux 包里）。"

# ---------- 2. 下载网页，设置每分钟同步 ----------
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
"/usr/local/bin/$NAME" || die "从 GitHub 下载网页失败。请确认仓库 $REPO 存在而且是公开的。"
# 告诉网页“这是镜像站”：足迹从本站同步的 footprints.json 读取，连接 GitHub 时自动填好仓库名
printf '{"repo":"%s","branch":"%s"}\n' "$REPO" "$BRANCH" >"$WEB/mirror.json"
if command -v restorecon >/dev/null 2>&1; then restorecon -R "$WEB" || true; fi

if [ -d /run/systemd/system ]; then
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
  rm -f "/etc/cron.d/$NAME"
  systemctl daemon-reload
  systemctl enable --now "$NAME.timer" >/dev/null
  LOGCMD="journalctl -u $NAME -n 20"
else
  echo "* * * * * root /usr/local/bin/$NAME >/dev/null 2>&1" >"/etc/cron.d/$NAME"
  LOGCMD="手动运行 $NAME 看输出"
fi

# ---------- 4. 检查域名解析 ----------
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
if [ -z "$IP_APEX" ]; then
  warn "$DOMAIN 还解析不到 IP。DNS 刚改的话可能要等几分钟，之后再运行一次这个脚本即可。"
elif [ -n "$MYIP" ] && [ "$IP_APEX" != "$MYIP" ]; then
  warn "$DOMAIN 解析到的 $IP_APEX 不是这台服务器（$MYIP）。如果开了 Cloudflare 之类的代理，可以先关掉代理（灰色云朵）。"
fi

# ---------- 5. nginx ----------
say "配置 nginx"
mkdir -p /etc/nginx/travel-footprints.d   # 附加配置（比如 setup-api.sh 的 /api/ 转发）放在这里
V6=""
if [ -f /proc/net/if_inet6 ]; then V6="    listen [::]:80;"; fi
cat >"$CONF" <<EOF
# 旅行足迹地图 · 镜像站（由 mirror/setup.sh 生成，重新运行脚本会覆盖）
server {
    listen 80;
$V6
    server_name $NAMES;
    root $WEB;
    include /etc/nginx/travel-footprints.d/*.conf;
    index index.html;
    charset utf-8;

    gzip on;
    gzip_vary on;
    gzip_comp_level 6;
    gzip_min_length 1024;
    gzip_types text/css application/javascript application/json image/svg+xml text/plain;

    # 不对外提供 .git 等隐藏文件（申请证书用的 .well-known 除外）
    location ~ /\.(?!well-known/) { return 404; }
    # 地图组件和字体：版本固定，浏览器缓存 30 天
    location ^~ /lib/   { add_header Cache-Control "public, max-age=2592000, immutable"; }
    location ^~ /fonts/ { add_header Cache-Control "public, max-age=2592000, immutable"; }
    # 地图边界和景点数据：缓存 1 小时
    location ^~ /data/  { add_header Cache-Control "public, max-age=3600"; }
    # 网页、代码和足迹：每次都向服务器确认有没有更新（没变化时只返回很小的 304）
    location / {
        add_header Cache-Control "no-cache";
        try_files \$uri \$uri/ =404;
    }
}
EOF
if ! nginx -t >/dev/null 2>&1 && [ -n "$V6" ]; then
  sed -i '/listen \[::\]:80;/d' "$CONF"   # 服务器不支持 IPv6 时只监听 IPv4
fi
nginx -t || die "nginx 配置检查没通过，上面是错误信息。"
systemctl enable nginx >/dev/null 2>&1 || true
systemctl restart nginx

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd -q --permanent --add-service=http --add-service=https && firewall-cmd -q --reload
fi

code="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $DOMAIN" http://127.0.0.1/ || true)"
[ "$code" = 200 ] || warn "本机访问网站返回 $code（应该是 200），请把上面的输出发给我看看。"

# ---------- 6. HTTPS ----------
HTTPS=0
if command -v certbot >/dev/null 2>&1 && [ -n "$IP_APEX" ]; then
  say "申请 HTTPS 证书（Let's Encrypt）"
  if certbot --nginx -n --agree-tos --register-unsafely-without-email --keep-until-expiring --redirect "${CERT_ARGS[@]}" </dev/null; then
    HTTPS=1
    # 打开 HTTP/2：一次连接并行下载多个文件，跨洋访问更快
    cp "$CONF" "$CONF.bak"
    sed -i -E 's/listen (\[::\]:)?443 ssl( ipv6only=on)?;/listen \1443 ssl http2\2;/' "$CONF"
    if nginx -t >/dev/null 2>&1; then rm -f "$CONF.bak"; else mv "$CONF.bak" "$CONF"; fi
    systemctl reload nginx
    systemctl enable --now certbot-renew.timer >/dev/null 2>&1 || true
  else
    warn "证书没申请下来，网站先用 http 访问。等域名解析生效、80 端口能从外网访问后，再运行一次这个脚本。"
  fi
fi

# ---------- 完成 ----------
URL="http://$DOMAIN"; [ "$HTTPS" = 1 ] && URL="https://$DOMAIN"
say "完成"
cat <<EOF
网址：$URL
网站文件：$WEB
同步：每分钟从 github.com/$REPO 的 $BRANCH 分支拉取一次
立即同步：$NAME
同步记录：$LOGCMD

如果浏览器打不开，请到服务器商的控制台，在「安全组」或「防火墙」里放行 TCP 80 和 443 端口。
EOF
