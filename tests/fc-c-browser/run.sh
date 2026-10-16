#!/usr/bin/env bash
# FC-C · E2E de navegador mínimo de DEV-C (a unificar por REVIEW con tests/browser/ de DEV-D).
# Requisitos: Node 22.15 en PATH, Docker ROOTLESS local, imagen mcr.microsoft.com/playwright:v1.48.2-jammy.
# NO toca producción: PostgreSQL embebido efímero + API y SPA locales en 127.0.0.1.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PORT:-4317}"
WORK="$(mktemp -d)"
DIST="$WORK/dist"
trap 'kill "${SERVE_PID:-}" 2>/dev/null || true; rm -rf "$WORK"' EXIT

npx vite build "$ROOT/apps/web" --outDir "$DIST" --emptyOutDir >"$WORK/vite.log" 2>&1
WEB_DIST="$DIST" PORT="$PORT" npx tsx "$ROOT/tests/fc-c-browser/serve.ts" >"$WORK/serve.log" 2>&1 &
SERVE_PID=$!
for _ in $(seq 1 90); do grep -q READY "$WORK/serve.log" && break; sleep 1; done
grep -q READY "$WORK/serve.log" || { cat "$WORK/serve.log"; exit 1; }

mkdir -p "$WORK/pw"
cp "$ROOT/tests/fc-c-browser/"*.spec.ts "$ROOT/tests/fc-c-browser/playwright.config.ts" "$WORK/pw/"
docker run --rm --network host -e FC_C_BASE_URL="http://127.0.0.1:$PORT" -v "$WORK/pw:/work" -w /work \
  mcr.microsoft.com/playwright:v1.48.2-jammy \
  bash -c 'npm init -y >/dev/null && npm i --no-audit --no-fund @playwright/test@1.48.2 >/dev/null 2>&1 && npx playwright test -c playwright.config.ts'
