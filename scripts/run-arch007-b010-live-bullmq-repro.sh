#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

if [[ $# -gt 1 ]]; then
  echo "usage: $0 [path-to-moda-interact-background]" >&2
  exit 64
fi

if [[ $# -eq 1 ]]; then
  REPO="$1"
elif [[ -f "$PWD/moda-interact-background/package.json" ]]; then
  REPO="$PWD/moda-interact-background"
elif [[ -f "$PWD/package.json" && "$(basename "$PWD")" == "moda-interact-background" ]]; then
  REPO="$PWD"
else
  echo "Could not locate moda-interact-background." >&2
  echo "Run from moda-interact-workspace, from moda-interact-background, or pass the repository path." >&2
  exit 64
fi

REPO="$(cd "$REPO" && pwd -P)"

if [[ ! -f "$REPO/scripts/test-integration.mjs" ]]; then
  echo "Expected $REPO/scripts/test-integration.mjs" >&2
  exit 66
fi
if [[ ! -d "$REPO/node_modules" ]]; then
  echo "Expected $REPO/node_modules. Run npm install in moda-interact-background first." >&2
  exit 69
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required because the repository disposable-integration harness starts PostgreSQL and Redis containers." >&2
  exit 69
fi
if ! docker info >/dev/null 2>&1; then
  echo "docker is installed but the Docker/Colima daemon is not available." >&2
  exit 69
fi

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/arch007-b010-live-repro.XXXXXX")"
TEMP_REPO="$TMP_ROOT/moda-interact-background"
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

mkdir -p "$TEMP_REPO"
rsync -a \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude '.env.*' \
  "$REPO/" "$TEMP_REPO/"
ln -s "$REPO/node_modules" "$TEMP_REPO/node_modules"

mkdir -p "$TEMP_REPO/tests/integration"
cp "$SCRIPT_DIR/arch007-b010-live-bullmq-repro.integration.test.ts" \
  "$TEMP_REPO/tests/integration/arch007-b010-live-bullmq-repro.integration.test.ts"

printf '%s\n' \
  "ARCH-007-BACKGROUND-010 live scheduling reproduction" \
  "---------------------------------------------------" \
  "Source repository: $REPO" \
  "Temporary copy:    $TEMP_REPO" \
  "Original checkout: untouched" \
  "Infrastructure:    disposable PostgreSQL + Redis via the repository's existing test:integration harness" \
  ""

cd "$TEMP_REPO"
npm run test:integration -- \
  tests/integration/arch007-b010-live-bullmq-repro.integration.test.ts
