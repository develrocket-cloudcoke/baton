#!/usr/bin/env bash
# dev-up.sh가 시작한 Web/API를 종료하고 MySQL 컨테이너를 내린다.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_DIR="$ROOT/.dev/pids"
RESET=false

case "${1:-}" in
  '') ;;
  --reset) RESET=true ;;
  *) echo "사용법: $0 [--reset]" >&2; exit 2 ;;
esac

stop_pid() {
  local name="$1" file="$PID_DIR/$1.pid" pid
  [ -f "$file" ] || return 0
  pid="$(cat "$file")"
  if kill -0 "$pid" 2>/dev/null; then
    echo "[baton-dev] $name (pid $pid)을 종료합니다."
    # pnpm → node → 개발 서버로 이어지는 자식 트리도 명시적으로 정리한다.
    # macOS의 pnpm은 부모만 종료하면 watch/Next 자식을 남길 수 있다.
    stop_children() {
      local parent="$1" child
      for child in $(pgrep -P "$parent" 2>/dev/null || true); do
        stop_children "$child"
        kill -TERM "$child" 2>/dev/null || true
      done
    }
    stop_children "$pid"
    kill -TERM "$pid" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "[baton-dev] $name이 종료되지 않아 강제 종료합니다." >&2
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$file"
}

# 의존성이 있는 Web을 먼저, API를 다음으로 정리한다.
stop_pid web
stop_pid server

cd "$ROOT"
if [ "$RESET" = true ]; then
  echo '[baton-dev] MySQL 컨테이너와 baton-mysql-data 볼륨을 삭제합니다.'
  docker compose down -v
else
  echo '[baton-dev] MySQL 컨테이너를 종료합니다 (볼륨 유지).'
  docker compose down
fi

echo '[baton-dev] 개발 환경을 정리했습니다.'
