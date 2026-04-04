#!/usr/bin/env sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo sh /opt/txt/deploy/caddy/install_txt_caddy.sh"
  exit 1
fi

apt update
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg

curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg

curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  > /etc/apt/sources.list.d/caddy-stable.list

apt update
apt install -y caddy

cp /opt/txt/deploy/caddy/Caddyfile.txt-gtixt /etc/caddy/Caddyfile
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable caddy
systemctl restart caddy
systemctl status caddy --no-pager

echo "[caddy:install] done"
