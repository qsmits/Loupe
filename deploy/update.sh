#!/usr/bin/env bash
# Update Loupe to the latest version.
# Run from anywhere — detects the app directory automatically.
#
# Usage: ./deploy/update.sh
#
# What this does:
#   1. Pulls latest code from git
#   2. Updates Python dependencies
#   3. Runs tests (optional, skipped if pytest not installed)
#   4. Restarts the service

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENV_DIR="$APP_DIR/.venv"

echo "=== Loupe Update ==="
echo "App directory: $APP_DIR"
echo ""

# ── Pull latest code ───────────────────────────────────────────────────────
echo "→ Pulling latest code..."
cd "$APP_DIR"
git fetch --quiet
BEFORE=$(git rev-parse HEAD)
git pull --quiet
AFTER=$(git rev-parse HEAD)

if [[ "$BEFORE" == "$AFTER" ]]; then
    echo "  Already up to date ($(git rev-parse --short HEAD))"
else
    echo "  Updated: $(git rev-parse --short "$BEFORE") → $(git rev-parse --short "$AFTER")"
    echo "  Changes:"
    git log --oneline "$BEFORE".."$AFTER" | sed 's/^/    /'
fi

# ── Update dependencies ────────────────────────────────────────────────────
echo "→ Updating Python dependencies..."
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

# ── Run tests (if available) ──────────────────────────────────────────────
if "$VENV_DIR/bin/python" -c "import pytest" 2>/dev/null; then
    echo "→ Running backend tests..."
    if "$VENV_DIR/bin/pytest" tests/ -q --tb=short 2>&1 | tail -5; then
        echo "  Tests passed"
    else
        echo ""
        echo "⚠ Some tests failed. Service will still restart."
        echo "  Review output above and check /var/log/loupe/error.log"
    fi
fi

# ── Restart service ────────────────────────────────────────────────────────
echo "→ Restarting Loupe..."
sudo supervisorctl restart loupe

# Wait for startup
sleep 2
STATUS=$(sudo supervisorctl status loupe 2>/dev/null | awk '{print $2}')
if [[ "$STATUS" == "RUNNING" ]]; then
    echo "  ✓ Service is running"
else
    echo "  ✗ Service status: $STATUS"
    echo "  Check logs: tail -50 /var/log/loupe/error.log"
    exit 1
fi

echo ""
echo "=== Update complete ==="
echo "Version: $(git rev-parse --short HEAD) ($(git log -1 --format='%s'))"
