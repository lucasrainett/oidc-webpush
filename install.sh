#!/usr/bin/env bash
# notify-app · one-line installer for Proxmox VE
#
#   bash -c "$(curl -fsSL https://forge.mgtd.net/lr/notify-app/raw/branch/main/install.sh)"
#
# Creates an unprivileged LXC, installs Node.js, clones the repo, builds the
# TypeScript, generates VAPID keys, writes .env, and starts a systemd service.
#
# All settings can be overridden via env vars for non-interactive use:
#   CTID, HOSTNAME, DISK_GB, RAM_MB, CORES, STORAGE, BRIDGE, VLAN, IPV4, GATEWAY,
#   BASE_URL, OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET,
#   SMTP_AUTH_USER, SMTP_AUTH_PASS, REPO_URL, BRANCH, NODE_MAJOR

set -euo pipefail

# ─── Defaults (override via env) ──────────────────────────────────────────
APP="notify"
REPO_URL="${REPO_URL:-https://forge.mgtd.net/lr/notify-app.git}"
BRANCH="${BRANCH:-main}"
NODE_MAJOR="${NODE_MAJOR:-22}"

CTID="${CTID:-}"
HOSTNAME="${HOSTNAME:-notify}"
DISK_GB="${DISK_GB:-4}"
RAM_MB="${RAM_MB:-512}"
CORES="${CORES:-1}"
STORAGE="${STORAGE:-local-lvm}"
BRIDGE="${BRIDGE:-vmbr0}"
VLAN="${VLAN:-30}"            # Published VLAN per LR's network plan
IPV4="${IPV4:-dhcp}"
GATEWAY="${GATEWAY:-}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"

BASE_URL="${BASE_URL:-}"
OIDC_ISSUER="${OIDC_ISSUER:-}"
OIDC_CLIENT_ID="${OIDC_CLIENT_ID:-}"
OIDC_CLIENT_SECRET="${OIDC_CLIENT_SECRET:-}"
SMTP_AUTH_USER="${SMTP_AUTH_USER:-}"
SMTP_AUTH_PASS="${SMTP_AUTH_PASS:-}"

NONINTERACTIVE="${NONINTERACTIVE:-0}"

# ─── UI ───────────────────────────────────────────────────────────────────
BLU=$'\033[0;34m'; GRN=$'\033[0;32m'; YLW=$'\033[1;33m'; RED=$'\033[0;31m'; DIM=$'\033[2m'; NC=$'\033[0m'

banner() {
  cat <<EOF

${YLW}  ┌──────────────────────────────────┐
  │  ${NC}notify · install${YLW}                  │
  │  ${DIM}email → push · sso · open src${NC}${YLW}    │
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
  [[ "$NONINTERACTIVE" == "1" ]] && { echo ""; return; }
  local v; read -rsp "  $1: " v; echo >&2; echo "$v"
}

# ─── Preflight ────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "must run as root on the Proxmox host"
command -v pveversion >/dev/null 2>&1 || die "not a Proxmox VE host"
command -v pct >/dev/null 2>&1 || die "pct not found"

banner

# ─── Gather config ────────────────────────────────────────────────────────
[[ -z "$CTID" ]] && CTID=$(pvesh get /cluster/nextid)
msg "container ID: $CTID"

pvesm status -storage "$STORAGE" >/dev/null 2>&1 || die "storage '$STORAGE' not found"

echo
msg "container settings"
HOSTNAME=$(ask "hostname" "$HOSTNAME")
DISK_GB=$(ask "disk GB" "$DISK_GB")
RAM_MB=$(ask "memory MB" "$RAM_MB")
CORES=$(ask "cores" "$CORES")

echo
msg "network"
BRIDGE=$(ask "bridge" "$BRIDGE")
VLAN=$(ask "VLAN tag (blank for none)" "$VLAN")
IPV4=$(ask "ipv4 (CIDR or 'dhcp')" "$IPV4")
if [[ "$IPV4" != "dhcp" ]]; then
  GATEWAY=$(ask "gateway" "$GATEWAY")
fi

echo
msg "application"
BASE_URL=$(ask "public base URL" "${BASE_URL:-https://notify.mgtd.net}")
OIDC_ISSUER=$(ask "authentik issuer URL" "${OIDC_ISSUER:-https://authentik.mgtd.net/application/o/notify/}")
OIDC_CLIENT_ID=$(ask "OIDC client id" "$OIDC_CLIENT_ID")
[[ -z "$OIDC_CLIENT_SECRET" ]] && OIDC_CLIENT_SECRET=$(ask_secret "OIDC client secret")
[[ -z "$OIDC_CLIENT_SECRET" ]] && die "OIDC client secret is required"

echo
msg "SMTP ingress (optional auth, recommended if reachable from outside trusted networks)"
SMTP_AUTH_USER=$(ask "SMTP auth user (blank = no auth)" "$SMTP_AUTH_USER")
if [[ -n "$SMTP_AUTH_USER" && -z "$SMTP_AUTH_PASS" ]]; then
  SMTP_AUTH_PASS=$(ask_secret "SMTP auth password")
fi

ROOT_PASS=$(openssl rand -base64 24)

# ─── Template ─────────────────────────────────────────────────────────────
msg "checking debian 12 template"
TEMPLATE_FILE=$(pveam available --section system 2>/dev/null | awk '/debian-12-standard/{print $2}' | sort -V | tail -1)
[[ -n "$TEMPLATE_FILE" ]] || die "no debian-12-standard template available"
if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE_FILE"; then
  msg "downloading $TEMPLATE_FILE"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE_FILE"
fi

# ─── Create LXC ───────────────────────────────────────────────────────────
msg "creating LXC $CTID ($HOSTNAME)"
NET="name=eth0,bridge=$BRIDGE,firewall=1"
[[ -n "$VLAN" ]] && NET="$NET,tag=$VLAN"
if [[ "$IPV4" == "dhcp" ]]; then
  NET="$NET,ip=dhcp"
else
  NET="$NET,ip=$IPV4"
  [[ -n "$GATEWAY" ]] && NET="$NET,gw=$GATEWAY"
fi

pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE_FILE" \
  --hostname "$HOSTNAME" \
  --cores "$CORES" \
  --memory "$RAM_MB" \
  --rootfs "$STORAGE:$DISK_GB" \
  --net0 "$NET" \
  --features "nesting=1" \
  --unprivileged 1 \
  --onboot 1 \
  --password "$ROOT_PASS" \
  --description "notify · self-hosted push notification service · $(date -I)" \
  >/dev/null

pct set "$CTID" --startup order=3
ok "container created"

msg "starting container"
pct start "$CTID"

msg "waiting for network"
for i in {1..30}; do
  if pct exec "$CTID" -- ping -c1 -W1 1.1.1.1 >/dev/null 2>&1; then break; fi
  sleep 1
done
pct exec "$CTID" -- ping -c1 -W1 1.1.1.1 >/dev/null 2>&1 || die "container has no network"
ok "network up"

# ─── Provision inside container ───────────────────────────────────────────
msg "installing dependencies (this takes a few minutes)"
pct exec "$CTID" -- bash -euo pipefail <<EOSH
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git build-essential python3 >/dev/null
curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - >/dev/null 2>&1
apt-get install -y -qq nodejs >/dev/null

id notify >/dev/null 2>&1 || useradd --system --home /opt/notify --shell /usr/sbin/nologin notify
mkdir -p /opt/notify
chown notify:notify /opt/notify
EOSH

msg "cloning $REPO_URL ($BRANCH)"
pct exec "$CTID" -- runuser -u notify -- git clone --depth 1 --branch "$BRANCH" "$REPO_URL" /opt/notify

msg "installing npm deps & building"
pct exec "$CTID" -- bash -c "cd /opt/notify && runuser -u notify -- npm ci --silent --no-audit --no-fund"
pct exec "$CTID" -- bash -c "cd /opt/notify && runuser -u notify -- npm run build --silent"
pct exec "$CTID" -- bash -c "mkdir -p /opt/notify/data && chown notify:notify /opt/notify/data"

# ─── VAPID keys ───────────────────────────────────────────────────────────
msg "generating VAPID keypair"
VAPID_OUT=$(pct exec "$CTID" -- bash -c "cd /opt/notify && node -e \"const w=require('web-push');const k=w.generateVAPIDKeys();process.stdout.write(k.publicKey+'|'+k.privateKey)\"")
VAPID_PUBLIC="${VAPID_OUT%|*}"
VAPID_PRIVATE="${VAPID_OUT#*|}"
COOKIE_SECRET=$(openssl rand -hex 32)
DOMAIN=$(echo "$BASE_URL" | sed -E 's|^https?://||; s|/.*$||')

# ─── .env ─────────────────────────────────────────────────────────────────
msg "writing /opt/notify/.env"
ENV_CONTENT="BASE_URL=$BASE_URL
PORT=3000
HOST=0.0.0.0
SMTP_PORT=2525
SMTP_HOST=0.0.0.0
OIDC_ISSUER=$OIDC_ISSUER
OIDC_CLIENT_ID=$OIDC_CLIENT_ID
OIDC_CLIENT_SECRET=$OIDC_CLIENT_SECRET
VAPID_PUBLIC=$VAPID_PUBLIC
VAPID_PRIVATE=$VAPID_PRIVATE
VAPID_SUBJECT=mailto:admin@$DOMAIN
COOKIE_SECRET=$COOKIE_SECRET
DB_PATH=/opt/notify/data/notify.db"
if [[ -n "$SMTP_AUTH_USER" ]]; then
  ENV_CONTENT="$ENV_CONTENT
SMTP_AUTH_USER=$SMTP_AUTH_USER
SMTP_AUTH_PASS=$SMTP_AUTH_PASS"
fi
pct exec "$CTID" -- bash -c "umask 077; cat > /opt/notify/.env" <<< "$ENV_CONTENT"
pct exec "$CTID" -- chown notify:notify /opt/notify/.env

# ─── systemd unit ─────────────────────────────────────────────────────────
msg "installing systemd unit"
pct exec "$CTID" -- bash -c 'cat > /etc/systemd/system/notify.service' <<'EOF'
[Unit]
Description=notify-app (email-to-push notification service)
Documentation=https://forge.mgtd.net/lr/notify-app
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=notify
Group=notify
WorkingDirectory=/opt/notify
EnvironmentFile=/opt/notify/.env
ExecStart=/usr/bin/node /opt/notify/dist/app.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

# hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/opt/notify/data
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
LockPersonality=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
EOF

pct exec "$CTID" -- systemctl daemon-reload
pct exec "$CTID" -- systemctl enable --now notify.service >/dev/null

sleep 3
if pct exec "$CTID" -- systemctl is-active --quiet notify.service; then
  ok "notify.service is running"
else
  warn "service did not start cleanly · pct exec $CTID -- journalctl -u notify -n 50"
fi

# ─── Summary ──────────────────────────────────────────────────────────────
CT_IP=$(pct exec "$CTID" -- hostname -I | awk '{print $1}')

cat <<EOF

${GRN}✓ installation complete${NC}

  ${DIM}container${NC}     CTID=$CTID   ip=$CT_IP   vlan=${VLAN:-none}
  ${DIM}http${NC}          http://$CT_IP:3000
  ${DIM}smtp${NC}          $CT_IP:2525
  ${DIM}root pass${NC}     $ROOT_PASS  ${YLW}(save in Proton Pass)${NC}
  ${DIM}cookie secret${NC} ${COOKIE_SECRET:0:8}…  ${YLW}(in .env — back up too)${NC}
  ${DIM}VAPID public${NC}  ${VAPID_PUBLIC:0:32}…

  ${BLU}next steps${NC}
    1. Traefik route:  $BASE_URL → http://$CT_IP:3000  (forwardAuth optional)
    2. Authentik OIDC client redirect URI:  $BASE_URL/auth/callback
    3. Point your apps' SMTP settings at $CT_IP:2525 (or notify.mgtd.net:2525 via Traefik)
    4. Sign in, then click "enable on this device"

  ${BLU}operations${NC}
    logs:   pct exec $CTID -- journalctl -u notify -f
    shell:  pct enter $CTID
    update: pct exec $CTID -- bash -c 'cd /opt/notify && git pull && npm ci && npm run build && systemctl restart notify'

EOF
