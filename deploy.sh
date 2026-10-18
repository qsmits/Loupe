#!/usr/bin/env bash
# Deploy to loupe.maindynamics.com
#
# Usage: ./deploy.sh                 # deploy the committed HEAD (default)
#        ./deploy.sh --working-tree  # deploy the local working tree, uncommitted changes included
#
# The default exports HEAD with `git archive`, so uncommitted work in the tree
# never reaches the server by accident. The server-side step syncs backend/,
# frontend/, reticles/ and requirements.txt, installs the requirements into the
# app's venv (no-op when nothing changed), writes DEPLOYED_REVISION and
# restarts the service.
#
# Requirements: SSH key for quinny@loupe.maindynamics.com in your ssh-agent or ~/.ssh/id_rsa

set -euo pipefail

REMOTE_USER=quinny
REMOTE_HOST=loupe.maindynamics.com
REMOTE_DEST=/var/www/loupe.maindynamics.com
TMP_DIR=/tmp/loupe-deploy-$$
SSH_OPTS="-o StrictHostKeyChecking=no -o CheckHostIP=no -o ConnectTimeout=15"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE=head
case "${1:-}" in
  "") ;;
  --working-tree) MODE=tree ;;
  *) echo "Usage: $0 [--working-tree]" >&2; exit 1 ;;
esac

HEAD_REV="$(git -C "${REPO_DIR}" rev-parse HEAD)"
if [[ "${MODE}" == head ]]; then
  if [[ -n "$(git -C "${REPO_DIR}" status --porcelain --untracked-files=no)" ]]; then
    echo "note: the working tree has uncommitted changes; deploying committed HEAD ${HEAD_REV:0:7} only" \
         "(use --working-tree to include them)"
  fi
  REVISION="${HEAD_REV}"
  SRC_DIR="$(mktemp -d /tmp/loupe-export-XXXXXX)"
  trap 'rm -rf "${SRC_DIR}"' EXIT
  git -C "${REPO_DIR}" archive HEAD | tar -x -C "${SRC_DIR}"
  echo "==> Exported HEAD ${HEAD_REV:0:7} to ${SRC_DIR}"
else
  REVISION="${HEAD_REV}-working-tree"
  SRC_DIR="${REPO_DIR}"
  echo "==> Deploying the WORKING TREE (HEAD ${HEAD_REV:0:7} plus local changes)"
fi

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
  "${SRC_DIR}/" "${REMOTE_USER}@${REMOTE_HOST}:${TMP_DIR}/"

echo "==> Installing on server ..."
# shellcheck disable=SC2087
ssh ${SSH_OPTS} "${REMOTE_USER}@${REMOTE_HOST}" bash <<EOF
  set -e
  sudo rsync -a --exclude='__pycache__' --exclude='*.pyc' ${TMP_DIR}/backend/  ${REMOTE_DEST}/backend/
  sudo rsync -a                                            ${TMP_DIR}/frontend/ ${REMOTE_DEST}/frontend/
  sudo rsync -a --delete                                   ${TMP_DIR}/reticles/ ${REMOTE_DEST}/reticles/
  sudo install -o www-data -g www-data -m 644 ${TMP_DIR}/requirements.txt ${REMOTE_DEST}/requirements.txt
  sudo chown -R www-data:www-data ${REMOTE_DEST}/backend ${REMOTE_DEST}/frontend ${REMOTE_DEST}/reticles
  echo "--> pip install -r requirements.txt (venv owned by www-data)"
  sudo -u www-data -H ${REMOTE_DEST}/.venv/bin/pip install -q --no-cache-dir -r ${REMOTE_DEST}/requirements.txt
  echo "${REVISION}" | sudo tee ${REMOTE_DEST}/DEPLOYED_REVISION >/dev/null
  rm -rf ${TMP_DIR}
  sudo systemctl restart loupe
  sleep 2
  systemctl is-active loupe
EOF

echo "==> Done. https://${REMOTE_HOST} is live at revision ${REVISION}."
