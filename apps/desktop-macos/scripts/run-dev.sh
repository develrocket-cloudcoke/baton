#!/usr/bin/env bash
# 개발용 실행: 빌드 후 앱을 띄운다.
# 사용법: bash scripts/run-dev.sh [--fake] [--universal] [--keychain]
#   --fake      데몬 명령을 scripts/fake-daemon.mjs 로 바꿔 셸을 단독 검증한다
#   --keychain  토큰 저장소를 제품 기본값(Keychain)으로 되돌린다 (아래 참고)
#   --stop      실행 중인 앱 종료
#
# 토큰 저장소 기본값이 파일인 이유 (CLO-9):
#   개발 빌드는 ad-hoc 서명이라 재빌드마다 코드 서명이 바뀌고, Keychain 항목의 ACL 은 서명 기준이라
#   재빌드한 앱이 이전 항목을 읽을 때 키체인 암호 프롬프트가 뜬다. 서명을 고정하려면 자체 서명 인증서를
#   "신뢰" 시켜야 하는데 그 단계가 GUI 인증을 요구해 스크립트로 자동화되지 않는다(README "개발용 고정 서명").
#   그래서 개발 실행은 `BATON_TOKEN_STORE=file`(~/.baton/device-token, 0600)을 기본값으로 쓴다.
#   제품 기본값은 그대로 Keychain 이며, 이 파일을 거치지 않고 앱을 직접 실행하면 Keychain 이 쓰인다.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HERE/build/Baton.app"
BUNDLE_ID="${BATON_BUNDLE_ID:-dev.baton.desktop}"   # 검증용으로 다른 id 를 쓸 수 있다 (알림 권한 상태가 bundle id 에 묶여 있음)
FAKE=0; UNI=""; TOKEN_STORE="${BATON_TOKEN_STORE:-file}"
for a in "$@"; do
  case "$a" in
    --fake) FAKE=1 ;;
    --universal) UNI="--universal" ;;
    --keychain) TOKEN_STORE="keychain" ;;
    --stop) pkill -f "$APP/Contents/MacOS/BatonDesktop" && echo "stopped" || echo "not running"; exit 0 ;;
  esac
done
bash "$HERE/build.sh" $UNI
if [ "$FAKE" = 1 ]; then
  NODE="$(command -v node)"
  defaults write "$BUNDLE_ID" shell.daemonCommand "$NODE $HERE/scripts/fake-daemon.mjs"
  echo "daemonCommand → fake-daemon"
fi
pkill -f "$APP/Contents/MacOS/BatonDesktop" 2>/dev/null || true
export FAKE_DAEMON_LOG="${FAKE_DAEMON_LOG:-$HERE/build/fake-daemon.log}"
export BATON_TOKEN_STORE="$TOKEN_STORE"
echo "tokenStore=$BATON_TOKEN_STORE (--keychain 으로 제품 기본값 사용)"
"$APP/Contents/MacOS/BatonDesktop" > "$HERE/build/app.stdout.log" 2>&1 &
echo "APP_PID=$! logs: ~/Library/Logs/Baton/{shell,daemon}.log fake-daemon: $FAKE_DAEMON_LOG"
