#!/usr/bin/env bash
# dev-up.sh가 관리하는 프로세스, 포트, HTTP 준비 상태를 요약한다.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_DIR="$ROOT/.dev/pids"
ENV_FILE="$ROOT/.env"
CLI_PORT="${PORT:-}"
CLI_WEB_PORT="${WEB_PORT:-}"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
PORT="${CLI_PORT:-${PORT:-3001}}"
WEB_PORT="${CLI_WEB_PORT:-${WEB_PORT:-3000}}"
# dev-up.sh 가 BIND_HOST 로 특정 인터페이스에만 열었으면 그 주소로 확인해야 한다.
# 127.0.0.1 로만 찌르면 정상인데도 HTTP 000 으로 보여 멀쩡한 환경을 죽었다고 오진한다.
PROBE_HOST="${BIND_HOST:-}"
if [ -z "$PROBE_HOST" ] || [ "$PROBE_HOST" = '0.0.0.0' ]; then
  # WEB_URL 이 로컬이 아니면(사내망 주소 등) 거기서 호스트를 가져온다.
  PROBE_HOST="$(printf '%s' "${WEB_URL:-}" | sed -E 's|^https?://||; s|[:/].*$||')"
  case "$PROBE_HOST" in ''|localhost) PROBE_HOST=127.0.0.1 ;; esac
fi

process_status() {
  local name="$1" file="$PID_DIR/$1.pid" pid='-'
  if [ -f "$file" ]; then pid="$(cat "$file")"; fi
  if [ "$pid" != '-' ] && kill -0 "$pid" 2>/dev/null; then
    printf '%-8s pid=%-7s running\n' "$name" "$pid"
  else
    printf '%-8s pid=%-7s stopped\n' "$name" "$pid"
  fi
}

port_status() {
  local port="$1" listener
  listener="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR == 2 { print $1 " pid=" $2 }')"
  printf '%-8s %s\n' "port:$port" "${listener:-no listener}"
}

http_status() {
  local name="$1" url="$2" status
  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || true)"
  printf '%-8s %-45s HTTP %s\n' "$name" "$url" "${status:-000}"
  [ "$status" = '200' ]
}

echo 'Baton 개발 환경 상태'
process_status server
process_status web
port_status "$PORT"
port_status "$WEB_PORT"
http_status api "http://${PROBE_HOST}:${PORT}/health"; api_ok=$?
http_status web "http://${PROBE_HOST}:${WEB_PORT}/login"; web_ok=$?

if command -v docker >/dev/null 2>&1; then
  mysql_id="$(cd "$ROOT" && docker compose ps -q mysql 2>/dev/null)"
  if [ -n "$mysql_id" ]; then
    mysql_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$mysql_id" 2>/dev/null || echo unknown)"
  else
    mysql_health='stopped'
  fi
  printf '%-8s %s\n' mysql "$mysql_health"
fi

if [ "$api_ok" -eq 0 ] && [ "$web_ok" -eq 0 ]; then exit 0; fi
exit 1
