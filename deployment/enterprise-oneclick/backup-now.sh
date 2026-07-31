#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

CONFIG_PATH="${1:-/etc/otto-enterprise/enterprise.env}"
[ "$(id -u)" -eq 0 ] || otto_die "立即备份必须使用 sudo/root" 3
[ -f "$CONFIG_PATH" ] && [ ! -L "$CONFIG_PATH" ] \
  || otto_die "运行配置不存在或不安全：${CONFIG_PATH}" 3
set -a
# shellcheck disable=SC1090
source "$CONFIG_PATH"
set +a

RESPONSE="$(curl --fail --silent --show-error --max-time 1800 \
  -X POST \
  -H "Authorization: Bearer ${OTTO_ENTERPRISE_ADMIN_TOKEN}" \
  http://127.0.0.1:7778/enterprise/deployment/data-protection/backup)"
NODE="/opt/otto-enterprise/runtime/current/bin/node"
"$NODE" -e '
  const status = JSON.parse(process.argv[1]);
  if (status.lastError) throw new Error(status.lastError);
  if (!status.lastSuccessAt || !status.latestBackupSha256) {
    throw new Error("backup response is incomplete");
  }
  console.log(`[Otto Backup] 已完成 ${status.lastSuccessAt}`);
  console.log(`[Otto Backup] 文件 ${status.latestBackupPath}`);
  console.log(`[Otto Backup] SHA-256 ${status.latestBackupSha256}`);
' "$RESPONSE"
