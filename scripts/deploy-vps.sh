#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

VPS_HOST="${VPS_HOST:-143.198.161.167}"
VPS_USER="${VPS_USER:-root}"
VPS_PORT="${VPS_PORT:-22}"
VPS_APP_DIR="${VPS_APP_DIR:-/opt/media-downloader}"
SERVICE_NAME="${SERVICE_NAME:-media-downloader.service}"
SSH_KEY_PATH="${SSH_KEY_PATH:-}"

LOCAL_BUILD=0
REMOTE_BUILD=1
INSTALL_DEPS=0

usage() {
  cat <<'EOF'
Usage: bash scripts/deploy-vps.sh [options]

Options:
  --local-build       Run local npm build before sync
  --no-remote-build   Skip npm build on VPS
  --install-deps      Run npm ci on VPS before build
  -h, --help          Show this help

Environment overrides:
  VPS_HOST, VPS_USER, VPS_PORT, VPS_APP_DIR, SERVICE_NAME, SSH_KEY_PATH
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local-build)
      LOCAL_BUILD=1
      shift
      ;;
    --no-remote-build)
      REMOTE_BUILD=0
      shift
      ;;
    --install-deps)
      INSTALL_DEPS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ "$LOCAL_BUILD" -eq 0 && "$REMOTE_BUILD" -eq 0 ]]; then
  echo "Error: both local and remote builds are disabled."
  exit 1
fi

REMOTE="${VPS_USER}@${VPS_HOST}"
SSH_BASE_ARGS=(-p "$VPS_PORT" -o StrictHostKeyChecking=no)
if [[ -n "$SSH_KEY_PATH" ]]; then
  SSH_BASE_ARGS+=(-i "$SSH_KEY_PATH")
fi

RSYNC_SSH="ssh ${SSH_BASE_ARGS[*]}"
START_TS="$(date +%s)"

echo "==> Deploy target: ${REMOTE}:${VPS_APP_DIR}"

if [[ "$LOCAL_BUILD" -eq 1 ]]; then
  echo "==> Local build"
  (cd "$PROJECT_ROOT" && npm run build)
fi

echo "==> Sync files"
rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.wrangler' \
  --exclude '.env' \
  --exclude '.env.local' \
  --exclude '.DS_Store' \
  -e "$RSYNC_SSH" \
  "${PROJECT_ROOT}/" \
  "${REMOTE}:${VPS_APP_DIR}/"

echo "==> Remote build/restart"
REMOTE_SCRIPT="$(cat <<EOF
set -euo pipefail
cd "$VPS_APP_DIR"

if [[ "$INSTALL_DEPS" == "1" ]]; then
  npm ci
fi

if [[ "$REMOTE_BUILD" == "1" ]]; then
  npm run build
fi

systemctl restart "$SERVICE_NAME"
systemctl is-active "$SERVICE_NAME"
EOF
)"

ssh "${SSH_BASE_ARGS[@]}" "$REMOTE" "$REMOTE_SCRIPT"

END_TS="$(date +%s)"
echo "==> Deploy completed in $((END_TS - START_TS))s"
