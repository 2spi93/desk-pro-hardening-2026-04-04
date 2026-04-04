# TXT Caddy Deployment

Files:
- `deploy/caddy/Caddyfile.txt-gtixt`
- `deploy/caddy/install_txt_caddy.sh`
- `deploy/caddy/verify_txt_https.sh`
- `deploy/caddy/systemd/caddy.service.d/override.conf`

## Target mapping

- `txt.gtixt.com` -> redirect to `app.txt.gtixt.com`
- `staging.txt.gtixt.com` -> Mission Control UI on `127.0.0.1:3000`
- `app.txt.gtixt.com` -> Mission Control UI on `127.0.0.1:3000`
- `api.staging.txt.gtixt.com` -> Control Plane on `127.0.0.1:8000`
- `api.txt.gtixt.com` -> Control Plane on `127.0.0.1:8000`
- `control.txt.gtixt.com` -> Risk Gateway on `127.0.0.1:8001`

WebSocket routing preserved from the existing Nginx gateway:
- `/ws/v1/market/quotes*` -> `127.0.0.1:8000`
- `/ws/v1/market/*` -> `127.0.0.1:8003`
- `/ws/v1/execution/*` -> `127.0.0.1:8000`
- `/v1/connectors/ws` -> `127.0.0.1:8000`

## Exact VPS Order

1. Install and activate Caddy:

```bash
sudo sh /opt/txt/deploy/caddy/install_txt_caddy.sh
```

2. Optional but recommended systemd override:

```bash
sudo install -d /etc/systemd/system/caddy.service.d
sudo cp /opt/txt/deploy/caddy/systemd/caddy.service.d/override.conf /etc/systemd/system/caddy.service.d/override.conf
sudo systemctl daemon-reload
sudo systemctl restart caddy
```

3. Verify listener and public HTTPS:

```bash
sh /opt/txt/deploy/caddy/verify_txt_https.sh
```

4. If needed, open firewall:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw reload
```

5. Re-run strict QA:

```bash
cd /opt/txt/ui/mission-control
sh scripts/qa-real-control-plane.sh staging
sh scripts/qa-real-control-plane.sh prod
```

## Manual Install

```bash
sudo apt update
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

## Deploy

```bash
sudo cp /opt/txt/deploy/caddy/Caddyfile.txt-gtixt /etc/caddy/Caddyfile
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl restart caddy
sudo systemctl status caddy --no-pager
```

## If HTTPS Still Fails

Check:

```bash
docker ps
ss -ltnp | grep ':8000\|:8001\|:8003\|:3000'
ping api.txt.gtixt.com
```

Expected minimum:
- `127.0.0.1:8000` responds on `/health`
- Caddy listens on `:443`
- `curl https://api.txt.gtixt.com/health` returns status `200`

## Required firewall

Open:
- `80/tcp`
- `443/tcp`

## Required app state

The compose stack must expose these local ports on the TXT VPS:
- `3000`
- `8000`
- `8001`
- `8003`

## Verification

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://app.txt.gtixt.com
curl -sS -o /dev/null -w "%{http_code}\n" https://api.txt.gtixt.com/health
curl -sS -o /dev/null -w "%{http_code}\n" https://api.staging.txt.gtixt.com/health
curl -sS -o /dev/null -w "%{http_code}\n" https://control.txt.gtixt.com/health
```

## After proxy is live

Re-run strict QA:

```bash
cd /opt/txt/ui/mission-control
sh scripts/qa-real-control-plane.sh staging
sh scripts/qa-real-control-plane.sh prod
```
