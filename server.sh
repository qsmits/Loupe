#!/usr/bin/env bash
# Usage: ./server.sh [start|stop|restart|status]
set -euo pipefail

PIDFILE=".server.pid"
LOGFILE=".server.log"
PORT=8000
PYTHON="$(dirname "$0")/.venv/bin/python"
export GST_PLUGIN_PATH=/opt/homebrew/opt/aravis/lib/gstreamer-1.0

start() {
    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "Server already running (PID $(cat "$PIDFILE"))"
        return
    fi
    echo "Starting server on port $PORT..."
    nohup "$PYTHON" -m uvicorn backend.main:app --host 0.0.0.0 --port "$PORT" \
        --timeout-graceful-shutdown 3 \
        > "$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    echo "Started (PID $!). Logs: $LOGFILE"
}

stop() {
    if [[ ! -f "$PIDFILE" ]]; then
        echo "No PID file found."
        return
    fi
    PID=$(cat "$PIDFILE")
    if ! kill -0 "$PID" 2>/dev/null; then
        echo "Process $PID not running."
        rm -f "$PIDFILE"
        return
    fi
    kill "$PID"
    # Wait up to 10s for graceful shutdown (Aravis needs time to release USB/GigE)
    for i in $(seq 1 20); do
        sleep 0.5
        kill -0 "$PID" 2>/dev/null || break
    done
    # Force-kill if still alive
    if kill -0 "$PID" 2>/dev/null; then
        echo "Process did not stop gracefully, force-killing..."
        kill -9 "$PID"
        sleep 0.5
    fi
    echo "Stopped (PID $PID)"
    rm -f "$PIDFILE"
}

status() {
    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "Running (PID $(cat "$PIDFILE"))"
    else
        echo "Stopped"
    fi
}

case "${1:-start}" in
    start)   start ;;
    stop)    stop ;;
    restart) stop; start ;;
    status)  status ;;
    *)       echo "Usage: $0 [start|stop|restart|status]" ;;
esac
