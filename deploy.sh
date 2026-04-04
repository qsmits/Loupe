#!/usr/bin/env bash
# Deploy local source to loupe.maindynamics.com
# Usage: ./deploy.sh
# Requirements: SSH key for quinny@loupe.maindynamics.com in your ssh-agent or ~/.ssh/id_rsa

set -euo pipefail

REMOTE_USER=quinny
REMOTE_HOST=loupe.maindynamics.com
REMOTE_DEST=/var/www/loupe.maindynamics.com
TMP_DIR=/tmp/loupe-deploy-$$
SSH_OPTS="-o StrictHostKeyChecking=no -o CheckHostIP=no -o ConnectTimeout=15"

echo "==> Syncing to ${REMOTE_HOST}:${TMP_DIR} ..."
rsync -az --checksum \
  -e "ssh ${SSH_OPTS}" \
  --exclude='.venv' \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  --exclude='config.json' \
  --exclude='data/' \
  --exclude='tests/' \
  --exclude='docs/' \
  --exclude='snapshots/' \
  --exclude='*.pid' \
  --exclude='.git' \
  --exclude='.claude' \
  --exclude='.superpowers' \
  --exclude='.vexp' \
  --exclude='.worktrees' \
  --exclude='.pytest_cache' \
  --exclude='.DS_Store' \
  --exclude='deploy/' \
  --exclude='poc_*' \
  --exclude='hardware/' \
  --exclude='*.dxf' \
  --exclude='*.docx' \
  ./ "${REMOTE_USER}@${REMOTE_HOST}:${TMP_DIR}/"

echo "==> Installing on server ..."
# shellcheck disable=SC2087
ssh ${SSH_OPTS} "${REMOTE_USER}@${REMOTE_HOST}" bash <<EOF
  set -e
  sudo rsync -a --exclude='__pycache__' --exclude='*.pyc' ${TMP_DIR}/backend/  ${REMOTE_DEST}/backend/
  sudo rsync -a                                            ${TMP_DIR}/frontend/ ${REMOTE_DEST}/frontend/
  sudo chown -R www-data:www-data ${REMOTE_DEST}/backend ${REMOTE_DEST}/frontend
  rm -rf ${TMP_DIR}
  sudo systemctl restart loupe
  sleep 2
  systemctl is-active loupe
EOF

echo "==> Done. https://${REMOTE_HOST} is live."
