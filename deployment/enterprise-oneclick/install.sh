#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

CONFIG_PATH=""
MIGRATION_ARCHIVE=""
DRY_RUN=0
INSTALL_ROOT="/opt/otto-enterprise"
DATA_DIR="/var/lib/otto-enterprise"
CONFIG_DIR="/etc/otto-enterprise"
SERVICE_UNIT="/etc/systemd/system/otto-enterprise.service"
CADDY_MAIN="/etc/caddy/Caddyfile"
CADDY_FRAGMENT="/etc/caddy/otto-enterprise.caddy"
LOCK_FILE="/run/lock/otto-enterprise-deploy.lock"
TRANSACTION_MARKER="${INSTALL_ROOT}/.installing"
TRANSACTION_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"

usage() {
  cat <<'EOF'
用法：
  sudo ./install.sh --config ./enterprise.env \
    [--migration /安全目录/otto-enterprise-migration.tar.gz]

  ./install.sh --config ./enterprise.env \
    [--migration ...] --dry-run

边界：
  - 面向 Ubuntu 22.04/24.04 + systemd 的全新服务器迁入。
  - 已安装完全相同 release 时做幂等验收；发现不同现有安装会拒绝覆盖。
  - 不修改云安全组、DNS 或 UFW。
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config)
      [ "$#" -ge 2 ] || otto_die "--config 缺少值"
      CONFIG_PATH="$2"
      shift 2
      ;;
    --migration)
      [ "$#" -ge 2 ] || otto_die "--migration 缺少值"
      MIGRATION_ARCHIVE="$2"
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

[ -n "$CONFIG_PATH" ] || otto_die "必须提供 --config"
otto_load_config "$CONFIG_PATH"

OTTO_PUBLIC_HOST="${OTTO_PUBLIC_HOST:-}"
OTTO_PUBLIC_PORT="${OTTO_PUBLIC_PORT:-7777}"
OTTO_CADDY_MODE="${OTTO_CADDY_MODE:-managed}"
OTTO_ENTERPRISE_ADMIN_TOKEN="${OTTO_ENTERPRISE_ADMIN_TOKEN:-auto}"
OTTO_BOOTSTRAP_USERNAME="${OTTO_BOOTSTRAP_USERNAME:-admin}"
OTTO_BOOTSTRAP_PASSWORD="${OTTO_BOOTSTRAP_PASSWORD:-auto}"
OTTO_BOOTSTRAP_NAME="${OTTO_BOOTSTRAP_NAME:-系统管理员}"
OTTO_ALLOW_SMS_DISABLED="${OTTO_ALLOW_SMS_DISABLED:-0}"
OTTO_BACKUP_ENCRYPTION_KEY="${OTTO_BACKUP_ENCRYPTION_KEY:-auto}"
OTTO_BACKUP_INTERVAL_HOURS="${OTTO_BACKUP_INTERVAL_HOURS:-24}"
OTTO_BACKUP_RETENTION_DAYS="${OTTO_BACKUP_RETENTION_DAYS:-30}"
OTTO_BACKUP_MINIMUM_RETAINED="${OTTO_BACKUP_MINIMUM_RETAINED:-3}"
OTTO_BACKUP_REPLICA_DIR="${OTTO_BACKUP_REPLICA_DIR:-}"
OTTO_DISK_MIN_FREE_MB="${OTTO_DISK_MIN_FREE_MB:-2048}"
OTTO_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE="${OTTO_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE:-}"
OTTO_ATTACHMENT_ENCRYPTION_KEY_FILE="${OTTO_ATTACHMENT_ENCRYPTION_KEY_FILE:-}"
OTTO_FIELD_ENCRYPTION_KEY_FILE="${OTTO_FIELD_ENCRYPTION_KEY_FILE:-}"
OTTO_CONTROL_URL="${OTTO_CONTROL_URL:-}"
OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE="${OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE:-}"
OTTO_DEPLOYMENT_KIND="${OTTO_DEPLOYMENT_KIND:-self-hosted}"
OTTO_TELEMETRY_ENDPOINT="${OTTO_TELEMETRY_ENDPOINT:-}"
OTTO_TELEMETRY_RETENTION_DAYS="${OTTO_TELEMETRY_RETENTION_DAYS:-90}"
OTTO_FEDERATION_ENABLED="${OTTO_FEDERATION_ENABLED:-false}"
OTTO_FEDERATION_GATEWAY_URL="${OTTO_FEDERATION_GATEWAY_URL:-}"
OTTO_FEDERATION_DISPLAY_NAME="${OTTO_FEDERATION_DISPLAY_NAME:-}"
OTTO_FEDERATION_POLL_INTERVAL_MS="${OTTO_FEDERATION_POLL_INTERVAL_MS:-10000}"
OTTO_FEDERATION_SIGNING_KEY_FILE="${OTTO_FEDERATION_SIGNING_KEY_FILE:-}"
OTTO_DATA_CONTROLLER_NAME="${OTTO_DATA_CONTROLLER_NAME:-}"
OTTO_PRIVACY_CONTACT="${OTTO_PRIVACY_CONTACT:-}"
OTTO_LEGAL_DOCUMENTS_APPROVED="${OTTO_LEGAL_DOCUMENTS_APPROVED:-false}"
OTTO_DATA_REGION="${OTTO_DATA_REGION:-CN}"
OTTO_DATA_RESIDENCY="${OTTO_DATA_RESIDENCY:-customer_server}"
OTTO_STORAGE_VOLUME_ENCRYPTED="${OTTO_STORAGE_VOLUME_ENCRYPTED:-false}"
OTTO_CROSS_BORDER_DATA_ENABLED="${OTTO_CROSS_BORDER_DATA_ENABLED:-false}"

[[ "$OTTO_PUBLIC_HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] \
  || otto_die "OTTO_PUBLIC_HOST 不是合法主机名"
[[ "$OTTO_PUBLIC_PORT" =~ ^[0-9]+$ ]] \
  && [ "$OTTO_PUBLIC_PORT" -ge 1 ] \
  && [ "$OTTO_PUBLIC_PORT" -le 65535 ] \
  || otto_die "OTTO_PUBLIC_PORT 必须是 1-65535"
case "$OTTO_CADDY_MODE" in
  managed|external) ;;
  *) otto_die "OTTO_CADDY_MODE 只能是 managed 或 external" ;;
esac
if [ "$OTTO_CADDY_MODE" = "managed" ]; then
  [[ "$OTTO_PUBLIC_HOST" == *.* ]] \
    || otto_die "managed Caddy 需要可公开签发证书的 FQDN，不能使用裸主机名或 IP"
  [[ "$OTTO_PUBLIC_HOST" =~ [A-Za-z] ]] \
    || otto_die "managed Caddy 不接受裸 IP；请使用域名或选择 external"
fi

EXPECTED_PUBLIC_URL="https://${OTTO_PUBLIC_HOST}:${OTTO_PUBLIC_PORT}"
OTTO_ENTERPRISE_PUBLIC_URL="${OTTO_ENTERPRISE_PUBLIC_URL:-$EXPECTED_PUBLIC_URL}"
if [ "$OTTO_CADDY_MODE" = "managed" ] \
  && [ "$OTTO_ENTERPRISE_PUBLIC_URL" != "$EXPECTED_PUBLIC_URL" ]; then
  otto_die "managed 模式下 OTTO_ENTERPRISE_PUBLIC_URL 必须为 ${EXPECTED_PUBLIC_URL}"
fi
[[ "$OTTO_ENTERPRISE_PUBLIC_URL" == https://* ]] \
  || otto_die "OTTO_ENTERPRISE_PUBLIC_URL 必须使用 HTTPS"

case "$OTTO_ALLOW_SMS_DISABLED" in
  0|1) ;;
  *) otto_die "OTTO_ALLOW_SMS_DISABLED 只能是 0 或 1" ;;
esac
for numeric_value in \
  "$OTTO_BACKUP_INTERVAL_HOURS" \
  "$OTTO_BACKUP_RETENTION_DAYS" \
  "$OTTO_BACKUP_MINIMUM_RETAINED" \
  "$OTTO_DISK_MIN_FREE_MB" \
  "$OTTO_TELEMETRY_RETENTION_DAYS" \
  "$OTTO_FEDERATION_POLL_INTERVAL_MS"; do
  [[ "$numeric_value" =~ ^[0-9]+$ ]] && [ "$numeric_value" -ge 1 ] \
    || otto_die "备份周期、保留策略和磁盘阈值必须是正整数"
done
case "$OTTO_FEDERATION_ENABLED" in
  true|false) ;;
  *) otto_die "OTTO_FEDERATION_ENABLED 只能是 true 或 false" ;;
esac
if [ "$OTTO_FEDERATION_POLL_INTERVAL_MS" -lt 2000 ]; then
  otto_die "OTTO_FEDERATION_POLL_INTERVAL_MS 不能小于 2000"
fi
if [ "$OTTO_FEDERATION_ENABLED" = "true" ]; then
  case "$OTTO_FEDERATION_GATEWAY_URL" in
    https://*) ;;
    *) otto_die "启用联邦网关时 OTTO_FEDERATION_GATEWAY_URL 必须使用 HTTPS" ;;
  esac
fi
if [ -n "$OTTO_FEDERATION_SIGNING_KEY_FILE" ]; then
  [[ "$OTTO_FEDERATION_SIGNING_KEY_FILE" = /* ]] \
    || otto_die "OTTO_FEDERATION_SIGNING_KEY_FILE 必须使用绝对路径"
  [ -f "$OTTO_FEDERATION_SIGNING_KEY_FILE" ] \
    && [ ! -L "$OTTO_FEDERATION_SIGNING_KEY_FILE" ] \
    || otto_die "OTTO_FEDERATION_SIGNING_KEY_FILE 必须指向普通文件且不能是符号链接"
  grep -Fq 'BEGIN PRIVATE KEY' "$OTTO_FEDERATION_SIGNING_KEY_FILE" \
    || otto_die "联邦签名私钥必须是 PKCS#8 PEM"
fi
case "$OTTO_CROSS_BORDER_DATA_ENABLED" in
  true|false) ;;
  *) otto_die "OTTO_CROSS_BORDER_DATA_ENABLED 只能是 true 或 false" ;;
esac
case "$OTTO_STORAGE_VOLUME_ENCRYPTED" in
  true|false) ;;
  *) otto_die "OTTO_STORAGE_VOLUME_ENCRYPTED 只能是 true 或 false" ;;
esac
case "$OTTO_LEGAL_DOCUMENTS_APPROVED" in
  true|false) ;;
  *) otto_die "OTTO_LEGAL_DOCUMENTS_APPROVED 只能是 true 或 false" ;;
esac
if [ -n "$OTTO_BACKUP_REPLICA_DIR" ] \
  && [ "$OTTO_BACKUP_REPLICA_DIR" != "/var/backups/otto-enterprise" ]; then
  otto_die "一键部署的异地备份挂载点固定为 /var/backups/otto-enterprise"
fi
case "$OTTO_TELEMETRY_ENDPOINT" in
  ""|https://*) ;;
  *) otto_die "OTTO_TELEMETRY_ENDPOINT 必须为空或使用 HTTPS" ;;
esac
case "$OTTO_CONTROL_URL" in
  ""|https://*) ;;
  *) otto_die "OTTO_CONTROL_URL 必须为空或使用 HTTPS" ;;
esac
if [ -n "${OTTO_DEPLOYMENT_BOOTSTRAP_SECRET:-}" ]; then
  otto_die "不再接受内联部署登记密钥；请使用权限受限的 OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE"
fi
unset OTTO_DEPLOYMENT_BOOTSTRAP_SECRET
if [ -n "$OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE" ]; then
  [[ "$OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE" = /* ]] \
    || otto_die "OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE 必须使用绝对路径"
  [ -f "$OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE" ] \
    && [ ! -L "$OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE" ] \
    || otto_die "部署登记密钥文件必须是普通文件且不能是符号链接"
  [ -n "$OTTO_CONTROL_URL" ] \
    || otto_die "提供部署登记密钥文件时必须同时配置 OTTO_CONTROL_URL"
fi
for key_variable in \
  OTTO_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE \
  OTTO_ATTACHMENT_ENCRYPTION_KEY_FILE \
  OTTO_FIELD_ENCRYPTION_KEY_FILE; do
  key_path="${!key_variable}"
  [ -z "$key_path" ] && continue
  [[ "$key_path" = /* ]] || otto_die "${key_variable} 必须使用绝对路径"
  [ -f "$key_path" ] && [ ! -L "$key_path" ] \
    || otto_die "${key_variable} 必须指向已存在的普通文件，且不能是符号链接"
  [ "$(wc -c < "$key_path")" -eq 32 ] \
    || otto_die "${key_variable} 必须包含恰好 32 字节原始密钥"
done
if [ "$OTTO_ALLOW_SMS_DISABLED" = "0" ]; then
  for key in \
    ALIYUN_SMS_ACCESS_KEY_ID \
    ALIYUN_SMS_ACCESS_KEY_SECRET \
    ALIYUN_SMS_SIGN_NAME \
    ALIYUN_SMS_TEMPLATE_ID; do
    value="${!key:-}"
    [ -n "$value" ] && [ "$value" != "REPLACE_ME" ] \
      || otto_die "${key} 未配置；邀请码注册依赖短信，正式迁移默认 fail closed"
  done
fi

[ -d "${SCRIPT_DIR}/release" ] || otto_die "部署包缺少 release 目录" 3
[ -f "${SCRIPT_DIR}/release/manifest.json" ] || otto_die "部署包缺少 release manifest" 3
[ -f "${SCRIPT_DIR}/tools/db-tool.mjs" ] || otto_die "部署包缺少数据库工具" 3
otto_verify_package_manifest "$SCRIPT_DIR"

if [ -n "$MIGRATION_ARCHIVE" ]; then
  case "$MIGRATION_ARCHIVE" in
    /*) ;;
    *) otto_die "--migration 必须是绝对路径" ;;
  esac
  [ -f "$MIGRATION_ARCHIVE" ] || otto_die "迁移包不存在：${MIGRATION_ARCHIVE}" 3
  [ ! -L "$MIGRATION_ARCHIVE" ] || otto_die "迁移包不能是符号链接" 3
fi

if [ "$DRY_RUN" -eq 0 ]; then
  [ "$(id -u)" -eq 0 ] || otto_die "正式安装必须使用 sudo/root" 3
  [ "$(uname -s)" = "Linux" ] || otto_die "正式安装仅支持 Linux" 3
  [ -r /etc/os-release ] || otto_die "无法识别 Linux 发行版" 3
  # shellcheck disable=SC1091
  source /etc/os-release
  [ "${ID:-}" = "ubuntu" ] || otto_die "仅支持 Ubuntu，当前为 ${ID:-unknown}" 3
  case "${VERSION_ID:-}" in
    22.04|24.04) ;;
    *) otto_die "仅支持 Ubuntu 22.04/24.04，当前为 ${VERSION_ID:-unknown}" 3 ;;
  esac
  command -v systemctl >/dev/null 2>&1 || otto_die "目标机没有 systemd" 3
  mkdir -p "$(dirname -- "$LOCK_FILE")"
  exec 9>"$LOCK_FILE"
  flock -n 9 || otto_die "已有另一个 Otto 部署正在运行" 3
fi

otto_arch >/dev/null
if [ "$OTTO_CADDY_MODE" = "managed" ] && command -v getent >/dev/null 2>&1; then
  getent ahosts "$OTTO_PUBLIC_HOST" >/dev/null 2>&1 \
    || otto_die "域名当前无法解析：${OTTO_PUBLIC_HOST}" 3
fi

AVAILABLE_KB="$(df -Pk / | awk 'NR==2 {print $4}')"
MIGRATION_KB=0
if [ -n "$MIGRATION_ARCHIVE" ]; then
  MIGRATION_KB="$(( ($(stat -c %s "$MIGRATION_ARCHIVE" 2>/dev/null || stat -f %z "$MIGRATION_ARCHIVE") + 1023) / 1024 ))"
fi
REQUIRED_KB="$((524288 + MIGRATION_KB * 4))"
[ "$AVAILABLE_KB" -ge "$REQUIRED_KB" ] \
  || otto_die "磁盘不足：至少需要 ${REQUIRED_KB} KiB，可用 ${AVAILABLE_KB} KiB" 3

otto_log "部署计划"
printf '  目标：Ubuntu %s / %s\n' "${VERSION_ID:-dry-run}" "$(uname -m)"
printf '  公网：%s\n  代理：%s\n' "$OTTO_ENTERPRISE_PUBLIC_URL" "$OTTO_CADDY_MODE"
printf '  数据：%s\n' "$([ -n "$MIGRATION_ARCHIVE" ] && printf '迁移包 %s' "$MIGRATION_ARCHIVE" || printf '新建空库')"
printf '  短信：%s\n' "$([ "$OTTO_ALLOW_SMS_DISABLED" = "1" ] && printf '允许暂时关闭' || printf '必须可配置')"
printf '  自动写入：%s、%s、%s\n' "$INSTALL_ROOT" "$CONFIG_DIR" "$SERVICE_UNIT"
printf '  不会修改：DNS、云安全组、UFW\n'

[ ! -e "$TRANSACTION_MARKER" ] && [ ! -L "$TRANSACTION_MARKER" ] \
  || otto_die "发现未完成安装标记：${TRANSACTION_MARKER}。请先检查 systemd、current、data.db 和失败事务目录，再按说明恢复" 3

CURRENT_EXISTS=0
CURRENT_REAL=""
if [ -e "${INSTALL_ROOT}/current" ] || [ -L "${INSTALL_ROOT}/current" ]; then
  CURRENT_EXISTS=1
  [ -L "${INSTALL_ROOT}/current" ] \
    || otto_die "${INSTALL_ROOT}/current 必须是符号链接，拒绝覆盖现有路径" 3
  CURRENT_REAL="$(readlink -f "${INSTALL_ROOT}/current")"
  [ -d "$CURRENT_REAL" ] \
    || otto_die "current 指向不存在或不是目录：${CURRENT_REAL}" 3
  [ -x "${INSTALL_ROOT}/runtime/current/bin/node" ] \
    || otto_die "现有安装缺少固定 Node runtime，拒绝修改" 3
else
  if [ -e "$INSTALL_ROOT" ] || [ -L "$INSTALL_ROOT" ]; then
    [ -d "$INSTALL_ROOT" ] && [ ! -L "$INSTALL_ROOT" ] \
      || otto_die "安装根路径不是普通目录：${INSTALL_ROOT}" 3
    [ -z "$(find "$INSTALL_ROOT" -mindepth 1 -maxdepth 1 -print -quit)" ] \
      || otto_die "发现没有 current 管理的安装根内容，拒绝覆盖：${INSTALL_ROOT}" 3
  fi
  [ ! -e "${DATA_DIR}/data.db" ] \
    || otto_die "发现未受 current release 管理的现有数据库，拒绝覆盖：${DATA_DIR}/data.db" 3
  [ ! -e "${CONFIG_DIR}/enterprise.env" ] && [ ! -L "${CONFIG_DIR}/enterprise.env" ] \
    || otto_die "发现未受 current release 管理的现有配置，拒绝覆盖：${CONFIG_DIR}/enterprise.env" 3
  [ ! -e "$SERVICE_UNIT" ] && [ ! -L "$SERVICE_UNIT" ] \
    || otto_die "发现未受 current release 管理的 systemd 单元，拒绝覆盖：${SERVICE_UNIT}" 3
  if [ "$OTTO_CADDY_MODE" = "managed" ]; then
    [ ! -e "$CADDY_FRAGMENT" ] && [ ! -L "$CADDY_FRAGMENT" ] \
      || otto_die "发现现有 Otto Caddy 片段，拒绝覆盖：${CADDY_FRAGMENT}" 3
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  TXN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/otto-enterprise-dry-run.XXXXXX")"
else
  TXN_DIR="/var/tmp/otto-enterprise-deploy-${TRANSACTION_ID}"
  mkdir -p "$TXN_DIR"
fi
chmod 0700 "$TXN_DIR"
INSTALL_COMMITTED=0
CREATED_SERVICE=0
TARGET_RELEASE=""
TARGET_RELEASE_CREATED=0
DEPLOY_CREATED=0
CURRENT_CREATED=0
DATA_CREATED=0
CONFIG_CREATED=0
BOOTSTRAP_SECRET_CREATED=0
BOOTSTRAP_SECRET_REPLACED=0
BOOTSTRAP_SECRET_STAGED=""
BOOTSTRAP_SECRET_TARGET=""
BOOTSTRAP_SECRET_BACKUP=""
RUNTIME_LINK_CREATED=0
RUNTIME_DIR_CREATED=0
TRANSACTION_MARKER_CREATED=0
INSTALL_ROOT_CREATED=0
NODE_RUNTIME_DIR=""
CANARY_PID=""
CADDY_MAIN_BACKUP=""
CADDY_FRAGMENT_BACKUP=""

cleanup() {
  local status=$?
  if [ -n "$CANARY_PID" ] && kill -0 "$CANARY_PID" >/dev/null 2>&1; then
    kill -TERM "$CANARY_PID" >/dev/null 2>&1 || true
    wait "$CANARY_PID" || true
  fi
  if [ "$status" -ne 0 ] && [ "$INSTALL_COMMITTED" -eq 0 ]; then
    otto_warn "安装未提交，保留已迁移数据库副本供排查：${TXN_DIR}"
    if [ "$CREATED_SERVICE" -eq 1 ]; then
      systemctl disable --now otto-enterprise >/dev/null 2>&1 || true
      if [ -f "$SERVICE_UNIT" ]; then
        mv "$SERVICE_UNIT" "${TXN_DIR}/failed-otto-enterprise.service"
        systemctl daemon-reload >/dev/null 2>&1 || true
      fi
    fi
    if [ "$CURRENT_CREATED" -eq 1 ] && [ -L "${INSTALL_ROOT}/current" ]; then
      mv "${INSTALL_ROOT}/current" "${TXN_DIR}/failed-current-link"
    fi
    if [ "$TARGET_RELEASE_CREATED" -eq 1 ] \
      && [ -n "$TARGET_RELEASE" ] \
      && [ -d "$TARGET_RELEASE" ]; then
      mv "$TARGET_RELEASE" "${TXN_DIR}/failed-release"
    fi
    if [ "$DEPLOY_CREATED" -eq 1 ] && [ -d "${INSTALL_ROOT}/deploy" ]; then
      mv "${INSTALL_ROOT}/deploy" "${TXN_DIR}/failed-deploy-tools"
    fi
    if [ "$DATA_CREATED" -eq 1 ] && [ -f "${DATA_DIR}/data.db" ]; then
      mv "${DATA_DIR}/data.db" "${TXN_DIR}/failed-data.db"
    fi
    if [ "$CONFIG_CREATED" -eq 1 ] && [ -f "${CONFIG_DIR}/enterprise.env" ]; then
      mv "${CONFIG_DIR}/enterprise.env" "${TXN_DIR}/failed-enterprise.env"
    fi
    if [ "$BOOTSTRAP_SECRET_CREATED" -eq 1 ] \
      && { [ -e "$BOOTSTRAP_SECRET_TARGET" ] || [ -L "$BOOTSTRAP_SECRET_TARGET" ]; }; then
      rm -f "$BOOTSTRAP_SECRET_TARGET"
    fi
    if [ "$BOOTSTRAP_SECRET_REPLACED" -eq 1 ] \
      && [ -f "$BOOTSTRAP_SECRET_BACKUP" ] \
      && [ ! -L "$BOOTSTRAP_SECRET_BACKUP" ]; then
      install -o otto-enterprise -g otto-enterprise -m 0600 \
        "$BOOTSTRAP_SECRET_BACKUP" "$BOOTSTRAP_SECRET_TARGET"
      rm -f "$BOOTSTRAP_SECRET_BACKUP"
    fi
    if [ "$RUNTIME_LINK_CREATED" -eq 1 ] && [ -L "${INSTALL_ROOT}/runtime/current" ]; then
      mv "${INSTALL_ROOT}/runtime/current" "${TXN_DIR}/failed-runtime-link"
    fi
    if [ "$RUNTIME_DIR_CREATED" -eq 1 ] \
      && [ -n "$NODE_RUNTIME_DIR" ] \
      && [ -d "$NODE_RUNTIME_DIR" ]; then
      mv "$NODE_RUNTIME_DIR" "${TXN_DIR}/failed-node-runtime"
    fi
    if [ "$TRANSACTION_MARKER_CREATED" -eq 1 ] && [ -f "$TRANSACTION_MARKER" ]; then
      mv "$TRANSACTION_MARKER" "${TXN_DIR}/failed-installing-marker"
    fi
    rmdir "${INSTALL_ROOT}/releases" "${INSTALL_ROOT}/runtime" >/dev/null 2>&1 || true
    if [ "$INSTALL_ROOT_CREATED" -eq 1 ]; then
      rmdir "$INSTALL_ROOT" >/dev/null 2>&1 || true
    fi
    if [ -n "$CADDY_MAIN_BACKUP" ] && [ -f "$CADDY_MAIN_BACKUP" ]; then
      cp -p "$CADDY_MAIN_BACKUP" "$CADDY_MAIN"
    fi
    if [ -n "$CADDY_FRAGMENT_BACKUP" ] && [ -f "$CADDY_FRAGMENT_BACKUP" ]; then
      cp -p "$CADDY_FRAGMENT_BACKUP" "$CADDY_FRAGMENT"
    elif [ -f "$CADDY_FRAGMENT" ] && [ -f "${TXN_DIR}/created-caddy-fragment" ]; then
      mv "$CADDY_FRAGMENT" "${TXN_DIR}/failed-caddy-fragment"
    fi
    if command -v caddy >/dev/null 2>&1 && [ -f "$CADDY_MAIN" ]; then
      caddy validate --config "$CADDY_MAIN" --adapter caddyfile >/dev/null 2>&1 \
        && systemctl reload caddy >/dev/null 2>&1 || true
    fi
  elif [ "$status" -eq 0 ]; then
    rm -rf "$TXN_DIR"
  fi
  if [ -n "$BOOTSTRAP_SECRET_STAGED" ]; then
    rm -f "$BOOTSTRAP_SECRET_STAGED"
  fi
}
trap cleanup EXIT

PREFERRED_NODE=""
if [ "$CURRENT_EXISTS" -eq 1 ]; then
  PREFERRED_NODE="${INSTALL_ROOT}/runtime/current/bin/node"
fi
if ! NODE_PATH="$(otto_resolve_node "$PREFERRED_NODE")"; then
  if ! command -v curl >/dev/null 2>&1 \
    || [ ! -r /etc/ssl/certs/ca-certificates.crt ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      otto_die "dry-run 深度校验需要 Node >= ${OTTO_NODE_MIN_VERSION}，或预先安装 curl 与 ca-certificates 以下载临时固定 runtime" 3
    fi
    otto_log "安装深度校验所需的 curl 与 CA 证书"
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl
  fi
  NODE_PATH="$(otto_install_node_runtime "${TXN_DIR}/runtime")"
fi

if [ -n "$OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE" ]; then
  BOOTSTRAP_SECRET_STAGED="${TXN_DIR}/deployment-enrollment-secret"
  "$NODE_PATH" "${SCRIPT_DIR}/tools/stage-enrollment-secret.mjs" \
    "$OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE" "$BOOTSTRAP_SECRET_STAGED"
fi

RELEASE_INFO="$("$NODE_PATH" "${SCRIPT_DIR}/tools/verify-release.mjs" "${SCRIPT_DIR}/release")"
RELEASE_VERSION="$("$NODE_PATH" -e "const x=JSON.parse(process.argv[1]);console.log(x.version)" "$RELEASE_INFO")"
BUILD_ID="$("$NODE_PATH" -e "const x=JSON.parse(process.argv[1]);console.log(x.buildCommit)" "$RELEASE_INFO")"
RELEASE_SCHEMA_TO="$("$NODE_PATH" -e "const x=JSON.parse(process.argv[1]);console.log(x.database.schemaTo)" "$RELEASE_INFO")"
RELEASE_NAME="${RELEASE_VERSION}-${BUILD_ID:0:12}"
TARGET_RELEASE="${INSTALL_ROOT}/releases/${RELEASE_NAME}"

if [ "$CURRENT_EXISTS" -eq 1 ]; then
  CURRENT_INFO="$("$NODE_PATH" "${SCRIPT_DIR}/tools/verify-release.mjs" "$CURRENT_REAL")"
  CURRENT_BUILD="$("$NODE_PATH" -e "const x=JSON.parse(process.argv[1]);console.log(x.buildCommit)" "$CURRENT_INFO")"
  if [ "$CURRENT_BUILD" = "$BUILD_ID" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      otto_log "dry-run 通过：相同 release 已安装；未写入或重启"
    else
      otto_log "相同 release 已安装；不备份、不重启，直接执行幂等验收"
      OTTO_ALLOW_SMS_DISABLED="$OTTO_ALLOW_SMS_DISABLED" "${SCRIPT_DIR}/verify.sh"
    fi
    INSTALL_COMMITTED=1
    exit 0
  fi
  otto_die "检测到不同的现有 Otto release，迁入包拒绝覆盖。请先走专门升级/回滚流程" 3
fi

MIGRATION_DB=""
if [ -n "$MIGRATION_ARCHIVE" ]; then
  STAGED_MIGRATION="${TXN_DIR}/migration.tar.gz"
  cp "$MIGRATION_ARCHIVE" "$STAGED_MIGRATION"
  chmod 0600 "$STAGED_MIGRATION"
  ACTUAL_ARCHIVE_SHA="$(otto_sha256 "$STAGED_MIGRATION")"
  if [ -f "${MIGRATION_ARCHIVE}.sha256" ]; then
    EXPECTED_ARCHIVE_SHA="$(awk 'NR==1 {print $1}' "${MIGRATION_ARCHIVE}.sha256")"
    [[ "$EXPECTED_ARCHIVE_SHA" =~ ^[a-f0-9]{64}$ ]] \
      || otto_die "迁移包旁路 SHA-256 格式无效" 5
    [ "$EXPECTED_ARCHIVE_SHA" = "$ACTUAL_ARCHIVE_SHA" ] \
      || otto_die "迁移包 SHA-256 与旁路校验文件不一致" 5
  else
    otto_warn "迁移包旁边没有 .sha256；仍会校验包内数据库 hash"
  fi

  ARCHIVE_LIST="${TXN_DIR}/migration-entries.txt"
  ARCHIVE_VERBOSE="${TXN_DIR}/migration-entries.verbose.txt"
  tar -tzf "$STAGED_MIGRATION" > "$ARCHIVE_LIST"
  tar --numeric-owner -tvzf "$STAGED_MIGRATION" > "$ARCHIVE_VERBOSE"
  while IFS= read -r entry; do
    case "$entry" in
      migration/|migration/data.db|migration/manifest.json) ;;
      *) otto_die "迁移包包含不允许的路径：${entry}" 5 ;;
    esac
  done < "$ARCHIVE_LIST"
  [ "$(wc -l < "$ARCHIVE_LIST" | tr -d '[:space:]')" = "3" ] \
    && [ "$(awk '$0=="migration/" {n++} END {print n+0}' "$ARCHIVE_LIST")" = "1" ] \
    && [ "$(awk '$0=="migration/data.db" {n++} END {print n+0}' "$ARCHIVE_LIST")" = "1" ] \
    && [ "$(awk '$0=="migration/manifest.json" {n++} END {print n+0}' "$ARCHIVE_LIST")" = "1" ] \
    || otto_die "迁移包必须且只能包含一个目录、一个 data.db 和一个 manifest.json" 5
  if awk 'substr($1,1,1)!="d" && substr($1,1,1)!="-" {bad=1} END {exit !bad}' \
    "$ARCHIVE_VERBOSE"; then
    otto_die "迁移包包含非常规文件、链接或设备节点" 5
  fi
  DB_UNCOMPRESSED_SIZE="$(awk '$NF=="migration/data.db" {print (NF >= 9 ? $5 : $3)}' "$ARCHIVE_VERBOSE")"
  MANIFEST_UNCOMPRESSED_SIZE="$(awk '$NF=="migration/manifest.json" {print (NF >= 9 ? $5 : $3)}' "$ARCHIVE_VERBOSE")"
  [[ "$DB_UNCOMPRESSED_SIZE" =~ ^[0-9]+$ ]] \
    && [ "$DB_UNCOMPRESSED_SIZE" -gt 0 ] \
    || otto_die "迁移数据库的归档尺寸无效" 5
  [[ "$MANIFEST_UNCOMPRESSED_SIZE" =~ ^[0-9]+$ ]] \
    && [ "$MANIFEST_UNCOMPRESSED_SIZE" -gt 0 ] \
    && [ "$MANIFEST_UNCOMPRESSED_SIZE" -le 1048576 ] \
    || otto_die "迁移 manifest 为空或超过 1 MiB" 5
  REQUIRED_IMPORT_BYTES="$((DB_UNCOMPRESSED_SIZE * 4 + 536870912))"
  AVAILABLE_BYTES="$((AVAILABLE_KB * 1024))"
  [ "$REQUIRED_IMPORT_BYTES" -le "$AVAILABLE_BYTES" ] \
    || otto_die "迁移数据库解压后空间不足：预计至少需要 ${REQUIRED_IMPORT_BYTES} 字节" 5
  mkdir -p "${TXN_DIR}/import"
  tar -xzf "$STAGED_MIGRATION" -C "${TXN_DIR}/import"
  MIGRATION_DB="${TXN_DIR}/import/migration/data.db"
  MIGRATION_MANIFEST="${TXN_DIR}/import/migration/manifest.json"
  [ -f "$MIGRATION_DB" ] && [ -f "$MIGRATION_MANIFEST" ] \
    || otto_die "迁移包缺少 data.db 或 manifest.json" 5
  [ ! -L "$MIGRATION_DB" ] && [ ! -L "$MIGRATION_MANIFEST" ] \
    || otto_die "迁移包解压后包含符号链接" 5
  ACTUAL_DB_SIZE="$(stat -c %s "$MIGRATION_DB" 2>/dev/null || stat -f %z "$MIGRATION_DB")"
  ACTUAL_MANIFEST_SIZE="$(stat -c %s "$MIGRATION_MANIFEST" 2>/dev/null || stat -f %z "$MIGRATION_MANIFEST")"
  [ "$ACTUAL_DB_SIZE" = "$DB_UNCOMPRESSED_SIZE" ] \
    && [ "$ACTUAL_MANIFEST_SIZE" = "$MANIFEST_UNCOMPRESSED_SIZE" ] \
    || otto_die "迁移包声明尺寸与解压结果不一致" 5
  "$NODE_PATH" --input-type=module - "$MIGRATION_MANIFEST" <<'NODE'
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (
  manifest.format !== 'otto-enterprise-migration-v1'
  || !/^[a-f0-9]{64}$/.test(manifest.database?.sha256 ?? '')
) {
  throw new Error('migration manifest format/hash is invalid');
}
NODE
  IMPORT_INFO="$("$NODE_PATH" "${SCRIPT_DIR}/tools/db-tool.mjs" inspect "$MIGRATION_DB")"
  IMPORT_SCHEMA="$("$NODE_PATH" -e \
    "const x=JSON.parse(process.argv[1]);console.log(x.userVersion)" "$IMPORT_INFO")"
  [ "$IMPORT_SCHEMA" -ge 2 ] && [ "$IMPORT_SCHEMA" -le "$RELEASE_SCHEMA_TO" ] \
    || otto_die "本迁入包只接受 schema 2 至 ${RELEASE_SCHEMA_TO}，迁移包为 schema ${IMPORT_SCHEMA}；请先在旧服务器走受控升级" 5
  EXPECTED_DB_SHA="$("$NODE_PATH" -e \
    "const x=require(process.argv[1]);console.log(x.database.sha256)" "$MIGRATION_MANIFEST")"
  ACTUAL_DB_SHA="$("$NODE_PATH" -e \
    "const x=JSON.parse(process.argv[1]);console.log(x.sha256)" "$IMPORT_INFO")"
  [ "$EXPECTED_DB_SHA" = "$ACTUAL_DB_SHA" ] \
    || otto_die "迁移包内数据库 SHA-256 与 manifest 不一致" 5
fi

CANARY_DIR="${TXN_DIR}/canary"
mkdir -p "$CANARY_DIR"
if [ -n "$MIGRATION_DB" ]; then
  cp "$MIGRATION_DB" "${CANARY_DIR}/data.db"
fi

export OTTO_ENTERPRISE_DIR="$CANARY_DIR"
export OTTO_ENTERPRISE_HOST="127.0.0.1"
export OTTO_ENTERPRISE_PORT="17777"
export OTTO_ENTERPRISE_PUBLIC_URL
export OTTO_ENTERPRISE_ADMIN_TOKEN
export OTTO_ENTERPRISE_TRUST_PROXY_HOPS="1"
export OTTO_APP_VERSION="$RELEASE_VERSION"
export OTTO_BUILD_COMMIT="$BUILD_ID"
export ALIYUN_SMS_PROVIDER="${ALIYUN_SMS_PROVIDER:-pnvs}"

"$NODE_PATH" "${SCRIPT_DIR}/tools/migrate-check.mjs" "${SCRIPT_DIR}/release" "$CANARY_DIR"
MIGRATED_INFO="$("$NODE_PATH" "${SCRIPT_DIR}/tools/db-tool.mjs" inspect "${CANARY_DIR}/data.db")"
if [ -n "$MIGRATION_DB" ]; then
  "$NODE_PATH" "${SCRIPT_DIR}/tools/db-tool.mjs" \
    compare "$MIGRATION_DB" "${CANARY_DIR}/data.db" >/dev/null
fi

ACCOUNT_COUNT="$("$NODE_PATH" -e \
  "const x=JSON.parse(process.argv[1]);console.log(x.rowCounts.accounts||0)" "$MIGRATED_INFO")"
if [ "$OTTO_ENTERPRISE_ADMIN_TOKEN" != "auto" ]; then
  [ "${#OTTO_ENTERPRISE_ADMIN_TOKEN}" -ge 32 ] \
    || otto_die "OTTO_ENTERPRISE_ADMIN_TOKEN 至少 32 个字符" 3
fi
if [ "$ACCOUNT_COUNT" -eq 0 ] && [ "$OTTO_BOOTSTRAP_PASSWORD" != "auto" ]; then
  [ "${#OTTO_BOOTSTRAP_PASSWORD}" -ge 8 ] \
    || otto_die "空库的 OTTO_BOOTSTRAP_PASSWORD 至少 8 个字符" 3
fi

if [ "$DRY_RUN" -eq 1 ]; then
  otto_log "dry-run 深度校验通过：包清单、release、迁移归档、SQLite、schema 与数据对账均通过"
  printf '  迁移后账号数：%s\n' "$ACCOUNT_COUNT"
  otto_log "未创建用户，未写 /etc、/opt 或 /var/lib，未启动或重启服务"
  exit 0
fi

if [ ! -d "$INSTALL_ROOT" ]; then
  mkdir -p "$INSTALL_ROOT"
  INSTALL_ROOT_CREATED=1
fi
TRANSACTION_MARKER_CREATED=1
printf 'transaction=%s\nbuild=%s\nstartedAt=%s\n' \
  "$TRANSACTION_ID" "$BUILD_ID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$TRANSACTION_MARKER"
chmod 0600 "$TRANSACTION_MARKER"

if ! command -v curl >/dev/null 2>&1 \
  || [ ! -r /etc/ssl/certs/ca-certificates.crt ]; then
  otto_log "安装固定 Node.js runtime 所需的 curl 与 CA 证书"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl
fi

RUNTIME_ARCH="$(otto_arch)"
TEMP_RUNTIME_DIR="${TXN_DIR}/runtime/node-v${OTTO_NODE_VERSION}-linux-${RUNTIME_ARCH}"
mkdir -p "${INSTALL_ROOT}/runtime"
NODE_RUNTIME_DIR="${INSTALL_ROOT}/runtime/node-v${OTTO_NODE_VERSION}-linux-${RUNTIME_ARCH}"
RUNTIME_DIR_CREATED=1
if [ -x "${TEMP_RUNTIME_DIR}/bin/node" ]; then
  cp -a "$TEMP_RUNTIME_DIR" "${INSTALL_ROOT}/runtime/"
  NODE_PATH="${INSTALL_ROOT}/runtime/$(basename -- "$TEMP_RUNTIME_DIR")/bin/node"
else
  NODE_PATH="$(otto_install_node_runtime "${INSTALL_ROOT}/runtime")"
fi
NODE_RUNTIME_DIR="$(dirname -- "$(dirname -- "$NODE_PATH")")"
[ "$("$NODE_PATH" --version)" = "v${OTTO_NODE_VERSION}" ] \
  || otto_die "安装后的固定 Node runtime 版本不正确" 3
[ ! -e "${INSTALL_ROOT}/runtime/current" ] \
  && [ ! -L "${INSTALL_ROOT}/runtime/current" ] \
  || otto_die "runtime/current 已存在，拒绝覆盖" 3
ln -s "$NODE_RUNTIME_DIR" "${INSTALL_ROOT}/runtime/current"
RUNTIME_LINK_CREATED=1

mkdir -p "${INSTALL_ROOT}/releases"
if [ -e "$TARGET_RELEASE" ] || [ -L "$TARGET_RELEASE" ]; then
  otto_die "目标 release 目录已存在但未被 current 管理：${TARGET_RELEASE}" 3
fi
cp -a "${SCRIPT_DIR}/release" "$TARGET_RELEASE"
TARGET_RELEASE_CREATED=1
chown root:root "$INSTALL_ROOT" "${INSTALL_ROOT}/runtime" "${INSTALL_ROOT}/releases"
chown -R root:root "${INSTALL_ROOT}/runtime" "$TARGET_RELEASE"
otto_prepare_service_layout "$INSTALL_ROOT" "$TARGET_RELEASE"
"$NODE_PATH" "${SCRIPT_DIR}/tools/verify-release.mjs" "$TARGET_RELEASE" >/dev/null
export OTTO_LICENSE_TRUST_FILE="${TARGET_RELEASE}/license-public-keys.json"

mkdir -p "${INSTALL_ROOT}/deploy"
DEPLOY_CREATED=1
cp -a "${SCRIPT_DIR}/tools" "${INSTALL_ROOT}/deploy/"
cp -a "${SCRIPT_DIR}/lib" "${INSTALL_ROOT}/deploy/"
cp -a "${SCRIPT_DIR}/verify.sh" "${INSTALL_ROOT}/deploy/verify.sh"
cp -a "${SCRIPT_DIR}/backup-now.sh" "${INSTALL_ROOT}/deploy/backup-now.sh"
cp -a "${SCRIPT_DIR}/restore-backup.sh" "${INSTALL_ROOT}/deploy/restore-backup.sh"
chmod 755 \
  "${INSTALL_ROOT}/deploy/verify.sh" \
  "${INSTALL_ROOT}/deploy/backup-now.sh" \
  "${INSTALL_ROOT}/deploy/restore-backup.sh"

if [ "$OTTO_ENTERPRISE_ADMIN_TOKEN" = "auto" ]; then
  OTTO_ENTERPRISE_ADMIN_TOKEN="$(otto_random_secret "$NODE_PATH")"
fi
if [ "$OTTO_BACKUP_ENCRYPTION_KEY" = "auto" ]; then
  OTTO_BACKUP_ENCRYPTION_KEY="$($NODE_PATH --input-type=module -e \
    "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('base64'))")"
fi
"$NODE_PATH" --input-type=module -e \
  "const value = process.argv[1]; const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64'); if (key.length !== 32) process.exit(1)" \
  "$OTTO_BACKUP_ENCRYPTION_KEY" \
  || otto_die "OTTO_BACKUP_ENCRYPTION_KEY 必须是 32 字节 Base64 或 64 位十六进制密钥"
[ "${#OTTO_ENTERPRISE_ADMIN_TOKEN}" -ge 32 ] \
  || otto_die "OTTO_ENTERPRISE_ADMIN_TOKEN 至少 32 个字符"
export OTTO_ENTERPRISE_ADMIN_TOKEN

if [ "$ACCOUNT_COUNT" -eq 0 ]; then
  otto_log "迁移库没有账号，创建首个管理员"
  if [ "$OTTO_BOOTSTRAP_PASSWORD" = "auto" ]; then
    OTTO_BOOTSTRAP_PASSWORD="$(otto_random_secret "$NODE_PATH")"
    BOOTSTRAP_CREDENTIALS="${TXN_DIR}/bootstrap-credentials.txt"
    printf 'username=%s\npassword=%s\n' \
      "$OTTO_BOOTSTRAP_USERNAME" "$OTTO_BOOTSTRAP_PASSWORD" > "$BOOTSTRAP_CREDENTIALS"
    chmod 600 "$BOOTSTRAP_CREDENTIALS"
  fi
  [ "${#OTTO_BOOTSTRAP_PASSWORD}" -ge 8 ] \
    || otto_die "OTTO_BOOTSTRAP_PASSWORD 至少 8 个字符"
  export OTTO_BOOTSTRAP_USERNAME OTTO_BOOTSTRAP_PASSWORD OTTO_BOOTSTRAP_NAME
  "$NODE_PATH" "${TARGET_RELEASE}/src/enterprise/bin.js" --bootstrap-admin
  "$NODE_PATH" "${SCRIPT_DIR}/tools/db-tool.mjs" inspect "${CANARY_DIR}/data.db" >/dev/null
fi

otto_log "启动 127.0.0.1:17777 隔离 canary"
env \
  -u OTTO_CONTROL_URL \
  -u OTTO_CONTROL_ORIGIN \
  -u OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE \
  "$NODE_PATH" "${TARGET_RELEASE}/run.mjs" >"${TXN_DIR}/canary.log" 2>&1 &
CANARY_PID=$!
canary_cleanup() {
  if kill -0 "$CANARY_PID" >/dev/null 2>&1; then
    kill -TERM "$CANARY_PID" >/dev/null 2>&1 || true
    wait "$CANARY_PID" || true
  fi
  CANARY_PID=""
}
CANARY_OK=0
for _ in $(seq 1 20); do
  if "$NODE_PATH" "${SCRIPT_DIR}/tools/health-check.mjs" \
    http://127.0.0.1:17777 "$RELEASE_VERSION" "$BUILD_ID" \
    "$RELEASE_SCHEMA_TO" \
    "$([ "$OTTO_ALLOW_SMS_DISABLED" = "1" ] && printf 'allow-sms-disabled' || printf 'require-sms')" \
    allow-unactivated-deployment \
    >/dev/null 2>&1; then
    CANARY_OK=1
    break
  fi
  sleep 0.5
done
[ "$CANARY_OK" -eq 1 ] || {
  sed -n '1,120p' "${TXN_DIR}/canary.log" >&2
  otto_die "隔离 canary 未通过" 5
}
canary_cleanup

if ! id otto-enterprise >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin \
    --user-group otto-enterprise
fi
for key_path in \
  "$OTTO_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE" \
  "$OTTO_ATTACHMENT_ENCRYPTION_KEY_FILE" \
  "$OTTO_FIELD_ENCRYPTION_KEY_FILE"; do
  [ -z "$key_path" ] && continue
  runuser -u otto-enterprise -- test -r "$key_path" \
    || otto_die "otto-enterprise 服务账号无法读取外部加密密钥：${key_path}"
done
mkdir -p "$DATA_DIR" "$CONFIG_DIR"
chown otto-enterprise:otto-enterprise "$DATA_DIR"
chmod 0700 "$DATA_DIR"
if [ -n "$OTTO_BACKUP_REPLICA_DIR" ]; then
  mkdir -p "$OTTO_BACKUP_REPLICA_DIR"
  chown otto-enterprise:otto-enterprise "$OTTO_BACKUP_REPLICA_DIR"
  chmod 0700 "$OTTO_BACKUP_REPLICA_DIR"
fi
install -o otto-enterprise -g otto-enterprise -m 0600 \
  "${CANARY_DIR}/data.db" "${DATA_DIR}/data.db"
DATA_CREATED=1

if [ -n "$BOOTSTRAP_SECRET_STAGED" ]; then
  BOOTSTRAP_SECRET_TARGET="${CONFIG_DIR}/deployment-bootstrap-secret"
  if [ -e "$BOOTSTRAP_SECRET_TARGET" ] || [ -L "$BOOTSTRAP_SECRET_TARGET" ]; then
    [ -f "$BOOTSTRAP_SECRET_TARGET" ] && [ ! -L "$BOOTSTRAP_SECRET_TARGET" ] \
      || otto_die "已有部署登记密钥不是普通文件，拒绝替换"
    BOOTSTRAP_SECRET_BACKUP="${TXN_DIR}/previous-deployment-bootstrap-secret"
    mv "$BOOTSTRAP_SECRET_TARGET" "$BOOTSTRAP_SECRET_BACKUP"
    chmod 0600 "$BOOTSTRAP_SECRET_BACKUP"
    BOOTSTRAP_SECRET_REPLACED=1
  fi
  install -o otto-enterprise -g otto-enterprise -m 0600 \
    "$BOOTSTRAP_SECRET_STAGED" "$BOOTSTRAP_SECRET_TARGET"
  BOOTSTRAP_SECRET_CREATED=1
  rm -f "$BOOTSTRAP_SECRET_STAGED"
  BOOTSTRAP_SECRET_STAGED=""
fi

write_env() {
  local output="$1"
  : > "$output"
  chmod 600 "$output"
  while [ "$#" -gt 1 ]; do
    local key="$2"
    local value="$3"
    shift 2
    [[ "$value" != *$'\n'* ]] || otto_die "环境变量 ${key} 不能包含换行"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    printf '%s="%s"\n' "$key" "$value" >> "$output"
  done
}

ENV_TEMP="${TXN_DIR}/enterprise.env"
write_env "$ENV_TEMP" \
  OTTO_ENTERPRISE_DIR "$DATA_DIR" \
  OTTO_ENTERPRISE_HOST "127.0.0.1" \
  OTTO_ENTERPRISE_PORT "7778" \
  OTTO_ENTERPRISE_PUBLIC_URL "$OTTO_ENTERPRISE_PUBLIC_URL" \
  OTTO_ENTERPRISE_ADMIN_TOKEN "$OTTO_ENTERPRISE_ADMIN_TOKEN" \
  OTTO_ENTERPRISE_TRUST_PROXY_HOPS "1" \
  OTTO_APP_VERSION "$RELEASE_VERSION" \
  OTTO_BUILD_COMMIT "$BUILD_ID" \
  OTTO_BACKUP_ENCRYPTION_KEY "$OTTO_BACKUP_ENCRYPTION_KEY" \
  OTTO_BACKUP_INTERVAL_HOURS "$OTTO_BACKUP_INTERVAL_HOURS" \
  OTTO_BACKUP_RETENTION_DAYS "$OTTO_BACKUP_RETENTION_DAYS" \
  OTTO_BACKUP_MINIMUM_RETAINED "$OTTO_BACKUP_MINIMUM_RETAINED" \
  OTTO_BACKUP_REPLICA_DIR "$OTTO_BACKUP_REPLICA_DIR" \
  OTTO_DISK_MIN_FREE_MB "$OTTO_DISK_MIN_FREE_MB" \
  OTTO_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE "$OTTO_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE" \
  OTTO_ATTACHMENT_ENCRYPTION_KEY_FILE "$OTTO_ATTACHMENT_ENCRYPTION_KEY_FILE" \
  OTTO_FIELD_ENCRYPTION_KEY_FILE "$OTTO_FIELD_ENCRYPTION_KEY_FILE" \
  OTTO_CONTROL_URL "$OTTO_CONTROL_URL" \
  OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE "$BOOTSTRAP_SECRET_TARGET" \
  OTTO_DEPLOYMENT_KIND "$OTTO_DEPLOYMENT_KIND" \
  OTTO_TELEMETRY_ENDPOINT "$OTTO_TELEMETRY_ENDPOINT" \
  OTTO_TELEMETRY_RETENTION_DAYS "$OTTO_TELEMETRY_RETENTION_DAYS" \
  OTTO_FEDERATION_ENABLED "$OTTO_FEDERATION_ENABLED" \
  OTTO_FEDERATION_GATEWAY_URL "$OTTO_FEDERATION_GATEWAY_URL" \
  OTTO_FEDERATION_DISPLAY_NAME "$OTTO_FEDERATION_DISPLAY_NAME" \
  OTTO_FEDERATION_POLL_INTERVAL_MS "$OTTO_FEDERATION_POLL_INTERVAL_MS" \
  OTTO_FEDERATION_SIGNING_KEY_FILE "$OTTO_FEDERATION_SIGNING_KEY_FILE" \
  OTTO_DATA_CONTROLLER_NAME "$OTTO_DATA_CONTROLLER_NAME" \
  OTTO_PRIVACY_CONTACT "$OTTO_PRIVACY_CONTACT" \
  OTTO_LEGAL_DOCUMENTS_APPROVED "$OTTO_LEGAL_DOCUMENTS_APPROVED" \
  OTTO_DATA_REGION "$OTTO_DATA_REGION" \
  OTTO_DATA_RESIDENCY "$OTTO_DATA_RESIDENCY" \
  OTTO_STORAGE_VOLUME_ENCRYPTED "$OTTO_STORAGE_VOLUME_ENCRYPTED" \
  OTTO_CROSS_BORDER_DATA_ENABLED "$OTTO_CROSS_BORDER_DATA_ENABLED" \
  ALIYUN_SMS_PROVIDER "${ALIYUN_SMS_PROVIDER:-pnvs}" \
  ALIYUN_SMS_ACCESS_KEY_ID "${ALIYUN_SMS_ACCESS_KEY_ID:-}" \
  ALIYUN_SMS_ACCESS_KEY_SECRET "${ALIYUN_SMS_ACCESS_KEY_SECRET:-}" \
  ALIYUN_SMS_SIGN_NAME "${ALIYUN_SMS_SIGN_NAME:-}" \
  ALIYUN_SMS_TEMPLATE_ID "${ALIYUN_SMS_TEMPLATE_ID:-}" \
  ALIYUN_SMS_NOTIFICATION_TEMPLATE_ID "${ALIYUN_SMS_NOTIFICATION_TEMPLATE_ID:-}" \
  OTTO_ENTERPRISE_FEISHU_APP_ID "${OTTO_ENTERPRISE_FEISHU_APP_ID:-}" \
  OTTO_ENTERPRISE_FEISHU_APP_SECRET "${OTTO_ENTERPRISE_FEISHU_APP_SECRET:-}" \
  OTTO_ENTERPRISE_FEISHU_DOMAIN "${OTTO_ENTERPRISE_FEISHU_DOMAIN:-}" \
  OTTO_DEFAULT_ORGANIZATION_NAME "${OTTO_DEFAULT_ORGANIZATION_NAME:-Otto 企业}" \
  OTTO_ENTERPRISE_USAGE_DAILY_LIMIT "${OTTO_ENTERPRISE_USAGE_DAILY_LIMIT:-10000}" \
  OTTO_CREDIT_TOKEN_RATE "${OTTO_CREDIT_TOKEN_RATE:-1000000}" \
  OTTO_ESTIMATE_MANUAL_MULT "${OTTO_ESTIMATE_MANUAL_MULT:-2}" \
  OTTO_ESTIMATE_CNY_PER_HOUR "${OTTO_ESTIMATE_CNY_PER_HOUR:-50}" \
  OTTO_ESTIMATE_LABOR_PER_TOKEN_CAP "${OTTO_ESTIMATE_LABOR_PER_TOKEN_CAP:-50}"
install -o root -g root -m 0600 "$ENV_TEMP" "${CONFIG_DIR}/enterprise.env"
CONFIG_CREATED=1

[ ! -e "${INSTALL_ROOT}/current.next" ] && [ ! -L "${INSTALL_ROOT}/current.next" ] \
  || otto_die "临时 current.next 路径已存在，拒绝覆盖" 3
ln -s "$TARGET_RELEASE" "${INSTALL_ROOT}/current.next"
mv -T "${INSTALL_ROOT}/current.next" "${INSTALL_ROOT}/current"
CURRENT_CREATED=1
install -o root -g root -m 0644 \
  "${SCRIPT_DIR}/templates/otto-enterprise.service" "$SERVICE_UNIT"
CREATED_SERVICE=1
systemctl daemon-reload

if [ "$OTTO_CADDY_MODE" = "managed" ]; then
  if ! command -v caddy >/dev/null 2>&1; then
    otto_log "安装 Caddy 官方 Ubuntu 软件包"
    apt-get update
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
    curl -1sLf --max-time 60 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf --max-time 60 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      -o /etc/apt/sources.list.d/caddy-stable.list
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    chmod o+r /etc/apt/sources.list.d/caddy-stable.list
    apt-get update
    apt-get install -y caddy
  fi
  mkdir -p /etc/caddy
  if [ -f "$CADDY_MAIN" ]; then
    CADDY_MAIN_BACKUP="${TXN_DIR}/Caddyfile.before"
    cp -p "$CADDY_MAIN" "$CADDY_MAIN_BACKUP"
  else
    : > "$CADDY_MAIN"
  fi
  if [ -f "$CADDY_FRAGMENT" ]; then
    CADDY_FRAGMENT_BACKUP="${TXN_DIR}/otto-enterprise.caddy.before"
    cp -p "$CADDY_FRAGMENT" "$CADDY_FRAGMENT_BACKUP"
  else
    : > "${TXN_DIR}/created-caddy-fragment"
  fi
  if grep -Fq "${OTTO_PUBLIC_HOST}:${OTTO_PUBLIC_PORT}" "$CADDY_MAIN"; then
    otto_die "主 Caddyfile 已包含同一站点，拒绝制造重复路由" 3
  fi
  sed \
    -e "s/__OTTO_PUBLIC_HOST__/${OTTO_PUBLIC_HOST}/g" \
    -e "s/__OTTO_PUBLIC_PORT__/${OTTO_PUBLIC_PORT}/g" \
    "${SCRIPT_DIR}/templates/otto-enterprise.caddy" > "${TXN_DIR}/otto-enterprise.caddy"
  install -o root -g caddy -m 0644 \
    "${TXN_DIR}/otto-enterprise.caddy" "$CADDY_FRAGMENT"
  if ! grep -Fxq "import ${CADDY_FRAGMENT}" "$CADDY_MAIN"; then
    printf '\n# Otto Enterprise managed import\nimport %s\n' "$CADDY_FRAGMENT" >> "$CADDY_MAIN"
  fi
  caddy validate --config "$CADDY_MAIN" --adapter caddyfile
fi

systemctl enable --now otto-enterprise
OTTO_ALLOW_SMS_DISABLED="$OTTO_ALLOW_SMS_DISABLED" "${INSTALL_ROOT}/deploy/verify.sh"

if [ "$OTTO_CADDY_MODE" = "managed" ]; then
  systemctl reload caddy
  EDGE_OK=0
  for _ in $(seq 1 30); do
    if "$NODE_PATH" "${SCRIPT_DIR}/tools/health-check.mjs" \
      "$OTTO_ENTERPRISE_PUBLIC_URL" "$RELEASE_VERSION" "$BUILD_ID" \
      "$RELEASE_SCHEMA_TO" \
      "$([ "$OTTO_ALLOW_SMS_DISABLED" = "1" ] && printf 'allow-sms-disabled' || printf 'require-sms')" \
      >/dev/null 2>&1; then
      EDGE_OK=1
      break
    fi
    sleep 2
  done
  [ "$EDGE_OK" -eq 1 ] \
    || otto_die "公网 HTTPS 验收失败；请检查 DNS、80/443/7777 安全组和 Caddy 日志" 5
  for blocked in \
    /enterprise/local-agent \
    /enterprise/local-agent/pair \
    /enterprise/sdk/otto-discovery.js; do
    STATUS="$(curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' \
      "${OTTO_ENTERPRISE_PUBLIC_URL}${blocked}")"
    [ "$STATUS" = "404" ] \
      || otto_die "未完成功能没有在公网屏蔽：${blocked} -> HTTP ${STATUS}" 5
  done
fi

if [ -f "${TXN_DIR}/bootstrap-credentials.txt" ]; then
  install -o root -g root -m 0600 \
    "${TXN_DIR}/bootstrap-credentials.txt" \
    "/root/otto-enterprise-bootstrap-${TRANSACTION_ID}.txt"
  BOOTSTRAP_CREDENTIALS_FINAL="/root/otto-enterprise-bootstrap-${TRANSACTION_ID}.txt"
else
  BOOTSTRAP_CREDENTIALS_FINAL=""
fi

if [ "$BOOTSTRAP_SECRET_REPLACED" -eq 1 ]; then
  rm -f "$BOOTSTRAP_SECRET_BACKUP"
  BOOTSTRAP_SECRET_REPLACED=0
fi

rm -f "$TRANSACTION_MARKER"
TRANSACTION_MARKER_CREATED=0
INSTALL_COMMITTED=1
if [ "$OTTO_CADDY_MODE" = "managed" ]; then
  otto_log "安装、迁移、本机服务与公网 HTTPS 验收全部通过"
else
  otto_log "安装、迁移与本机 systemd/health 验收通过"
  otto_warn "external 模式未验证外置 HTTPS、证书或三个公网 404 屏蔽路径；当前结果不代表公网交付完成"
fi
printf '  版本：%s\n  构建 ID：%s\n  本机后端：http://127.0.0.1:7778\n' \
  "$RELEASE_VERSION" "$BUILD_ID"
if [ "$OTTO_CADDY_MODE" = "managed" ]; then
  printf '  已验收公网入口：%s\n' "$OTTO_ENTERPRISE_PUBLIC_URL"
else
  printf '  待外置代理验收入口：%s\n' "$OTTO_ENTERPRISE_PUBLIC_URL"
fi
if [ -n "$BOOTSTRAP_CREDENTIALS_FINAL" ]; then
  printf '  首次管理员凭据：%s（登录后请立即删除）\n' "$BOOTSTRAP_CREDENTIALS_FINAL"
fi
printf '  下一步：确认云安全组开放 TCP 80、443、%s；然后用真实客户端完成邀请码注册与组织树验收。\n' \
  "$OTTO_PUBLIC_PORT"
