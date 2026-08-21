#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

CONFIG_PATH="/etc/otto-enterprise/enterprise.env"
DRY_RUN=0
INSTALL_ROOT="${OTTO_INSTALL_ROOT:-/opt/otto-enterprise}"
DATA_DIR="${OTTO_DATA_DIR:-/var/lib/otto-enterprise}"
SERVICE_UNIT="/etc/systemd/system/otto-enterprise.service"
LOCK_FILE="/run/lock/otto-enterprise-deploy.lock"
TRANSACTION_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"

usage() {
  cat <<'EOF'
用法：
  sudo ./upgrade.sh [--config /etc/otto-enterprise/enterprise.env]
  ./upgrade.sh [--config ...] --dry-run

边界：
  - 仅升级已经由 one-click current symlink 管理的 Otto Enterprise 安装。
  - 先复制现有 data.db 到隔离目录迁移并启动 canary；通过后才切换 current。
  - 失败会恢复旧 current、旧 data.db，并重启旧服务。
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config)
      [ "$#" -ge 2 ] || otto_die "--config 缺少值"
      CONFIG_PATH="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      otto_die "未知参数：$1"
      ;;
  esac
done

otto_load_config "$CONFIG_PATH"
OTTO_ALLOW_SMS_DISABLED="${OTTO_ALLOW_SMS_DISABLED:-0}"
case "$OTTO_ALLOW_SMS_DISABLED" in
  0|1) ;;
  *) otto_die "OTTO_ALLOW_SMS_DISABLED 只能是 0 或 1" ;;
esac

[ -d "${SCRIPT_DIR}/release" ] || otto_die "部署包缺少 release 目录" 3
[ -f "${SCRIPT_DIR}/release/manifest.json" ] || otto_die "部署包缺少 release manifest" 3
otto_verify_package_manifest "$SCRIPT_DIR"

if [ "$DRY_RUN" -eq 0 ]; then
  [ "$(id -u)" -eq 0 ] || otto_die "正式升级必须使用 sudo/root" 3
  [ "$(uname -s)" = "Linux" ] || otto_die "正式升级仅支持 Linux" 3
  command -v systemctl >/dev/null 2>&1 || otto_die "目标机没有 systemd" 3
  mkdir -p "$(dirname -- "$LOCK_FILE")"
  exec 9>"$LOCK_FILE"
  flock -n 9 || otto_die "已有另一个 Otto 部署正在运行" 3
fi

[ -L "${INSTALL_ROOT}/current" ] || otto_die "${INSTALL_ROOT}/current 不存在或不是 symlink；请先用 install.sh 完成首装" 3
CURRENT_REAL="$(readlink -f "${INSTALL_ROOT}/current")"
[ -d "$CURRENT_REAL" ] || otto_die "current 指向不存在或不是目录：${CURRENT_REAL}" 3
[ -x "${INSTALL_ROOT}/runtime/current/bin/node" ] || otto_die "现有安装缺少固定 Node runtime" 3
[ -f "${DATA_DIR}/data.db" ] && [ ! -L "${DATA_DIR}/data.db" ] || otto_die "现有数据文件不存在或不安全：${DATA_DIR}/data.db" 3
[ -f "$SERVICE_UNIT" ] && [ ! -L "$SERVICE_UNIT" ] || otto_die "systemd 单元不存在或不安全：${SERVICE_UNIT}" 3

NODE_PATH="${INSTALL_ROOT}/runtime/current/bin/node"
RELEASE_INFO="$("$NODE_PATH" "${SCRIPT_DIR}/tools/verify-release.mjs" "${SCRIPT_DIR}/release")"
RELEASE_VERSION="$("$NODE_PATH" -e "const x=JSON.parse(process.argv[1]);console.log(x.version)" "$RELEASE_INFO")"
BUILD_ID="$("$NODE_PATH" -e "const x=JSON.parse(process.argv[1]);console.log(x.buildCommit)" "$RELEASE_INFO")"
RELEASE_SCHEMA_TO="$("$NODE_PATH" -e "const x=JSON.parse(process.argv[1]);console.log(x.database.schemaTo)" "$RELEASE_INFO")"
RELEASE_NAME="${RELEASE_VERSION}-${BUILD_ID:0:12}"
TARGET_RELEASE="${INSTALL_ROOT}/releases/${RELEASE_NAME}"

CURRENT_INFO="$("$NODE_PATH" "${SCRIPT_DIR}/tools/verify-release.mjs" \
  "$CURRENT_REAL" --allow-legacy-lstc)"
CURRENT_BUILD="$("$NODE_PATH" -e "const x=JSON.parse(process.argv[1]);console.log(x.buildCommit)" "$CURRENT_INFO")"
if [ "$CURRENT_BUILD" = "$BUILD_ID" ]; then
  otto_log "相同 release 已安装；执行幂等验收"
  if [ "$DRY_RUN" -eq 0 ]; then
    OTTO_ALLOW_SMS_DISABLED="$OTTO_ALLOW_SMS_DISABLED" "${INSTALL_ROOT}/deploy/verify.sh"
  fi
  exit 0
fi

if [ -e "$TARGET_RELEASE" ] || [ -L "$TARGET_RELEASE" ]; then
  otto_die "目标 release 目录已存在但不是 current：${TARGET_RELEASE}" 3
fi

TXN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/otto-enterprise-upgrade.XXXXXX")"
chmod 0700 "$TXN_DIR"
CANARY_PID=""
OLD_DATA_BACKUP="${TXN_DIR}/data.db.before"
NEW_DATA="${TXN_DIR}/data.db.next"
ROLLBACK_NEEDED=0
OLD_DEPLOY_BACKUP="${TXN_DIR}/deploy.before"
SERVICE_STOPPED=0
UPGRADE_SUCCEEDED=0

cleanup() {
  if [ -n "$CANARY_PID" ] && kill -0 "$CANARY_PID" >/dev/null 2>&1; then
    kill -TERM "$CANARY_PID" >/dev/null 2>&1 || true
    wait "$CANARY_PID" || true
  fi
  if [ "$DRY_RUN" -eq 0 ] && [ "$UPGRADE_SUCCEEDED" -eq 0 ]; then
    if [ "$ROLLBACK_NEEDED" -eq 1 ]; then
      otto_warn "升级失败，开始回滚旧 release"
      systemctl stop otto-enterprise >/dev/null 2>&1 || true
      ln -sfn "$CURRENT_REAL" "${INSTALL_ROOT}/current.rollback"
      mv -Tf "${INSTALL_ROOT}/current.rollback" "${INSTALL_ROOT}/current" || true
      if [ -f "$OLD_DATA_BACKUP" ]; then
        install -o otto-enterprise -g otto-enterprise -m 0600 "$OLD_DATA_BACKUP" "${DATA_DIR}/data.db" || true
      fi
      if [ -d "$OLD_DEPLOY_BACKUP" ]; then
        rm -rf "${INSTALL_ROOT}/deploy.rollback"
        cp -a "$OLD_DEPLOY_BACKUP" "${INSTALL_ROOT}/deploy.rollback" || true
        rm -rf "${INSTALL_ROOT}/deploy"
        mv "${INSTALL_ROOT}/deploy.rollback" "${INSTALL_ROOT}/deploy" || true
      fi
    fi
    if [ "$SERVICE_STOPPED" -eq 1 ]; then
      systemctl daemon-reload >/dev/null 2>&1 || true
      systemctl start otto-enterprise >/dev/null 2>&1 || true
    fi
  fi
  rm -rf "$TXN_DIR"
}
trap cleanup EXIT

if [ "$DRY_RUN" -eq 0 ]; then
  systemctl stop otto-enterprise
  SERVICE_STOPPED=1
fi
"$NODE_PATH" "${SCRIPT_DIR}/tools/db-tool.mjs" backup \
"${DATA_DIR}/data.db" "$OLD_DATA_BACKUP" >/dev/null
cp -p "$OLD_DATA_BACKUP" "$NEW_DATA"
CANARY_DIR="${TXN_DIR}/canary"
mkdir -p "$CANARY_DIR"
cp -p "$NEW_DATA" "${CANARY_DIR}/data.db"

export OTTO_ENTERPRISE_DIR="$CANARY_DIR"
export OTTO_ENTERPRISE_HOST="127.0.0.1"
export OTTO_ENTERPRISE_PORT="17777"
OTTO_PUBLIC_HOST="${OTTO_PUBLIC_HOST:-localhost}"
OTTO_PUBLIC_PORT="${OTTO_PUBLIC_PORT:-7777}"
OTTO_ENTERPRISE_PUBLIC_URL="${OTTO_ENTERPRISE_PUBLIC_URL:-https://${OTTO_PUBLIC_HOST}:${OTTO_PUBLIC_PORT}}"
export OTTO_ENTERPRISE_PUBLIC_URL
export OTTO_ENTERPRISE_ADMIN_TOKEN="${OTTO_ENTERPRISE_ADMIN_TOKEN:-upgrade-canary-token-not-for-public-use}"
export OTTO_ENTERPRISE_TRUST_PROXY_HOPS="1"
export OTTO_APP_VERSION="$RELEASE_VERSION"
export OTTO_BUILD_COMMIT="$BUILD_ID"
export OTTO_LICENSE_TRUST_FILE="${SCRIPT_DIR}/release/license-public-keys.json"

"$NODE_PATH" "${SCRIPT_DIR}/tools/migrate-check.mjs" "${SCRIPT_DIR}/release" "$CANARY_DIR" >/dev/null
otto_log "启动 127.0.0.1:17777 升级 canary"
env \
  -u OTTO_CONTROL_URL \
  -u OTTO_CONTROL_ORIGIN \
  -u OTTO_DEPLOYMENT_BOOTSTRAP_SECRET \
  -u OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE \
  "$NODE_PATH" "${SCRIPT_DIR}/release/run.mjs" >"${TXN_DIR}/canary.log" 2>&1 &
CANARY_PID=$!
CANARY_OK=0
for _ in $(seq 1 30); do
  if "$NODE_PATH" "${SCRIPT_DIR}/tools/health-check.mjs" \
    http://127.0.0.1:17777 "$RELEASE_VERSION" "$BUILD_ID" \
    "$RELEASE_SCHEMA_TO" \
    "$([ "$OTTO_ALLOW_SMS_DISABLED" = "1" ] && printf 'allow-sms-disabled' || printf 'require-sms')" \
    allow-unactivated-deployment \
    >/dev/null 2>&1; then
    CANARY_OK=1
    break
  fi
  sleep 1
done
[ "$CANARY_OK" -eq 1 ] || {
  sed -n '1,160p' "${TXN_DIR}/canary.log" >&2
  otto_die "升级 canary 未通过" 5
}
kill -TERM "$CANARY_PID" >/dev/null 2>&1 || true
wait "$CANARY_PID" || true
CANARY_PID=""

if [ "$DRY_RUN" -eq 1 ]; then
  otto_log "dry-run 通过：release、数据库迁移和 canary health 均正常；未切换 current"
  exit 0
fi

mkdir -p "${INSTALL_ROOT}/releases"
cp -a "${SCRIPT_DIR}/release" "$TARGET_RELEASE"
chown -R root:root "$TARGET_RELEASE"
otto_prepare_service_layout "$INSTALL_ROOT" "$TARGET_RELEASE"
"$NODE_PATH" "${SCRIPT_DIR}/tools/verify-release.mjs" "$TARGET_RELEASE" >/dev/null

ROLLBACK_NEEDED=1
if [ -d "${INSTALL_ROOT}/deploy" ] && [ ! -L "${INSTALL_ROOT}/deploy" ]; then
  cp -a "${INSTALL_ROOT}/deploy" "$OLD_DEPLOY_BACKUP"
fi
systemctl stop otto-enterprise
install -o otto-enterprise -g otto-enterprise -m 0600 "${CANARY_DIR}/data.db" "${DATA_DIR}/data.db"
ln -s "$TARGET_RELEASE" "${INSTALL_ROOT}/current.next"
mv -Tf "${INSTALL_ROOT}/current.next" "${INSTALL_ROOT}/current"
install -o root -g root -m 0644 "${SCRIPT_DIR}/templates/otto-enterprise.service" "$SERVICE_UNIT"
rm -rf "${INSTALL_ROOT}/deploy.next"
mkdir -p "${INSTALL_ROOT}/deploy.next"
cp -a "${SCRIPT_DIR}/tools" "${INSTALL_ROOT}/deploy.next/"
cp -a "${SCRIPT_DIR}/lib" "${INSTALL_ROOT}/deploy.next/"
cp -a "${SCRIPT_DIR}/verify.sh" "${INSTALL_ROOT}/deploy.next/verify.sh"
cp -a "${SCRIPT_DIR}/backup-now.sh" "${INSTALL_ROOT}/deploy.next/backup-now.sh"
cp -a "${SCRIPT_DIR}/restore-backup.sh" "${INSTALL_ROOT}/deploy.next/restore-backup.sh"
chmod 755 \
  "${INSTALL_ROOT}/deploy.next/verify.sh" \
  "${INSTALL_ROOT}/deploy.next/backup-now.sh" \
  "${INSTALL_ROOT}/deploy.next/restore-backup.sh"
rm -rf "${INSTALL_ROOT}/deploy"
mv "${INSTALL_ROOT}/deploy.next" "${INSTALL_ROOT}/deploy"
systemctl daemon-reload
systemctl start otto-enterprise
OTTO_ALLOW_SMS_DISABLED="$OTTO_ALLOW_SMS_DISABLED" "${INSTALL_ROOT}/deploy/verify.sh"
ROLLBACK_NEEDED=0
SERVICE_STOPPED=0
UPGRADE_SUCCEEDED=1
otto_log "升级完成：v${RELEASE_VERSION} ${BUILD_ID}"
