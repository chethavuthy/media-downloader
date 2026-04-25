#!/usr/bin/env bash
set -euo pipefail

VPS_HOST="${VPS_HOST:-143.198.161.167}"
VPS_USER="${VPS_USER:-root}"
VPS_PORT="${VPS_PORT:-22}"
SSH_KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/id_ed25519_media_downloader}"

usage() {
  cat <<'EOF'
Usage: bash scripts/setup-vps-ssh-key.sh

Creates an SSH key (if needed), installs it on VPS, and verifies passwordless login.
Environment overrides: VPS_HOST, VPS_USER, VPS_PORT, SSH_KEY_PATH
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ ! -f "$SSH_KEY_PATH" ]]; then
  echo "==> Creating SSH key: $SSH_KEY_PATH"
  mkdir -p "$(dirname "$SSH_KEY_PATH")"
  ssh-keygen -t ed25519 -f "$SSH_KEY_PATH" -N "" -C "media-downloader-vps"
else
  echo "==> Reusing existing SSH key: $SSH_KEY_PATH"
fi

if command -v ssh-copy-id >/dev/null 2>&1; then
  echo "==> Installing key on VPS with ssh-copy-id"
  ssh-copy-id -i "${SSH_KEY_PATH}.pub" -p "$VPS_PORT" -o StrictHostKeyChecking=no "${VPS_USER}@${VPS_HOST}"
else
  echo "ssh-copy-id not found. Install manually:"
  echo "  cat ${SSH_KEY_PATH}.pub | ssh -p ${VPS_PORT} ${VPS_USER}@${VPS_HOST} 'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys'"
  exit 1
fi

echo "==> Verifying passwordless SSH"
ssh -i "$SSH_KEY_PATH" -p "$VPS_PORT" -o BatchMode=yes -o StrictHostKeyChecking=no "${VPS_USER}@${VPS_HOST}" "echo ok"
echo "==> SSH key setup complete"
echo "Tip: export SSH_KEY_PATH=${SSH_KEY_PATH} before running deploy script."
