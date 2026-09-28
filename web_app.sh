#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.web_app.pid"
LOG_FILE="$SCRIPT_DIR/.web_app.log"
PORT="${PORT:-3000}"
NODE_VERSION="${NODE_VERSION:-24}"
READY_TIMEOUT="${READY_TIMEOUT:-90}"

load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm use "$NODE_VERSION" >/dev/null 2>&1 || true
  fi
}

pid_of() {
  [ -f "$PID_FILE" ] && cat "$PID_FILE" 2>/dev/null || true
}

is_running() {
  local pid
  pid="$(pid_of)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

port_open() {
  (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null
}

wait_ready() {
  local pid attempt
  pid="$(pid_of)"
  for attempt in $(seq 1 $((READY_TIMEOUT * 2))); do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
    if port_open; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

start() {
  if is_running; then
    echo "Readest web app is already running (pid $(pid_of))."
    echo "URL: http://localhost:$PORT"
    return 0
  fi

  if port_open; then
    echo "Port $PORT is already in use by another process." >&2
    echo "Stop it first, or run with a different port: PORT=3001 $0 start" >&2
    return 1
  fi

  load_nvm

  echo "Starting Readest web app..."
  (
    cd "$SCRIPT_DIR"
    setsid pnpm --filter @readest/readest-app dev-web >"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
  )

  if wait_ready; then
    echo "Readest web app started (pid $(pid_of))."
    echo "URL:  http://localhost:$PORT"
    echo "Log:  $LOG_FILE"
  else
    echo "Readest web app failed to start within ${READY_TIMEOUT}s." >&2
    echo "See log: $LOG_FILE" >&2
    rm -f "$PID_FILE"
    return 1
  fi
}

stop() {
  local pid
  pid="$(pid_of)"

  if [ -z "$pid" ]; then
    echo "Readest web app is not running."
    rm -f "$PID_FILE"
    return 0
  fi

  if kill -0 "$pid" 2>/dev/null; then
    echo "Stopping Readest web app (pid $pid)..."
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM -- "$pid" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "Process did not exit, forcing shutdown..."
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL -- "$pid" 2>/dev/null || true
    fi
    echo "Stopped."
  else
    echo "Stale pid file (process $pid is not running)."
  fi

  rm -f "$PID_FILE"
}

restart() {
  stop
  start
}

status() {
  local pid
  pid="$(pid_of)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "Readest web app: RUNNING"
    echo "PID:  $pid"
    echo "URL:  http://localhost:$PORT"
    echo "Log:  $LOG_FILE"
  else
    echo "Readest web app: STOPPED"
    if [ -f "$PID_FILE" ]; then
      echo "Stale pid file: $PID_FILE"
    fi
    if port_open; then
      echo "Note: port $PORT is in use by another process."
    fi
  fi
}

usage() {
  cat <<EOF
Usage: $0 {start|stop|restart|status}

Commands:
  start     Start the Readest web app in the background
  stop      Stop the Readest web app
  restart   Stop then start
  status    Show the current running state

Environment:
  PORT           Dev server port (default: 3000)
  NODE_VERSION   Node.js version to activate via nvm (default: 24)
  READY_TIMEOUT  Seconds to wait for readiness (default: 90)

Files:
  PID: $PID_FILE
  LOG: $LOG_FILE
EOF
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) restart ;;
  status) status ;;
  "" | -h | --help | help) usage ;;
  *)
    echo "Unknown command: $1" >&2
    usage >&2
    exit 1
    ;;
esac
