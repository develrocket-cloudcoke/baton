#!/usr/bin/env bash
# ngrok 터널로 개발 환경을 외부 테스터에게 열 때 필요한 설정을 점검·적용한다.
#
#   ./scripts/dev-tunnel.sh            점검만 한다 (아무것도 바꾸지 않는다)
#   ./scripts/dev-tunnel.sh apply      .env 의 WEB_ORIGIN·WEB_URL·NEXT_PUBLIC_API_URL 을 터널 주소로 맞추고
#                                      API 서버만 재시작한다 (웹·MySQL·데몬은 건드리지 않는다)
#
# 왜 필요한가 (2026-09-14 실측):
#   웹과 API 가 서로 **다른 ngrok 호스트**로 열리므로 브라우저 → API 호출이 교차 출처가 된다.
#   서버의 WEB_ORIGIN 에 웹 터널 origin 이 없으면 CORS 응답에 access-control-allow-origin 이 빠지고,
#   브라우저는 모든 API 호출을 "Failed to fetch" 로 버린다. 화면은 에러 없이 **빈 목록**으로만 보여
#   원인을 찾기 어렵다. 이 스크립트는 그 한 줄을 맞춰 준다.
#
#   ngrok 무료 플랜의 경고 페이지(ERR_NGROK_6024)는 **최상위 탐색(Accept: text/html)에만** 뜬다.
#   fetch/XHR(Accept: */*)은 경고 없이 통과하는 것을 실측했으므로, 웹 코드에
#   ngrok-skip-browser-warning 헤더를 넣을 필요는 없다. 테스터는 주소창으로 처음 들어갈 때 한 번만
#   "Visit Site" 를 누르면 된다.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
PID_DIR="$ROOT/.dev/pids"
LOG_DIR="$ROOT/.dev/logs"
NGROK_API="${NGROK_API:-http://127.0.0.1:4040/api/tunnels}"
MODE="${1:-status}"

log() { printf '[baton-tunnel] %s\n' "$*"; }
die() { printf '[baton-tunnel] 오류: %s\n' "$*" >&2; exit 1; }

case "$MODE" in
  status|apply) ;;
  *) die "사용법: $0 [status|apply]" ;;
esac

command -v python3 >/dev/null 2>&1 || die 'python3 가 필요합니다.'
[ -f "$ENV_FILE" ] || die ".env 가 없습니다. 먼저 ./scripts/dev-up.sh 를 한 번 실행하세요."

# ngrok 로컬 에이전트 API 에서 터널 두 개(웹 3000, API 3001)를 찾는다.
TUNNELS_JSON="$(curl -sS --max-time 3 "$NGROK_API" 2>/dev/null || true)"
[ -n "$TUNNELS_JSON" ] || die "ngrok 에이전트에 연결할 수 없습니다 ($NGROK_API). ngrok 이 떠 있는지 확인하세요."

read -r WEB_TUNNEL API_TUNNEL <<EOF
$(printf '%s' "$TUNNELS_JSON" | python3 -c '
import json, sys
tunnels = json.load(sys.stdin).get("tunnels", [])
web = api = "-"
for t in tunnels:
    addr = t.get("config", {}).get("addr", "")
    url = t.get("public_url", "")
    if not url.startswith("https://"):
        continue
    if addr.endswith(":3000"):
        web = url
    elif addr.endswith(":3001"):
        api = url
print(web, api)
')
EOF

[ "$WEB_TUNNEL" != '-' ] || die '웹(3000) 터널을 찾지 못했습니다.'
[ "$API_TUNNEL" != '-' ] || die 'API(3001) 터널을 찾지 못했습니다.'

# 현재 .env 값
env_get() { sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" "$ENV_FILE" | tail -1; }
CUR_ORIGIN="$(env_get WEB_ORIGIN)"
CUR_WEB_URL="$(env_get WEB_URL)"
CUR_API_URL="$(env_get NEXT_PUBLIC_API_URL)"
PORT_VAL="$(env_get PORT)"; PORT_VAL="${PORT_VAL:-3001}"

# 로컬 origin 은 남겨 둔다 (터널을 내려도 로컬에서 계속 쓰도록)
WANT_ORIGIN="http://127.0.0.1:3000,http://localhost:3000,$WEB_TUNNEL"

echo
log "웹 터널 : $WEB_TUNNEL"
log "API 터널: $API_TUNNEL"
echo
printf '%-22s %s\n' 'WEB_ORIGIN(현재)' "${CUR_ORIGIN:-<없음>}"
printf '%-22s %s\n' 'WEB_ORIGIN(필요)' "$WANT_ORIGIN"
printf '%-22s %s\n' 'WEB_URL(현재)' "${CUR_WEB_URL:-<없음>}"
printf '%-22s %s\n' 'NEXT_PUBLIC_API_URL' "${CUR_API_URL:-<없음>}"
echo

# 실제로 CORS 가 열렸는지 preflight 로 확인한다 (선언값이 아니라 응답으로 판정)
probe_cors() {
  curl -sS -D- -o /dev/null --max-time 5 -X OPTIONS "$API_TUNNEL/v1/auth/login" \
    -H "Origin: $WEB_TUNNEL" \
    -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type' 2>/dev/null \
    | tr -d '\r' | grep -i '^access-control-allow-origin:' || true
}

ACAO="$(probe_cors)"
if [ -n "$ACAO" ]; then
  log "CORS 확인: OK ($ACAO)"
else
  log 'CORS 확인: **실패** — preflight 응답에 access-control-allow-origin 이 없습니다.'
  log '           이 상태에서는 브라우저가 모든 API 호출을 버리고 화면이 빈 목록으로만 보입니다.'
fi

if [ "$MODE" = status ]; then
  if [ -z "$ACAO" ]; then
    echo
    log "고치려면: $0 apply"
    exit 1
  fi
  exit 0
fi

# ---- apply ----
log ".env 를 터널 값으로 갱신합니다 (백업: .env.bak)."
cp "$ENV_FILE" "$ENV_FILE.bak"
python3 - "$ENV_FILE" "$WANT_ORIGIN" "$WEB_TUNNEL" "$API_TUNNEL" <<'PY'
import re, sys
path, origin, web_url, api_url = sys.argv[1:5]
text = open(path).read()
for key, value in (('WEB_ORIGIN', origin), ('WEB_URL', web_url), ('NEXT_PUBLIC_API_URL', api_url)):
    line = f'{key}="{value}"'
    if re.search(rf'^{key}=.*$', text, re.M):
        text = re.sub(rf'^{key}=.*$', line, text, flags=re.M)
    else:
        text = text.rstrip('\n') + '\n' + line + '\n'
open(path, 'w').write(text)
PY

# API 서버만 재시작한다. 웹·MySQL·데몬은 그대로 둔다.
# (데몬의 SSE 는 1초 안에 자동 재연결된다 — lastEventId 로 이어받는다.)
mkdir -p "$PID_DIR" "$LOG_DIR"
if [ -f "$PID_DIR/server.pid" ]; then
  OLD="$(cat "$PID_DIR/server.pid")"
  if kill -0 "$OLD" 2>/dev/null; then
    log "API 서버(pid $OLD)를 종료합니다."
    stop_children() {
      local parent="$1" child
      for child in $(pgrep -P "$parent" 2>/dev/null || true); do
        stop_children "$child"
        kill -TERM "$child" 2>/dev/null || true
      done
    }
    stop_children "$OLD"
    kill -TERM "$OLD" 2>/dev/null || true
    for _ in {1..20}; do kill -0 "$OLD" 2>/dev/null || break; sleep 0.25; done
    kill -KILL "$OLD" 2>/dev/null || true
  fi
  rm -f "$PID_DIR/server.pid"
fi

log 'API 서버를 새 WEB_ORIGIN 으로 다시 시작합니다.'
# dev-up.sh 와 같이 .env 를 export 해서 넘긴다.
# (DATABASE_URL 을 빠뜨리면 서버는 뜨지만 모든 Prisma 호출이 실패하고,
#  데몬 SSE 가 연결 직후 끊겨 초당 두 번씩 재연결하는 루프에 빠진다 — 2026-09-14 실측)
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
(
  cd "$ROOT/apps/server"
  pnpm exec tsc -p tsconfig.json --watch --preserveWatchOutput &
  exec env PORT="$PORT_VAL" WEB_URL="$WEB_TUNNEL" WEB_ORIGIN="$WANT_ORIGIN" node --watch dist/main.js
) >>"$LOG_DIR/server.log" 2>&1 &
echo $! > "$PID_DIR/server.pid"

log 'API 기동을 기다립니다.'
deadline=$((SECONDS + 60))
until curl -sS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT_VAL}/health"; do
  [ "$SECONDS" -lt "$deadline" ] || die 'API 가 60초 안에 뜨지 않았습니다. .dev/logs/server.log 를 확인하세요.'
  sleep 2
done

# /health 가 떠도 Nest 의 CORS 미들웨어가 붙기까지 한두 박자 늦을 수 있어 몇 번 다시 본다.
ACAO=''
for _ in {1..10}; do
  ACAO="$(probe_cors)"
  [ -n "$ACAO" ] && break
  sleep 2
done
if [ -n "$ACAO" ]; then
  log "CORS 재확인: OK ($ACAO)"
else
  die 'CORS 가 아직 열리지 않았습니다. .dev/logs/server.log 를 확인하세요.'
fi

if [ "$CUR_API_URL" != "$API_TUNNEL" ]; then
  echo
  log "참고: .env 의 NEXT_PUBLIC_API_URL 을 바꿨지만 **웹은 재시작하지 않았습니다**."
  log '      NEXT_PUBLIC_* 는 빌드타임 값이라, 웹이 다른 API 주소로 떠 있으면 아래로 다시 띄우세요:'
  log "      ./scripts/dev-down.sh && NEXT_PUBLIC_API_URL=$API_TUNNEL WEB_URL=$WEB_TUNNEL ./scripts/dev-up.sh"
fi

cat <<EOF

테스터에게 줄 주소:
  웹   $WEB_TUNNEL
  API  $API_TUNNEL   (브라우저로 직접 열 일은 없다)

테스터는 웹 주소를 처음 열 때 ngrok 경고 페이지에서 "Visit Site" 를 한 번 누르면 된다.
EOF
