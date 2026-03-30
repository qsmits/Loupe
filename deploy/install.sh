#!/usr/bin/env bash
# First-time installation of Loupe on an Ubuntu server.
# Run as a user with sudo privileges (NOT as root).
#
# Usage: ./deploy/install.sh [domain]
#   domain: the subdomain where Loupe will be hosted (e.g., loupe.example.com)
#
# What this does:
#   1. Installs system dependencies (Python 3.11+, supervisor)
#   2. Creates a Python venv and installs pip dependencies
#   3. Creates config.json for hosted mode
#   4. Installs supervisord config
#   5. Installs Apache reverse proxy config (you add the cert yourself)
#   6. Starts the service
#
# After running this script:
#   - Add SSL cert: sudo certbot --apache -d your-domain.com
#   - Verify: curl https://your-domain.com

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────
DOMAIN="${1:-}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENV_DIR="$APP_DIR/.venv"
USER="$(whoami)"
PORT=8000
MAX_SESSIONS=50
SESSION_TTL=600

if [[ -z "$DOMAIN" ]]; then
    echo "Usage: $0 <domain>"
    echo "  e.g.: $0 loupe.example.com"
    exit 1
fi

echo "=== Loupe Installation ==="
echo "App directory: $APP_DIR"
echo "Domain:        $DOMAIN"
echo "User:          $USER"
echo "Port:          $PORT"
echo ""

# ── System dependencies ────────────────────────────────────────────────────
echo "→ Installing system packages..."
sudo apt-get update -qq
sudo apt-get install -y -qq python3 python3-venv python3-pip supervisor apache2 libapache2-mod-proxy-html > /dev/null

# Enable Apache modules for reverse proxy
sudo a2enmod proxy proxy_http proxy_wstunnel headers rewrite > /dev/null 2>&1 || true

# ── Python venv ────────────────────────────────────────────────────────────
echo "→ Creating Python virtual environment..."
python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

# ── Config file ────────────────────────────────────────────────────────────
CONFIG="$APP_DIR/config.json"
if [[ ! -f "$CONFIG" ]]; then
    echo "→ Creating config.json for hosted mode..."
    cat > "$CONFIG" <<CONF
{
  "version": 1,
  "hosted": true,
  "no_camera": true,
  "app_name": "Loupe",
  "theme": "macos-dark",
  "tolerance_warn": 0.10,
  "tolerance_fail": 0.25,
  "subpixel_method": "parabola",
  "max_sessions": $MAX_SESSIONS,
  "session_ttl": $SESSION_TTL
}
CONF
else
    echo "→ config.json already exists, skipping"
fi

# ── Supervisord config ─────────────────────────────────────────────────────
echo "→ Installing supervisord config..."
SUPERVISOR_CONF="/etc/supervisor/conf.d/loupe.conf"
sudo tee "$SUPERVISOR_CONF" > /dev/null <<SUPER
[program:loupe]
command=${VENV_DIR}/bin/uvicorn backend.main:app --host 127.0.0.1 --port ${PORT} --timeout-graceful-shutdown 3
directory=${APP_DIR}
user=${USER}
environment=CORS_ORIGINS="https://${DOMAIN}",HOSTED="1",NO_CAMERA="1"
autostart=true
autorestart=true
startsecs=5
startretries=3
stdout_logfile=/var/log/loupe/app.log
stderr_logfile=/var/log/loupe/error.log
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=3
stderr_logfile_maxbytes=10MB
stderr_logfile_backups=3
SUPER

# Create log directory
sudo mkdir -p /var/log/loupe
sudo chown "$USER:$USER" /var/log/loupe

# ── Apache config ──────────────────────────────────────────────────────────
echo "→ Installing Apache reverse proxy config..."
APACHE_CONF="/etc/apache2/sites-available/loupe.conf"
sudo tee "$APACHE_CONF" > /dev/null <<APACHE
<VirtualHost *:80>
    ServerName ${DOMAIN}

    # Certbot will add the redirect to HTTPS here.
    # After running: sudo certbot --apache -d ${DOMAIN}

    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:${PORT}/
    ProxyPassReverse / http://127.0.0.1:${PORT}/

    # MJPEG streaming needs long timeouts (not used in hosted/no-camera mode,
    # but safe to set in case camera mode is ever enabled)
    ProxyTimeout 300

    # Security headers
    Header always set X-Content-Type-Options "nosniff"
    Header always set X-Frame-Options "DENY"
    Header always set Referrer-Policy "strict-origin-when-cross-origin"

    # Upload size limit (matches backend's 20MB limit)
    LimitRequestBody 20971520

    ErrorLog \${APACHE_LOG_DIR}/loupe-error.log
    CustomLog \${APACHE_LOG_DIR}/loupe-access.log combined
</VirtualHost>
APACHE

sudo a2ensite loupe > /dev/null 2>&1 || true

# ── Start everything ───────────────────────────────────────────────────────
echo "→ Starting services..."
sudo supervisorctl reread > /dev/null
sudo supervisorctl update > /dev/null
sudo supervisorctl start loupe 2>/dev/null || sudo supervisorctl restart loupe
sudo systemctl reload apache2

echo ""
echo "=== Installation complete ==="
echo ""
echo "Loupe is running at http://${DOMAIN} (port ${PORT})"
echo ""
echo "Next steps:"
echo "  1. Add SSL certificate:"
echo "     sudo certbot --apache -d ${DOMAIN}"
echo ""
echo "  2. Verify it works:"
echo "     curl -I https://${DOMAIN}"
echo ""
echo "  3. To update later:"
echo "     ./deploy/update.sh"
echo ""
echo "Logs:  /var/log/loupe/app.log"
echo "Config: ${CONFIG}"
echo "Status: sudo supervisorctl status loupe"
