#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

CONFIG_PATH="${OTTO_CONFIG_PATH:-/etc/otto-enterprise/enterprise.env}"
[ -f "$CONFIG_PATH" ] && otto_load_config "$CONFIG_PATH"

INSTALL_ROOT="${OTTO_INSTALL_ROOT:-/opt/otto-enterprise}"
CURRENT="${INSTALL_ROOT}/current"
RUNTIME_NODE="${INSTALL_ROOT}/runtime/current/bin/node"
DATA_DB="${OTTO_ENTERPRISE_DIR:-${OTTO_DATA_DIR:-/var/lib/otto-enterprise}}/data.db"
ALLOW_SMS="${OTTO_ALLOW_SMS_DISABLED:-0}"

[ -x "$RUNTIME_NODE" ] || otto_die "找不到固定 Node runtime：${RUNTIME_NODE}" 3
[ -d "$CURRENT" ] || otto_die "找不到 current release：${CURRENT}" 3

RELEASE_JSON="$("$RUNTIME_NODE" "${SCRIPT_DIR}/tools/verify-release.mjs" "$CURRENT")"
VERSION="$("$RUNTIME_NODE" -e "const x=JSON.parse(process.argv[1]);console.log(x.version)" "$RELEASE_JSON")"
BUILD_ID="$("$RUNTIME_NODE" -e "const x=JSON.parse(process.argv[1]);console.log(x.buildCommit)" "$RELEASE_JSON")"
SCHEMA_TO="$("$RUNTIME_NODE" -e "const x=JSON.parse(process.argv[1]);console.log(x.database.schemaTo)" "$RELEASE_JSON")"

"$RUNTIME_NODE" "${SCRIPT_DIR}/tools/db-tool.mjs" inspect "$DATA_DB" >/dev/null
"$RUNTIME_NODE" "${SCRIPT_DIR}/tools/health-check.mjs" \
  http://127.0.0.1:7778 "$VERSION" "$BUILD_ID" \
  "$SCHEMA_TO" \
  "$([ "$ALLOW_SMS" = "1" ] && printf 'allow-sms-disabled' || printf 'require-sms')"

if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet otto-enterprise \
    || otto_die "systemd 服务未处于 active" 5
fi

otto_log "本机验收通过：release、SQLite、health、systemd 均正常"
