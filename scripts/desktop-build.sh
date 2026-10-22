#!/usr/bin/env bash
# Desktop Agent를 먼저 빌드한 뒤 Swift 메뉴바 앱을 조립한다.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_PACKAGE="$ROOT/apps/desktop-agent/package.json"
APP_BUILD="$ROOT/apps/desktop-macos/build.sh"

[ -f "$APP_BUILD" ] || { echo "Desktop build 스크립트를 찾을 수 없습니다: $APP_BUILD" >&2; exit 1; }

# desktop-agent가 build 스크립트를 제공할 때만 호출한다. 아직 없는 초기 상태도 허용한다.
if node -e "const p=require(process.argv[1]); process.exit(p.scripts && p.scripts.build ? 0 : 1)" "$AGENT_PACKAGE"; then
  echo '[baton-dev] Desktop Agent를 빌드합니다.'
  (cd "$ROOT" && pnpm --filter @baton/desktop-agent build)
else
  # TODO: apps/desktop-agent에 build 스크립트가 추가되면 위 분기가 자동으로 활성화된다.
  echo '[baton-dev] Desktop Agent build 스크립트가 아직 없어 건너뜁니다.'
fi

echo '[baton-dev] macOS 메뉴바 앱을 빌드합니다.'
bash "$APP_BUILD" "$@"
APP_PATH="$ROOT/apps/desktop-macos/build/Baton.app"
[ -d "$APP_PATH" ] || { echo "Baton.app 산출물을 찾을 수 없습니다: $APP_PATH" >&2; exit 1; }
echo "[baton-dev] Baton.app: $APP_PATH"
