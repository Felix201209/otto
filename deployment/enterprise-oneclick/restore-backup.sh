#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

ARCHIVE="${1:-}"
CONFIG_PATH="${2:-/etc/otto-enterprise/enterprise.env}"
[ "$(id -u)" -eq 0 ] || otto_die "恢复备份必须使用 sudo/root" 3
[ -n "$ARCHIVE" ] || otto_die "用法：sudo ./restore-backup.sh /绝对路径/备份.otto-backup [enterprise.env]"
case "$ARCHIVE" in /*) ;; *) otto_die "备份路径必须是绝对路径" ;; esac
[ -f "$ARCHIVE" ] && [ ! -L "$ARCHIVE" ] || otto_die "备份不存在或不安全" 3
[ -f "$CONFIG_PATH" ] && [ ! -L "$CONFIG_PATH" ] || otto_die "运行配置不存在或不安全" 3

exec 9>/run/lock/otto-enterprise-deploy.lock
flock -n 9 || otto_die "已有部署、升级或恢复操作正在运行" 3
set -a
# shellcheck disable=SC1090
source "$CONFIG_PATH"
set +a

NODE="/opt/otto-enterprise/runtime/current/bin/node"
CLI="/opt/otto-enterprise/current/src/modules/data_platform/dataProtectionCli.js"
RELEASE_INFO="$("$NODE" "${SCRIPT_DIR}/tools/verify-release.mjs" /opt/otto-enterprise/current)"
SCHEMA_TO="$("$NODE" -e "const x=JSON.parse(process.argv[1]);console.log(x.database.schemaTo)" "$RELEASE_INFO")"
DATA_DIR="${OTTO_ENTERPRISE_DIR:-/var/lib/otto-enterprise}"
RECEIPT="$(mktemp /var/tmp/otto-restore-receipt.XXXXXX.json)"
trap 'rm -f "$RECEIPT"' EXIT

otto_log "先执行解密、认证和 SQLite 恢复演练"
"$NODE" "$CLI" verify --archive "$ARCHIVE" --data-dir "$DATA_DIR" --max-schema "$SCHEMA_TO" >/dev/null

systemctl stop otto-enterprise
if ! "$NODE" "$CLI" restore --archive "$ARCHIVE" --data-dir "$DATA_DIR" \
  --max-schema "$SCHEMA_TO" --receipt "$RECEIPT"; then
  systemctl start otto-enterprise || true
  otto_die "恢复未写入完成，原服务已重新启动" 5
fi
chown -R otto-enterprise:otto-enterprise "$DATA_DIR"
chmod 0700 "$DATA_DIR"
systemctl start otto-enterprise

HEALTHY=0
for _ in $(seq 1 30); do
  if "${SCRIPT_DIR}/verify.sh" >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 1
done
if [ "$HEALTHY" -ne 1 ]; then
  otto_warn "恢复后的服务未通过健康检查，自动回滚到恢复前数据"
  systemctl stop otto-enterprise || true
  ROLLBACK_DIR="$("$NODE" -e "const x=require('fs').readFileSync(process.argv[1],'utf8');console.log(JSON.parse(x).rollbackDirectory)" "$RECEIPT")"
  "$NODE" "$CLI" rollback --data-dir "$DATA_DIR" --rollback-dir "$ROLLBACK_DIR"
  chown -R otto-enterprise:otto-enterprise "$DATA_DIR"
  systemctl start otto-enterprise
  "${SCRIPT_DIR}/verify.sh" >/dev/null \
    || otto_die "恢复失败且旧数据回滚后服务仍不健康，需要人工检查" 6
  otto_die "恢复后的版本不健康，已自动回滚到原数据" 5
fi

otto_log "备份恢复和服务健康检查均通过；恢复前数据仍保留在 receipt 指向的 rollbackDirectory"
