#!/usr/bin/env bash
#
# Yale IT Skill Hub – GBP Competitor Scraper
# One-shot deploy / update script for a Debian/Ubuntu Hostinger VPS.
#
# Run as root:   bash deploy.sh
# Re-run anytime to pull latest code and restart the service (idempotent).
#
set -euo pipefail

APP_DIR="/opt/gbp-scraper"
REPO_URL="https://github.com/sachu-sachin/gbp-scraper.git"
SERVICE="gbp-scraper"
PORT="3005"   # 3000/3001 are used by the CRM Next.js apps on this VPS
# Secret token n8n must send (x-api-key header). REQUIRED — export before running:
#   API_KEY=your-secret bash deploy.sh
# Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
API_KEY="${API_KEY:-}"
if [ -z "$API_KEY" ]; then
  echo "ERROR: API_KEY env var is required. Export it before running deploy.sh." >&2
  exit 1
fi

echo "==> 1/6  Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates gnupg

echo "==> 2/6  Installing Node.js 20 LTS (if missing)"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> 3/6  Installing Google Chrome (Puppeteer needs a real browser)"
if ! command -v google-chrome >/dev/null 2>&1; then
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -y
  apt-get install -y google-chrome-stable
fi
google-chrome --version

echo "==> 4/6  Fetching application code"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
npm install --omit=dev

echo "==> 5/6  Installing systemd service"
cat > /etc/systemd/system/${SERVICE}.service <<EOF
[Unit]
Description=Yale IT GBP Competitor Scraper
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node ${APP_DIR}/server.js
Restart=on-failure
RestartSec=5
Environment=PORT=${PORT}
Environment=NODE_ENV=production
Environment=CHROME_PATH=/usr/bin/google-chrome
Environment=API_KEY=${API_KEY}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ${SERVICE}
systemctl restart ${SERVICE}

echo "==> 6/6  Health check"
sleep 3
curl -fsS "http://127.0.0.1:${PORT}/health" && echo
echo
echo "Done. Service status:"
systemctl --no-pager status ${SERVICE} | head -n 8
