#!/usr/bin/env bash
# 테스터에게 건넬 콘솔 데몬 단일 파일(baton.cjs)을 만든다.
#
#   ./scripts/pack-agent.sh [출력경로]      기본 /tmp/baton-dist/baton.cjs
#
# 왜 단일 파일인가:
#   메뉴바 앱(Baton.app)은 서명이 없어 다른 Mac 에서 Gatekeeper 에 막힌다. 저장소를 clone 해
#   pnpm install 을 시키는 것도 테스터에게는 부담이다. esbuild 로 의존성(@baton/shared, zod)까지
#   한 파일에 넣으면 테스터는 **node 22 하나만** 있으면 된다.
#
# 주의: 이 파일에는 데몬 코드가 통째로 들어간다. 코드를 고쳤으면 **반드시 다시 만들어** 배포한다.
#       번들 안의 버전은 `node baton.cjs --version` 으로 확인할 수 있다.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-/tmp/baton-dist/baton.cjs}"
ESBUILD="$(ls -d "$ROOT"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild 2>/dev/null | head -1 || true)"

log() { printf '[baton-pack] %s\n' "$*"; }
die() { printf '[baton-pack] 오류: %s\n' "$*" >&2; exit 1; }

[ -n "$ESBUILD" ] || die 'esbuild 를 찾지 못했습니다. 먼저 pnpm install 을 실행하세요.'

log 'shared 패키지를 먼저 빌드합니다.'
(cd "$ROOT" && pnpm --filter @baton/shared build >/dev/null)

mkdir -p "$(dirname "$OUT")"
log "번들을 만듭니다: $OUT"
"$ESBUILD" "$ROOT/apps/desktop-agent/src/cli.ts" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --outfile="$OUT" \
  --log-level=warning
# cli.ts 가 이미 shebang 을 갖고 있으므로 banner 로 또 붙이면 안 된다 (두 줄이 되어 SyntaxError).
chmod +x "$OUT"

VERSION="$(node "$OUT" --version)"
SIZE="$(du -h "$OUT" | cut -f1)"

# hook 진입점이 자기 자신을 다시 부르므로(claude-code/hook), 번들 단독 실행이 되는지 최소 확인한다.
node "$OUT" status >/dev/null 2>&1 || true

cat <<EOF

[baton-pack] 완료
  파일   : $OUT ($SIZE)
  버전   : $VERSION
  실행   : node $(basename "$OUT") <login|start|status>

테스터에게는 이 파일 하나와 테스터 안내서만 주면 됩니다.
EOF
