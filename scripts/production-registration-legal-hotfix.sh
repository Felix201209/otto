#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_ROOT=/opt/otto-enterprise
SERVICE_NAME=otto-enterprise
EXPECTED_VERSION=1.9.11
RUN_ID="${1:-}"
MODE="${2:-dry-run}"
LOCK_FILE=/run/lock/otto-enterprise-deploy.lock

[[ "$RUN_ID" =~ ^[0-9]+$ ]] || {
  echo '[Otto Hotfix] invalid run id' >&2
  exit 2
}
[[ "$MODE" = dry-run || "$MODE" = apply ]] || {
  echo '[Otto Hotfix] mode must be dry-run or apply' >&2
  exit 2
}

exec 9>"$LOCK_FILE"
flock -n 9 || {
  echo '[Otto Hotfix] another deployment operation is active' >&2
  exit 3
}

NODE="$INSTALL_ROOT/runtime/current/bin/node"
CURRENT_LINK="$INSTALL_ROOT/current"
systemctl is-active --quiet "$SERVICE_NAME"
test -x "$NODE"
test -L "$CURRENT_LINK"
OLD_RELEASE="$(readlink -f -- "$CURRENT_LINK")"
case "$OLD_RELEASE" in
  "$INSTALL_ROOT"/releases/*) ;;
  *) echo '[Otto Hotfix] current release is outside the managed release directory' >&2; exit 3 ;;
esac

SOURCE_FILE="$OLD_RELEASE/src/enterprise/authRoutes.js"
LEGAL_FILE="$OLD_RELEASE/src/modules/data_governance/legalDocuments.js"
test -f "$SOURCE_FILE"
test -f "$LEGAL_FILE"

PUBLIC_HEALTH="$(curl --fail --silent --show-error --max-time 15 \
  http://127.0.0.1:7778/enterprise/health)"
"$NODE" --input-type=module - "$PUBLIC_HEALTH" "$EXPECTED_VERSION" <<'NODE'
const [healthText, expectedVersion] = process.argv.slice(2);
const health = JSON.parse(healthText);
if (health.status !== 'ok' || health.version !== expectedVersion) {
  throw new Error(`unexpected production health: ${health.status}/${health.version}`);
}
NODE

if grep -Fq 'legalDocuments: CURRENT_LEGAL_DOCUMENTS.map' "$SOURCE_FILE"; then
  echo '[Otto Hotfix] registration legal-document response is already patched'
  exit 0
fi

if grep -Fq 'CURRENT_LEGAL_DOCUMENTS' "$SOURCE_FILE"; then
  echo '[Otto Hotfix] unexpected partial hotfix state' >&2
  exit 3
fi
test "$(grep -Fc "import * as db from './db.js';" "$SOURCE_FILE")" -eq 1
test "$(grep -Fc "organization: invite ? { id: organization.id, name: organization.name } : null," "$SOURCE_FILE")" -eq 1
grep -Fq 'export const CURRENT_LEGAL_DOCUMENTS' "$LEGAL_FILE"
grep -Fq 'export function legalDocumentHash' "$LEGAL_FILE"

if [ "$MODE" = dry-run ]; then
  STAGING_ROOT="$(mktemp -d /var/tmp/otto-registration-legal-hotfix.XXXXXX)"
  trap 'rm -rf -- "$STAGING_ROOT"' EXIT
  HOTFIX_RELEASE="$STAGING_ROOT/release"
else
  HOTFIX_RELEASE="$INSTALL_ROOT/releases/$(basename -- "$OLD_RELEASE")-hotfix-registration-legal-$RUN_ID"
  test ! -e "$HOTFIX_RELEASE"
fi

cp -a -- "$OLD_RELEASE" "$HOTFIX_RELEASE"
TARGET_FILE="$HOTFIX_RELEASE/src/enterprise/authRoutes.js"
TARGET_MODE="$(stat -c '%a' -- "$TARGET_FILE")"
TARGET_OWNER="$(stat -c '%u:%g' -- "$TARGET_FILE")"

"$NODE" --input-type=module - "$TARGET_FILE" <<'NODE'
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const target = process.argv[2];
const importMarker = "import * as db from './db.js';\n";
const responseMarker = "            organization: invite ? { id: organization.id, name: organization.name } : null,\n";
const legalImport = "import { CURRENT_LEGAL_DOCUMENTS, legalDocumentHash } from '../modules/data_governance/legalDocuments.js';\n";
const legalResponse = "            legalDocuments: CURRENT_LEGAL_DOCUMENTS.map((document) => ({ id: document.id, version: document.version, hash: legalDocumentHash(document) })),\n";
let source = readFileSync(target, 'utf8');
if (source.split(importMarker).length !== 2 || source.split(responseMarker).length !== 2) {
  throw new Error('installed server file does not match the audited 1.9.11 patch markers');
}
source = source.replace(importMarker, importMarker + legalImport);
source = source.replace(responseMarker, responseMarker + legalResponse);
const temporary = `${target}.hotfix.tmp`;
writeFileSync(temporary, source, 'utf8');
renameSync(temporary, target);
NODE

chown "$TARGET_OWNER" "$TARGET_FILE"
chmod "$TARGET_MODE" "$TARGET_FILE"
"$NODE" --check "$TARGET_FILE"
grep -Fq "import { CURRENT_LEGAL_DOCUMENTS, legalDocumentHash }" "$TARGET_FILE"
grep -Fq 'legalDocuments: CURRENT_LEGAL_DOCUMENTS.map' "$TARGET_FILE"

if [ "$MODE" = dry-run ]; then
  echo '[Otto Hotfix] dry-run passed; production release was not switched'
  exit 0
fi

SWITCHED=0
rollback() {
  local rc=$?
  trap - ERR
  if [ "$SWITCHED" -eq 1 ]; then
    echo '[Otto Hotfix] verification failed; restoring previous release' >&2
    systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    ln -s "$OLD_RELEASE" "$INSTALL_ROOT/current.rollback.$RUN_ID"
    mv -Tf "$INSTALL_ROOT/current.rollback.$RUN_ID" "$CURRENT_LINK"
    systemctl start "$SERVICE_NAME" >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap rollback ERR

printf '%s\n' "$OLD_RELEASE" > "$HOTFIX_RELEASE/HOTFIX-PREVIOUS-RELEASE"
printf '%s\n' "registration legal documents response; GitHub Actions run $RUN_ID" \
  > "$HOTFIX_RELEASE/HOTFIX-INFO"
ln -s "$HOTFIX_RELEASE" "$INSTALL_ROOT/current.hotfix.$RUN_ID"
mv -Tf "$INSTALL_ROOT/current.hotfix.$RUN_ID" "$CURRENT_LINK"
SWITCHED=1
systemctl restart "$SERVICE_NAME"

HEALTHY=0
for _ in $(seq 1 30); do
  if PUBLIC_HEALTH="$(curl --fail --silent --show-error --max-time 5 \
    http://127.0.0.1:7778/enterprise/health 2>/dev/null)"; then
    if "$NODE" --input-type=module - "$PUBLIC_HEALTH" "$EXPECTED_VERSION" <<'NODE'
const [healthText, expectedVersion] = process.argv.slice(2);
const health = JSON.parse(healthText);
if (health.status !== 'ok' || health.version !== expectedVersion) process.exit(1);
NODE
    then
      HEALTHY=1
      break
    fi
  fi
  sleep 1
done
test "$HEALTHY" -eq 1
systemctl is-active --quiet "$SERVICE_NAME"
test "$(readlink -f -- "$CURRENT_LINK")" = "$HOTFIX_RELEASE"

LEGAL_PROFILE="$(curl --fail --silent --show-error --max-time 15 \
  -H 'Accept: application/json' http://127.0.0.1:7778/enterprise/legal)"
"$NODE" --input-type=module - "$LEGAL_PROFILE" <<'NODE'
const profile = JSON.parse(process.argv[2]);
const documents = profile.documents;
if (!Array.isArray(documents) || documents.length !== 2) process.exit(1);
const ids = new Set(documents.map((document) => document.id));
if (!ids.has('terms') || !ids.has('privacy')) process.exit(1);
if (!documents.every((document) => typeof document.version === 'string'
  && /^[0-9a-f]{64}$/.test(document.hash))) process.exit(1);
NODE

SWITCHED=0
trap - ERR
echo "[Otto Hotfix] SUCCESS: $HOTFIX_RELEASE is active"
