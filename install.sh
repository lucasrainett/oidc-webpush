#!/usr/bin/env bash
# oidc-webpush · one-line installer for generic Linux
#
#   bash -c "$(curl -fsSL https://example.com/install.sh)"
#
# Installs Node.js 24 LTS, pnpm, clones the repo, builds the TypeScript,
# generates VAPID keys, writes .env, and starts a systemd service.
#
# For update mode, simply run the same command again. It will pull latest,
# rebuild, run DB migrations, and restart.
#
# All settings can be overridden via env vars for non-interactive use:
#   BASE_URL, OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET,
#   ADMIN_EMAILS, OLLAMA_URL, AI_FILTER_DEFAULT,
#   REPO_URL, BRANCH, NODE_MAJOR, INSTALL_DIR

set -euo pipefail

# ─── Defaults (override via env) ──────────────────────────────────────────
APP="oidc-webpush"
REPO_URL="${REPO_URL:-https://github.com/lucasrainett/oidc-webpush.git}"
BRANCH="${BRANCH:-master}"
NODE_MAJOR="${NODE_MAJOR:-24}"
INSTALL_DIR="${INSTALL_DIR:-/opt/oidc-webpush}"

BASE_URL="${BASE_URL:-}"
OIDC_ISSUER="${OIDC_ISSUER:-}"
OIDC_CLIENT_ID="${OIDC_CLIENT_ID:-}"
OIDC_CLIENT_SECRET="${OIDC_CLIENT_SECRET:-}"
ADMIN_EMAILS="${ADMIN_EMAILS:-}"
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
AI_FILTER_DEFAULT="${AI_FILTER_DEFAULT:-true}"

NONINTERACTIVE="${NONINTERACTIVE:-0}"

# ─── UI ───────────────────────────────────────────────────────────────────
BLU=$'\033[0;34m'; GRN=$'\033[0;32m'; YLW=$'\033[1;33m'; RED=$'\033[0;31m'; DIM=$'\033[2m'; NC=$'\033[0m'

banner() {
  cat <<EOF

${YLW}  ┌──────────────────────────────────┐
  │  ${NC}oidc-webpush · install${YLW}          │
  │  ${DIM}email → push · sso · open source${NC}${YLW}│
  └──────────────────────────────────┘${NC}

EOF
}
msg()   { printf "${BLU}▸${NC} %s\n" "$*"; }
ok()    { printf "${GRN}✓${NC} %s\n" "$*"; }
warn()  { printf "${YLW}!${NC} %s\n" "$*"; }
die()   { printf "${RED}✗${NC} %s\n" "$*" >&2; exit 1; }
ask()   {
  [[ "$NONINTERACTIVE" == "1" ]] && { echo "${2:-}"; return; }
  local v
  if [[ -n "${2:-}" ]]; then read -rp "  $1 [${2}]: " v; echo "${v:-$2}"
  else read -rp "  $1: " v; echo "$v"; fi
}
ask_secret() {
  [[ "$NONINTERACTIVE" == "1" ]] && { echo "${2:-}"; return; }
  local v; read -rsp "  $1: " v; echo >&2; echo "$v"
}

# ─── Preflight ────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "must run as root"
command -v systemctl >/dev/null 2>&1 || die "systemd required"

banner

# ─── Install Node.js & pnpm ───────────────────────────────────────────────
msg "installing Node.js $NODE_MAJOR LTS..."
if command -v apt-get >/dev/null 2>&1; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs python3 build-essential git
elif command -v dnf >/dev/null 2>&1; then
  dnf module reset nodejs -y
  dnf module enable "nodejs:$NODE_MAJOR" -y
  dnf install -y nodejs gcc-c++ make python3 git
elif command -v pacman >/dev/null 2>&1; then
  pacman -S --noconfirm nodejs npm git
else
  die "unsupported package manager; install Node $NODE_MAJOR manually"
fi

msg "installing pnpm..."
curl -fsSL https://get.pnpm.io/install.sh | env PNPM_HOME=/usr/local/share/pnpm sh -
export PATH="/usr/local/share/pnpm/bin:$PATH"

# ─── Detect existing install ──────────────────────────────────────────────
if [[ -f "$INSTALL_DIR/.env" ]]; then
  msg "existing installation found at $INSTALL_DIR"
  msg "entering update mode..."
  cd "$INSTALL_DIR"
  if ! git diff --quiet; then
    warn "local changes detected; stashing before pull"
    git stash
  fi
  git pull origin "$BRANCH"
  msg "installing dependencies..."
  pnpm install --frozen-lockfile
  msg "building..."
  pnpm run build
  msg "running database migrations..."
  node dist/db.js || true
  msg "restarting service..."
  systemctl restart "$APP"
  ok "updated successfully"
  exit 0
fi

# ─── Clone & build ────────────────────────────────────────────────────────
msg "cloning repo..."
git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
cd "$INSTALL_DIR"
pnpm install --frozen-lockfile
pnpm run build

# ─── Gather config ────────────────────────────────────────────────────────
echo
msg "configuration"
BASE_URL=$(ask "public base URL (e.g. https://notify.example.com)" "$BASE_URL")
OIDC_ISSUER=$(ask "OIDC issuer URL" "$OIDC_ISSUER")
OIDC_CLIENT_ID=$(ask "OIDC client id" "$OIDC_CLIENT_ID")
OIDC_CLIENT_SECRET=$(ask_secret "OIDC client secret" "$OIDC_CLIENT_SECRET")
ADMIN_EMAILS=$(ask "admin email(s), comma-separated" "$ADMIN_EMAILS")
OLLAMA_URL=$(ask "Ollama URL (blank to skip AI)" "$OLLAMA_URL")
if [[ -n "$OLLAMA_URL" ]]; then
  AI_FILTER_DEFAULT=$(ask "enable AI filtering by default for new users? [Y/n]" "${AI_FILTER_DEFAULT:-Y}")
fi

COOKIE_SECRET=$(openssl rand -hex 32)

# ─── VAPID keys ───────────────────────────────────────────────────────────
msg "generating VAPID keys..."
VAPID_OUT=$(node -e "const w=require('web-push');const k=w.generateVAPIDKeys();console.log(k.publicKey+'\\n'+k.privateKey)")
VAPID_PUBLIC=$(echo "$VAPID_OUT" | head -n1)
VAPID_PRIVATE=$(echo "$VAPID_OUT" | tail -n1)

warn "=== SAVE THESE KEYS ==="
warn "VAPID_PUBLIC=$VAPID_PUBLIC"
warn "VAPID_PRIVATE=$VAPID_PRIVATE"
warn "They have been written to $INSTALL_DIR/.env"
warn "======================="

# ─── Write .env ───────────────────────────────────────────────────────────
cat > "$INSTALL_DIR/.env" <<EOF
BASE_URL=$BASE_URL
PORT=3000
HOST=0.0.0.0
SMTP_PORT=2525
SMTP_HOST=0.0.0.0
OIDC_ISSUER=$OIDC_ISSUER
OIDC_CLIENT_ID=$OIDC_CLIENT_ID
OIDC_CLIENT_SECRET=$OIDC_CLIENT_SECRET
VAPID_PUBLIC=$VAPID_PUBLIC
VAPID_PRIVATE=$VAPID_PRIVATE
VAPID_SUBJECT=mailto:admin@localhost
COOKIE_SECRET=$COOKIE_SECRET
DB_PATH=./data/oidc-webpush.db
ADMIN_EMAILS=$ADMIN_EMAILS
OLLAMA_URL=$OLLAMA_URL
OLLAMA_MODEL=llama3.2:3b
OLLAMA_TIMEOUT_MS=5000
OLLAMA_MAX_CONCURRENCY=2
OLLAMA_QUEUE_TIMEOUT_MS=120000
AI_BYPASS_PATTERNS=2fa|verification|otp|alert
AI_SKIP_PATTERNS=password|reset|credit card
AI_FILTER_DEFAULT=$AI_FILTER_DEFAULT
LOG_LEVEL=info
EOF
chmod 600 "$INSTALL_DIR/.env"

# ─── Create systemd unit ──────────────────────────────────────────────────
cat > "/etc/systemd/system/${APP}.service" <<EOF
[Unit]
Description=oidc-webpush
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_DIR/.env
ExecStart=/usr/local/share/pnpm/bin/pnpm start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$APP"

ok "installed and running"
msg "service status: systemctl status $APP"
msg "logs: journalctl -u $APP -f"
