#!/usr/bin/env bash
set -euo pipefail

MODE=${1:-local}
DURATION=${2:-5}
LOGFILE=${LOGFILE:-"mcp-server-$(date +%Y%m%d-%H%M%S).log"}
PACKAGE_DIR=${PACKAGE_DIR:-}

mkdir -p "$(dirname "$LOGFILE")"
: >"$LOGFILE"
LOGFILE=$(realpath "$LOGFILE")

echo "==> Starting MCP server in '$MODE' mode for ${DURATION}s"
echo "==> Logs: $LOGFILE"

STATUS=0

set +e
case "$MODE" in
  local)
    if [[ -z "$PACKAGE_DIR" ]]; then
      echo "PACKAGE_DIR environment variable must be set for local mode" >&2
      exit 1
    fi
    if [[ ! -d "$PACKAGE_DIR" ]]; then
      echo "PACKAGE_DIR '$PACKAGE_DIR' does not exist" >&2
      exit 1
    fi
    (
      cd "$PACKAGE_DIR" || exit 1
      # The server exits when stdin closes, so keep stdin open until the timeout ends the run.
      sleep $((DURATION + 1)) | timeout --signal=TERM "$DURATION" node dist/index.js
    ) 2>&1 | tee "$LOGFILE"
    STATUS=${PIPESTATUS[0]}
    ;;
  npm)
    if [[ -z "$PACKAGE_DIR" ]]; then
      echo "PACKAGE_DIR environment variable must be set for npm mode" >&2
      exit 1
    fi
    if [[ ! -d "$PACKAGE_DIR" ]]; then
      echo "PACKAGE_DIR '$PACKAGE_DIR' does not exist" >&2
      exit 1
    fi
    (
      cd "$PACKAGE_DIR" || exit 1
      sleep $((DURATION + 1)) | timeout --signal=TERM "$DURATION" node dist/index.js
    ) 2>&1 | tee "$LOGFILE"
    STATUS=${PIPESTATUS[0]}
    ;;
  *)
    echo "Usage: $0 [local|npm] [duration_seconds]" >&2
    exit 1
    ;;
esac
set -e

if [[ $STATUS -eq 124 ]]; then
  echo "==> Timeout reached after ${DURATION}s (expected)."
elif [[ $STATUS -ne 0 ]]; then
  echo "==> MCP server exited with status $STATUS"
  exit $STATUS
fi

echo "==> Run complete"
echo "==> Logs stored at: $LOGFILE"
