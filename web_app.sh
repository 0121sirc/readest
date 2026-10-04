#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.web_app.pid"
MODE_FILE="$SCRIPT_DIR/.web_app.mode"
DEV_LOG_FILE="$SCRIPT_DIR/.web_app.log"
RELEASE_LOG_FILE="$SCRIPT_DIR/.web_app.release.log"
LOG_FILE="$DEV_LOG_FILE"
PORT="${PORT:-3000}"
NODE_VERSION="${NODE_VERSION:-24}"
READY_TIMEOUT="${READY_TIMEOUT:-90}"
MODE="dev"
COMMAND=""

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

running_mode() {
  local mode
  mode="$(cat "$MODE_FILE" 2>/dev/null || true)"
  printf '%s' "${mode:-dev}"
}

apply_mode() {
  if [ "$MODE" = "release" ]; then
    LOG_FILE="$RELEASE_LOG_FILE"
  else
    LOG_FILE="$DEV_LOG_FILE"
  fi
}

run_script() {
  if [ "$MODE" = "release" ]; then
    printf 'start-web'
  else
    printf 'dev-web'
  fi
}

# Prefer the Tailscale IPv4 address so the app can be reached from other
# devices on the tailnet; fall back to localhost when Tailscale is absent.
tailscale_ip() {
  local ip="" iface="${TAILSCALE_IFACE:-tailscale0}"
  if command -v tailscale >/dev/null 2>&1; then
    ip="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
  fi
  if [ -z "$ip" ] && [ -e "/sys/class/net/$iface" ]; then
    ip="$(ip -4 -o addr show dev "$iface" 2>/dev/null | awk '{split($4, a, "/"); print a[1]}' | head -n 1 || true)"
  fi
  printf '%s' "$ip"
}

app_url() {
  local ip host
  ip="$(tailscale_ip)"
  host="${ip:-localhost}"
  printf 'http://%s:%s' "$host" "$PORT"
}

build_release() {
  echo "Building release bundle (log: $LOG_FILE)..."
  if ! (cd "$SCRIPT_DIR" && pnpm --filter @readest/readest-app build-web) 2>&1 | tee -a "$LOG_FILE"; then
    echo "Release build failed. See log: $LOG_FILE" >&2
    return 1
  fi
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
    echo "Readest web app is already running (pid $(pid_of), mode: $(running_mode))."
    echo "URL: $(app_url)"
    echo "Stop it first: $0 stop"
    return 0
  fi

  if port_open; then
    echo "Port $PORT is already in use by another process." >&2
    echo "Stop it first, or run with a different port: PORT=3001 $0 start" >&2
    return 1
  fi

  load_nvm

  : >"$LOG_FILE"

  if [ "$MODE" = "release" ]; then
    build_release || return 1
  fi

  echo "Starting Readest web app ($MODE)..."
  (
    cd "$SCRIPT_DIR"
    setsid pnpm --filter @readest/readest-app "$(run_script)" >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
    printf '%s\n' "$MODE" >"$MODE_FILE"
  )

  if wait_ready; then
    echo "Readest web app started (pid $(pid_of), mode: $MODE)."
    echo "URL:  $(app_url)"
    echo "Log:  $LOG_FILE"
  else
    echo "Readest web app failed to start within ${READY_TIMEOUT}s." >&2
    echo "See log: $LOG_FILE" >&2
    rm -f "$PID_FILE" "$MODE_FILE"
    return 1
  fi
}

stop() {
  local pid mode
  pid="$(pid_of)"

  if [ -z "$pid" ]; then
    echo "Readest web app is not running."
    rm -f "$PID_FILE" "$MODE_FILE"
    return 0
  fi

  mode="$(running_mode)"

  if kill -0 "$pid" 2>/dev/null; then
    echo "Stopping Readest web app (pid $pid, mode: $mode)..."
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

  rm -f "$PID_FILE" "$MODE_FILE"
}

restart() {
  stop
  start
}

status() {
  local pid mode
  pid="$(pid_of)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    mode="$(running_mode)"
    if [ "$mode" = "release" ]; then
      LOG_FILE="$RELEASE_LOG_FILE"
    else
      LOG_FILE="$DEV_LOG_FILE"
    fi
    echo "Readest web app: RUNNING"
    echo "Mode: $mode"
    echo "PID:  $pid"
    echo "URL:  $(app_url)"
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
Usage: $0 {start|stop|restart|status} [--release]

Commands:
  start     Start the Readest web app in the background
  stop      Stop the Readest web app
  restart   Stop then start
  status    Show the current running state

Options:
  --release   Run the production server: pnpm build-web (next build) then
              start-web (next start). The build runs on every start/restart.
  --dev       Run the dev server with hot reload: dev-web (next dev). Default.

Environment:
  PORT              Server port (default: 3000)
  NODE_VERSION      Node.js version to activate via nvm (default: 24)
  READY_TIMEOUT     Seconds to wait for readiness (default: 90)
  TAILSCALE_IFACE   Interface used to read the Tailscale IP (default: tailscale0)

Files:
  PID:  $PID_FILE
  Mode: $MODE_FILE
  LOG:  $DEV_LOG_FILE (dev) | $RELEASE_LOG_FILE (release)
EOF
}

for arg in "$@"; do
  case "$arg" in
    start | stop | restart | status)
      if [ -n "$COMMAND" ]; then
        echo "Only one command is allowed (got: $COMMAND and $arg)." >&2
        usage >&2
        exit 1
      fi
      COMMAND="$arg"
      ;;
    --release) MODE="release" ;;
    --dev) MODE="dev" ;;
    -h | --help | help) COMMAND="help" ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done
apply_mode

case "$COMMAND" in
  start) start ;;
  stop) stop ;;
  restart) restart ;;
  status) status ;;
  "" | help) usage ;;
esac
