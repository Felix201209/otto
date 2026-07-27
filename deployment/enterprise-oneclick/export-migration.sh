#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

DATA_DIR="/var/lib/otto-enterprise"
OUTPUT=""
DRY_RUN=0

usage() {
  cat <<'EOF'
用法：
  ./export-migration.sh [--data-dir /var/lib/otto-enterprise] \
    --output /安全目录/otto-enterprise-migration.tar.gz [--dry-run]

只导出 SQLite 一致性快照和非敏感校验清单，不导出短信密钥、平台令牌或配置。
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --data-dir)
      [ "$#" -ge 2 ] || otto_die "--data-dir 缺少值"
      DATA_DIR="$2"
      shift 2
      ;;
    --output)
      [ "$#" -ge 2 ] || otto_die "--output 缺少值"
      OUTPUT="$2"
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

[ -n "$OUTPUT" ] || otto_die "必须明确提供 --output；空目标绝不回退到默认目录"
case "$OUTPUT" in
  /*) ;;
  *) otto_die "--output 必须是绝对路径" ;;
esac
DB_PATH="${DATA_DIR%/}/data.db"
[ -f "$DB_PATH" ] || otto_die "找不到数据库：${DB_PATH}" 3
[ ! -L "$DB_PATH" ] || otto_die "数据库不能是符号链接：${DB_PATH}" 3
[ ! -e "$OUTPUT" ] || otto_die "输出已存在，拒绝覆盖：${OUTPUT}"
[ ! -e "${OUTPUT}.sha256" ] || otto_die "校验文件已存在，拒绝覆盖：${OUTPUT}.sha256"

otto_log "导出计划"
printf '  数据库：%s\n  输出：%s\n  模式：SQLite Online Backup\n' "$DB_PATH" "$OUTPUT"
if [ "$DRY_RUN" -eq 1 ]; then
  otto_log "dry-run 完成：没有写入文件、没有停止服务"
  exit 0
fi

mkdir -p "$(dirname -- "$OUTPUT")"
TEMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT
mkdir -p "${TEMP_DIR}/migration"

PREFERRED_NODE="/opt/otto-enterprise/runtime/current/bin/node"
if ! NODE_PATH="$(otto_resolve_node "$PREFERRED_NODE")"; then
  NODE_PATH="$(otto_install_node_runtime "${TEMP_DIR}/runtime")"
fi

otto_log "创建在线一致性快照（服务无需停止）"
"$NODE_PATH" "${SCRIPT_DIR}/tools/db-tool.mjs" \
  backup "$DB_PATH" "${TEMP_DIR}/migration/data.db" \
  > "${TEMP_DIR}/inspection.json"

SOURCE_SCHEMA="$("$NODE_PATH" -e \
  "const x=require(process.argv[1]);console.log(x.userVersion)" \
  "${TEMP_DIR}/inspection.json")"
case "$SOURCE_SCHEMA" in
  2|3|4|5|6|7|8|9|10|11) ;;
  *) otto_die "本迁入包只支持导出 schema 2 至 11，检测到 schema ${SOURCE_SCHEMA}；请先走受控升级" 5 ;;
esac

"$NODE_PATH" --input-type=module - \
  "${TEMP_DIR}/inspection.json" "${TEMP_DIR}/migration/manifest.json" <<'NODE'
import { readFile, writeFile } from 'node:fs/promises';
const [input, output] = process.argv.slice(2);
const inspection = JSON.parse(await readFile(input, 'utf8'));
delete inspection.path;
await writeFile(output, JSON.stringify({
  format: 'otto-enterprise-migration-v1',
  exportedAt: new Date().toISOString(),
  database: inspection,
}, null, 2) + '\n', { mode: 0o600 });
NODE

# 数据库启用 WAL 时，只读自检也可能留下空 WAL/SHM 辅助文件。
# 归档显式列出三个协议条目，避免把运行时旁路文件带到新服务器。
tar --no-recursion -czf "$OUTPUT" -C "$TEMP_DIR" \
  migration/ migration/data.db migration/manifest.json
chmod 600 "$OUTPUT"
ARCHIVE_SHA="$(otto_sha256 "$OUTPUT")"
printf '%s  %s\n' "$ARCHIVE_SHA" "$(basename -- "$OUTPUT")" > "${OUTPUT}.sha256"
chmod 600 "${OUTPUT}.sha256"

otto_log "导出完成"
printf '  迁移包：%s\n  SHA-256：%s\n  校验文件：%s\n' \
  "$OUTPUT" "$ARCHIVE_SHA" "${OUTPUT}.sha256"
