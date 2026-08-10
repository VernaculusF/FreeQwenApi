#!/usr/bin/env bash
set -euo pipefail

readonly KEY="${QWEN_SSH_KEY:-/path/to/your/ssh/private/key}"
readonly REMOTE="${QWEN_REMOTE:-root@your-server.example}"
readonly APP="${CODEX_APP_START:-/path/to/codex-app/start.sh}"
readonly QWEN_CLI="${CODEX_QWEN_CLI:-/path/to/codex-app/bin/codex-qwen-cli}"

tunnel_pid=""
cleanup() {
  if [[ -n "${tunnel_pid}" ]]; then
    kill "${tunnel_pid}" >/dev/null 2>&1 || true
    wait "${tunnel_pid}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT HUP INT TERM

if ! curl --fail --silent --max-time 2 http://127.0.0.1:3270/health >/dev/null; then
  ssh \
    -i "${KEY}" \
    -o IdentitiesOnly=yes \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -NT \
    -L 127.0.0.1:3270:127.0.0.1:3270 \
    "${REMOTE}" &
  tunnel_pid=$!
fi

for _ in {1..20}; do
  curl --fail --silent --max-time 1 http://127.0.0.1:3270/health >/dev/null && break
  sleep 0.25
done
curl --fail --silent --max-time 2 http://127.0.0.1:3270/health >/dev/null
CODEX_CLI_PATH="${QWEN_CLI}" "${APP}"
