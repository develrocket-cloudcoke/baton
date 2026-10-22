#!/usr/bin/env bash
# 로컬 Phase 1 환경(MySQL, API, Web)을 기동한다.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_DIR="$ROOT/.dev"
LOG_DIR="$DEV_DIR/logs"
PID_DIR="$DEV_DIR/pids"
ENV_FILE="$ROOT/.env"

log() { printf '[baton-dev] %s\n' "$*"; }
die() { printf '[baton-dev] 오류: %s\n' "$*" >&2; exit 1; }

if ! command -v docker >/dev/null 2>&1; then die 'Docker가 필요합니다.'; fi
if ! command -v pnpm >/dev/null 2>&1; then die 'pnpm이 필요합니다.'; fi

CLI_PORT="${PORT:-}"
CLI_WEB_PORT="${WEB_PORT:-}"
CLI_API_URL="${NEXT_PUBLIC_API_URL:-}"
CLI_WEB_URL="${WEB_URL:-}"

if [ ! -f "$ENV_FILE" ]; then
  cp "$ROOT/.env.example" "$ENV_FILE"
  log '.env가 없어 .env.example로 생성했습니다.'
fi

# Prisma와 개발 서버 모두 같은 환경값을 사용하도록 내보낸다.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

PORT="${CLI_PORT:-${PORT:-3001}}"
WEB_PORT="${CLI_WEB_PORT:-${WEB_PORT:-3000}}"
API_URL="${CLI_API_URL:-${NEXT_PUBLIC_API_URL:-http://127.0.0.1:${PORT}}}"
# 알림 webUrl 은 브라우저가 실제로 여는 origin 과 같아야 한다(§4-10). 웹을 127.0.0.1 로 띄우므로 기본값도 같게 맞춘다.
WEB_URL="${CLI_WEB_URL:-${WEB_URL:-http://127.0.0.1:${WEB_PORT}}}"
# 브라우저가 접속하는 origin 이 CORS 허용 목록에 반드시 있어야 한다.
# 지정하지 않으면 WEB_URL 과 로컬 주소를 허용한다.
WEB_ORIGIN="${WEB_ORIGIN:-${WEB_URL},http://127.0.0.1:${WEB_PORT},http://localhost:${WEB_PORT}}"
# 서버와 웹이 열릴 인터페이스. 기본은 이 컴퓨터에서만 접속 가능.
# 다른 사람과 붙어 테스트할 때는 접근 가능한 사내망 주소를 BIND_HOST 에 지정한다.
# 0.0.0.0 은 공용 와이파이까지 열리므로 필요할 때만 쓴다.
BIND_HOST="${BIND_HOST:-127.0.0.1}"
if [ "$BIND_HOST" = '0.0.0.0' ]; then PROBE_HOST=127.0.0.1; else PROBE_HOST="$BIND_HOST"; fi

mkdir -p "$LOG_DIR" "$PID_DIR"
ready=false
resources_started=false

# migration 또는 준비 확인이 실패해도 이 스크립트가 띄운 리소스를 남기지 않는다.
cleanup_on_failure() {
  local result=$?
  if [ "$ready" = false ] && [ "$resources_started" = true ]; then
    "$ROOT/scripts/dev-down.sh" >/dev/null 2>&1 || true
  fi
  exit "$result"
}
trap cleanup_on_failure EXIT

pid_is_running() {
  [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null
}

if pid_is_running "$PID_DIR/server.pid" || pid_is_running "$PID_DIR/web.pid"; then
  die "이미 개발 서버가 실행 중입니다. 상태는 ./scripts/dev-status.sh, 종료는 ./scripts/dev-down.sh를 사용하세요."
fi
rm -f "$PID_DIR/server.pid" "$PID_DIR/web.pid"

cd "$ROOT"
log 'MySQL 컨테이너를 기동합니다.'
docker compose up -d mysql
resources_started=true

log 'MySQL healthcheck를 기다립니다.'
deadline=$((SECONDS + 120))
while :; do
  mysql_id="$(docker compose ps -q mysql)"
  mysql_health=""
  if [ -n "$mysql_id" ]; then
    mysql_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$mysql_id" 2>/dev/null || true)"
  fi
  if [ "$mysql_health" = 'healthy' ]; then break; fi
  if [ "$mysql_health" = 'unhealthy' ] || [ "$SECONDS" -ge "$deadline" ]; then
    docker compose ps >&2 || true
    die "MySQL 준비 시간이 초과되었습니다 (현재 상태: ${mysql_health:-unknown})."
  fi
  sleep 2
done

# schema.prisma의 shadow URL도 첫 실행에서 유효하도록 보장한다.
docker compose exec -T mysql mysql -uroot -proot -e 'CREATE DATABASE IF NOT EXISTS baton_shadow;'

log 'Prisma migration을 적용하고 seed 데이터를 동기화합니다.'
pnpm --filter @baton/server exec prisma migrate deploy
pnpm --filter @baton/server prisma:seed

log 'API 개발 서버(TypeScript watch)를 시작합니다.'
# tsx/esbuild 기반의 기존 dev 스크립트는 NestJS decorator metadata를 만들지 않아
# Swagger 초기화가 실패한다. tsc watch + node --watch는 같은 개발 경험을 유지하면서
# metadata를 보존한다.
pnpm --filter @baton/server build
(
  cd "$ROOT/apps/server"
  pnpm exec tsc -p tsconfig.json --watch --preserveWatchOutput &
  exec env PORT="$PORT" HOST="$BIND_HOST" WEB_URL="$WEB_URL" WEB_ORIGIN="$WEB_ORIGIN" node --watch dist/main.js
) >"$LOG_DIR/server.log" 2>&1 &
echo $! > "$PID_DIR/server.pid"

log 'Web 개발 서버를 시작합니다 (real API 모드).'
(
  cd "$ROOT"
  exec env NEXT_PUBLIC_API_MODE=real NEXT_PUBLIC_API_URL="$API_URL" pnpm --filter @baton/web dev --hostname "$BIND_HOST" --port "$WEB_PORT"
) >"$LOG_DIR/web.log" 2>&1 &
echo $! > "$PID_DIR/web.pid"

wait_for_http() {
  local name="$1" url="$2" pid_file="$3"
  local http_code
  deadline=$((SECONDS + 120))
  while :; do
    http_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$url" || true)"
    if [ "$http_code" = '200' ]; then return 0; fi
    if ! pid_is_running "$pid_file"; then
      tail -n 80 "$LOG_DIR/$name.log" >&2 || true
      die "$name 프로세스가 준비 전에 종료되었습니다."
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      tail -n 80 "$LOG_DIR/$name.log" >&2 || true
      die "$name 응답 대기 시간이 초과되었습니다 (마지막 HTTP: $http_code)."
    fi
    sleep 2
  done
}

wait_for_http server "http://${PROBE_HOST}:${PORT}/health" "$PID_DIR/server.pid"
# 루트는 인증 여부에 따라 /login으로 redirect하므로, 항상 200인 login 페이지를 확인한다.
wait_for_http web "http://${PROBE_HOST}:${WEB_PORT}/login" "$PID_DIR/web.pid"

cat <<EOF

Baton Phase 1 개발 환경이 준비되었습니다.
  Web:    http://127.0.0.1:${WEB_PORT}
  API:    http://127.0.0.1:${PORT} (health: /health)
  로그:   .dev/logs/{server,web}.log

Seed 계정 (브라우저 프로필을 분리해 로그인):
  A (요청자): a@baton.local / baton-dev-password
  B (수신자): b@baton.local / baton-dev-password

알림 링크(webUrl): ${WEB_URL}  ← 브라우저로 접속하는 주소와 같아야 합니다(다르면 알림 클릭 시 로그인 세션이 분리됩니다).

메뉴바 앱 pairing (전역 PAIRING_CODE는 없어졌습니다, 05 §3.4):
  1. ./scripts/desktop-build.sh 로 Baton.app을 빌드·실행합니다.
  2. B 로 웹에 로그인해 ${WEB_URL}/me/devices → "디바이스 추가" 로 8자리 코드(XXXX-XXXX, 10분·1회용)를 발급합니다.
  3. 메뉴바 앱 팝오버 "설정" 탭에서 서버 URL ${API_URL} 과 프로젝트 목록(이름+로컬 경로)을 저장한 뒤 코드를 입력합니다.
  또는 콘솔 데몬:
     pnpm --filter @baton/desktop-agent dev -- login --code <XXXX-XXXX> --server ${API_URL}

상태 확인: ./scripts/dev-status.sh
종료:      ./scripts/dev-down.sh  (DB까지 초기화: ./scripts/dev-down.sh --reset)
EOF
ready=true
