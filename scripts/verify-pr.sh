#!/usr/bin/env bash
# verify-pr.sh — Run typecheck + tests for packages changed in this branch.
#
# Usage: ./scripts/verify-pr.sh [--base <branch>]
#   --base    Branch to diff against (default: origin/internal)
#
# Exit code: 0 if all checks pass, 1 if any fails.

set -euo pipefail

BASE="${BASE:-origin/internal}"
VERBOSE=false
if [[ "${1:-}" == "--base" ]]; then
  BASE="$2"
  shift 2
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASS=0
FAIL=0
RESULTS=()

# ── helpers ────────────────────────────────────────────────────────────────

pass_msg() {
  printf "  ${GREEN}✓ PASS${NC}  %s\n" "$1"
  RESULTS+=("PASS  $1")
  PASS=$((PASS + 1))
}

fail_msg() {
  printf "  ${RED}✗ FAIL${NC}  %s\n" "$1"
  RESULTS+=("FAIL  $1")
  FAIL=$((FAIL + 1))
}

# ── detect changed packages ────────────────────────────────────────────────

echo ""
echo "🔍 Detecting changed packages (diff against $BASE) …"

# Get list of directories under packages/ that changed
CHANGED_FILES=$(git diff "$BASE" --name-only 2>/dev/null || true)
if [[ -z "$CHANGED_FILES" ]]; then
  echo "  ${YELLOW}⚠ No changed files detected. Running checks on all packages.${NC}"
  CHANGED_PACKAGES=$(ls -d packages/*/ 2>/dev/null | sed 's:/$::')
else
  CHANGED_PACKAGES=$(echo "$CHANGED_FILES" | grep '^packages/' | cut -d'/' -f1-2 | sort -u)
fi

if [[ -z "$CHANGED_PACKAGES" ]]; then
  echo "  No packages changed. Nothing to verify."
  exit 0
fi

echo "  Changed packages:"
for pkg in $CHANGED_PACKAGES; do
  echo "    - $pkg"
done
echo ""

# ── typecheck ──────────────────────────────────────────────────────────────

echo "━━━ Typecheck ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

for pkg in $CHANGED_PACKAGES; do
  if [[ ! -f "$pkg/tsconfig.json" ]]; then
    echo "  ⏭  $pkg — no tsconfig.json, skipping typecheck"
    continue
  fi

  echo "  $pkg …"
  if (cd "$pkg" && npx tsc --noEmit 2>&1); then
    pass_msg "$pkg typecheck"
  else
    fail_msg "$pkg typecheck"
  fi
  echo ""
done

# ── tests ──────────────────────────────────────────────────────────────────

echo "━━━ Tests ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

for pkg in $CHANGED_PACKAGES; do
  # Only run tests if the package has a vitest config
  if [[ ! -f "$pkg/vitest.config.ts" ]] && [[ ! -f "$pkg/vitest.config.js" ]]; then
    echo "  ⏭  $pkg — no vitest config, skipping tests"
    continue
  fi

  echo "  $pkg …"
  if (cd "$pkg" && npx vitest run 2>&1); then
    pass_msg "$pkg tests"
  else
    fail_msg "$pkg tests"
  fi
  echo ""
done

# ── summary ────────────────────────────────────────────────────────────────

echo "━━━ Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

for result in "${RESULTS[@]}"; do
  if [[ "$result" == PASS* ]]; then
    printf "  ${GREEN}✓${NC} %s\n" "$result"
  else
    printf "  ${RED}✗${NC} %s\n" "$result"
  fi
done

echo ""
printf "  Total: ${GREEN}%d passed${NC}, " "$PASS"
if [[ $FAIL -gt 0 ]]; then
  printf "${RED}%d failed${NC}\n" "$FAIL"
else
  printf "0 failed\n"
fi
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo "❌ Verification FAILED. Fix the issues above before opening a PR."
  exit 1
else
  echo "✅ All checks passed. Ready for PR!"
  exit 0
fi
