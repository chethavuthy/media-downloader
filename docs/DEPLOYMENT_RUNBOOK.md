# ClipSniper Deployment Runbook

Last updated: 2026-04-09

## 1) What This Runbook Covers

This document records:
- How production was migrated from Cloudflare Workers to VPS (`143.198.161.167`).
- Required environment variables and safe templates.
- Commands to deploy, restart, and monitor.
- All important code/config changes made in this migration.
- Security and operational notes for ongoing maintenance.

## 2) Current Production State

- Runtime target: VPS (Ubuntu 24.04)
- Host: `143.198.161.167`
- App path on server: `/opt/media-downloader`
- Process manager: `systemd`
- Service name: `media-downloader.service`
- Run mode: Telegram polling (`TELEGRAM_USE_WEBHOOK=false`)
- Node runtime: `node v22.x`

## 3) Deployment Modes

### VPS polling mode (current)
- No domain and no TLS required.
- Bot receives updates via long polling.
- Recommended for fastest cutover.

### VPS webhook mode (optional later)
- Requires domain + HTTPS certificate.
- Set `TELEGRAM_USE_WEBHOOK=true` and set `TELEGRAM_WEBHOOK_URL`.
- Configure reverse proxy (Nginx/Caddy) and TLS before enabling.

### Cloudflare Workers mode (legacy)
- Worker entry: `worker/index.ts`
- Wrangler config: `wrangler.jsonc`
- Secrets are managed in Cloudflare and cannot be exported in plaintext via Wrangler.

## 4) Required Environment Variables

Use `.env.production` as template and copy to `.env` on server.

Required keys:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_USE_WEBHOOK`
- `TELEGRAM_WEBHOOK_URL`
- `TELEGRAM_WEBHOOK_PATH`
- `TELEGRAM_WEBHOOK_SECRET_TOKEN`
- `YT_DLP_PATH`
- `INSTALOADER_PATH`
- `GALLERY_DL_PATH`
- `COOKIES_PATH`
- `MAX_DOWNLOADS_PER_USER`
- `RATE_LIMIT_WINDOW_MINUTES`
- `MAX_FILE_SIZE_MB`
- `DOWNLOAD_TIMEOUT_SECONDS`
- `CONCURRENT_DOWNLOADS`
- `AUTO_CLEANUP_MINUTES`
- `LOG_LEVEL`
- `MEDIA_CHAT_ID`
- `BOT_USERNAME`

### Minimal VPS polling `.env`

```env
TELEGRAM_BOT_TOKEN=<YOUR_TOKEN>
TELEGRAM_USE_WEBHOOK=false
TELEGRAM_WEBHOOK_URL=
TELEGRAM_WEBHOOK_PATH=/telegram/webhook
TELEGRAM_WEBHOOK_SECRET_TOKEN=

YT_DLP_PATH=/usr/local/bin/yt-dlp
INSTALOADER_PATH=/usr/local/bin/instaloader
GALLERY_DL_PATH=/usr/local/bin/gallery-dl
COOKIES_PATH=cookies.txt

MAX_DOWNLOADS_PER_USER=20
RATE_LIMIT_WINDOW_MINUTES=60
MAX_FILE_SIZE_MB=50
DOWNLOAD_TIMEOUT_SECONDS=300
CONCURRENT_DOWNLOADS=1
AUTO_CLEANUP_MINUTES=60
LOG_LEVEL=info
MEDIA_CHAT_ID=<YOUR_MEDIA_CHAT_ID>
BOT_USERNAME=<YOUR_BOT_USERNAME>
```

## 5) Initial VPS Provisioning

Run as root:

```bash
apt-get update -y
apt-get install -y ffmpeg python3-pip
python3 -m pip install --break-system-packages yt-dlp gallery-dl instaloader
```

Verify binaries:

```bash
command -v yt-dlp
command -v gallery-dl
command -v instaloader
ffmpeg -version | head -n 2
```

Expected paths:
- `/usr/local/bin/yt-dlp`
- `/usr/local/bin/gallery-dl`
- `/usr/local/bin/instaloader`

## 6) Deploy App to VPS

### Fast deploy (recommended)

Use the new helper scripts from project root:

```bash
# One-time: configure passwordless SSH
npm run setup:vps:ssh

# Fast deploy (build on VPS only, sync + restart)
npm run deploy:vps

# Safer deploy (local build + VPS build)
npm run deploy:vps:safe
```

Optional environment overrides for deploy script:
- `VPS_HOST`
- `VPS_USER`
- `VPS_PORT`
- `VPS_APP_DIR`
- `SERVICE_NAME`
- `SSH_KEY_PATH`

### Sync project from local machine

```bash
rsync -az --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude .wrangler \
  --exclude dist \
  -e "ssh -o StrictHostKeyChecking=no" \
  /Users/chetha/Documents/hobby/media-downloader/ \
  root@143.198.161.167:/opt/media-downloader/
```

### Build and prepare env on server

```bash
cd /opt/media-downloader
npm ci
npm run build
cp -f .env.production .env
# edit /opt/media-downloader/.env with real values
```

## 7) systemd Service Setup

Service file: `/etc/systemd/system/media-downloader.service`

```ini
[Unit]
Description=Media Downloader Telegram Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/media-downloader
Environment=NODE_ENV=production
Environment=PORT=7860
EnvironmentFile=/opt/media-downloader/.env
ExecStart=/usr/bin/node /opt/media-downloader/dist/index.js
Restart=always
RestartSec=5
TimeoutStopSec=15
KillMode=process
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
systemctl daemon-reload
systemctl enable media-downloader.service
systemctl restart media-downloader.service
```

## 8) Day-2 Operations

Status and logs:

```bash
systemctl status media-downloader.service --no-pager -l
journalctl -u media-downloader.service -f
journalctl -u media-downloader.service -n 200 --no-pager
```

Restart after env/code changes:

```bash
cd /opt/media-downloader
npm run build
systemctl restart media-downloader.service
```

To reduce restart wait during deploy (if stop takes too long), apply a systemd override:

```bash
systemctl edit media-downloader.service
```

Add:

```ini
[Service]
TimeoutStopSec=15
KillMode=process
```

Then reload and restart:

```bash
systemctl daemon-reload
systemctl restart media-downloader.service
```

## 9) Switching Modes

### Polling -> Webhook

1. Prepare domain + TLS + reverse proxy.
2. Update `.env`:

```env
TELEGRAM_USE_WEBHOOK=true
TELEGRAM_WEBHOOK_URL=https://<your-domain>/telegram/webhook
TELEGRAM_WEBHOOK_PATH=/telegram/webhook
TELEGRAM_WEBHOOK_SECRET_TOKEN=<optional_secret>
```

3. Restart service:

```bash
systemctl restart media-downloader.service
```

### Webhook -> Polling

```env
TELEGRAM_USE_WEBHOOK=false
TELEGRAM_WEBHOOK_URL=
```

Then restart service.

Note: app code now explicitly removes existing Telegram webhook during polling startup.

## 10) What Changed In This Migration

### Code changes

1. `src/index.ts`
- Added explicit webhook server flow (`startWebhookServer`).
- Added dedicated health server helper (`startHealthServer`).
- Added mode switch: webhook vs polling.
- Added safety call to `deleteWebhook()` before polling startup.

2. `src/config/index.ts`
- Added webhook-related config fields.
- Added env parsing helpers for boolean/path normalization.
- Validation: `TELEGRAM_WEBHOOK_URL` required only when `TELEGRAM_USE_WEBHOOK=true`.
- Bugfix: empty string env values no longer incorrectly trigger missing-value errors for optional/defaulted vars.

3. `.env.example`
- Added webhook env keys.

4. `.env.production`
- Added webhook env keys.
- Added inline mode keys: `MEDIA_CHAT_ID`, `BOT_USERNAME`.

5. `.gitignore`
- Added `.wrangler/` ignore rule.

6. Cloudflare support files
- Added/updated `worker/index.ts` and `wrangler.jsonc` for Worker containerized deployment path (legacy/alternate runtime).

### Infrastructure/runtime changes on VPS

- Installed media toolchain (`ffmpeg`, `yt-dlp`, `gallery-dl`, `instaloader`).
- Deployed app under `/opt/media-downloader`.
- Added persistent service `media-downloader.service`.
- Started bot successfully and validated job processing via `journalctl`.

## 11) Cloudflare Secret Extraction Note

Wrangler can list secret names but cannot export secret plaintext values. If migrating from Cloudflare, secret values must be supplied manually from your own secure source.

## 12) Security Checklist (Important)

1. Rotate Telegram bot token if it was shared in plaintext.
2. Rotate VPS root password if it was shared in plaintext.
3. Prefer SSH keys and disable password login after setup.
4. Keep `.env` server-only (never commit real secrets).
5. Consider creating a non-root deployment user.
6. Configure firewall (allow only required ports).
7. Apply pending server updates and reboot when safe.

## 13) Quick Command Reference

Local:

```bash
npm run build
```

Sync to VPS:

```bash
rsync -az --delete --exclude .git --exclude node_modules --exclude .wrangler --exclude dist -e "ssh -o StrictHostKeyChecking=no" /Users/chetha/Documents/hobby/media-downloader/ root@143.198.161.167:/opt/media-downloader/
```

VPS:

```bash
cd /opt/media-downloader
npm ci
npm run build
systemctl restart media-downloader.service
systemctl status media-downloader.service --no-pager -l
journalctl -u media-downloader.service -f
```

## 14) Rollback Idea (If Needed)

- If VPS deployment fails, you can temporarily return to Cloudflare deployment by re-enabling Wrangler deploy flow and restoring webhook URL config.
- Ensure only one active update mechanism at a time (polling instance vs webhook instance) to avoid Telegram conflicts.
