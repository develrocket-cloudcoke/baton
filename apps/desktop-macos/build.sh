#!/usr/bin/env bash
# swift build → build/Baton.app 조립 → ad-hoc codesign. Xcode 없이 Command Line Tools 만으로 동작한다.
# 사용법: bash build.sh [--universal] [--dev] [--no-agent]
#   (기본: 현재 아키텍처, --universal: arm64 + x86_64 를 각각 빌드해 lipo)
#   --dev: 고정 개발용 코드 서명 identity 로 서명한다 (BATON_CODESIGN_IDENTITY 또는 "Baton Dev" 이름의 codesigning identity).
#   --no-agent: 데몬 번들(Resources/baton.cjs)을 만들지 않는다. 저장소 개발본으로 폴백해 돈다 (BATON_SKIP_AGENT=1 과 같다).
#
# CLO-117-a: 이 스크립트는 scripts/pack-agent.sh 를 불러 데몬을 단일 파일로 묶고
# Baton.app/Contents/Resources/baton.cjs 에 넣는다. 그래야 저장소가 없는 컴퓨터에서도 .app 하나로 데몬이 돈다.
# 넣는 시점은 **codesign 앞**이어야 한다 — 서명 뒤에 리소스를 넣으면 서명이 깨진다.
#
# 왜 ad-hoc 이 문제인가: ad-hoc 서명은 빌드마다 cdhash 가 바뀌고 Keychain 항목의 ACL 은 코드 서명 기준이라,
# 재빌드한 앱이 이전 빌드가 만든 항목을 읽을 때 키체인 암호 프롬프트가 뜬다 (docs/mvp-acceptance.md §4-2).
#
# 고정 identity 를 스크립트로 만들 수 있나 → **없다** (CLO-9 실측, 2026-09-11):
#   인증서 생성·keychain 생성·import·set-key-partition-list 까지는 무인 자동화가 되지만,
#   미신뢰 인증서로는 codesign 이 "Baton Dev: no identity found" 로 거부하고,
#   신뢰를 주는 `security add-trusted-cert` 는 SecurityAgent GUI 인증(관리자 암호)을 반드시 요구한다.
#   → 개발 반복 중에는 서명을 고정하는 대신 **토큰 저장소를 파일로** 바꾸는 쪽을 권장한다:
#     `bash scripts/run-dev.sh` (기본값이 BATON_TOKEN_STORE=file 이다). README "토큰 저장소" 절 참고.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
APP="$HERE/build/Baton.app"
BUNDLE_ID="${BATON_BUNDLE_ID:-dev.baton.desktop}"   # 검증용으로 다른 id 를 쓸 수 있다 (알림 권한 상태가 bundle id 에 묶여 있음)
VERSION="${BATON_VERSION:-0.1.0}"

build_one() { # build_one <triple|""> → 바이너리 경로 출력
  local triple="$1"
  if [ -n "$triple" ]; then
    swift build -c release --product BatonDesktop --triple "$triple" 2>&1 | grep -E 'error:|warning: unre|Build complete' || true
    echo "$HERE/.build/${triple%%-apple-*}-apple-macosx/release/BatonDesktop"
  else
    swift build -c release --product BatonDesktop 2>&1 | grep -E 'error:|Build complete' || true
    echo "$(swift build -c release --product BatonDesktop --show-bin-path)/BatonDesktop"
  fi
}

UNIVERSAL=0; DEV_SIGN=0; SKIP_AGENT="${BATON_SKIP_AGENT:-0}"
for arg in "$@"; do
  case "$arg" in
    --universal) UNIVERSAL=1 ;;
    --dev) DEV_SIGN=1 ;;
    --no-agent) SKIP_AGENT=1 ;;
    *) echo "알 수 없는 옵션: $arg" >&2; exit 2 ;;
  esac
done

# 서명 identity: 기본 ad-hoc("-"). --dev 면 고정 identity 를 찾는다.
SIGN_IDENTITY="-"
# 이 Mac 에 "Baton Dev" 고정 인증서가 있으면(scripts/setup-dev-signing.sh 로 한 번 만든다) --dev 가 없어도 쓴다.
# 빌드마다 서명이 같아야 설치할 때마다 키체인이 다시 묻지 않는다(2026-09-28 사용자 결정 — 방법 1).
if [ "$DEV_SIGN" != 1 ] && security find-identity -v -p codesigning 2>/dev/null | grep -q '"Baton Dev'; then
  DEV_SIGN=1
fi
if [ "$DEV_SIGN" = 1 ]; then
  if [ -n "${BATON_CODESIGN_IDENTITY:-}" ]; then
    SIGN_IDENTITY="$BATON_CODESIGN_IDENTITY"
  else
    # `security find-identity` 출력 예: 1) <SHA1> "Baton Dev"
    SIGN_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Baton Dev[^"]*\)".*/\1/p' | head -1)"
  fi
  if [ -z "$SIGN_IDENTITY" ]; then
    echo '[build.sh] --dev: 사용할 codesigning identity 가 없어 ad-hoc 으로 서명합니다.' >&2
    echo '           고정 identity 는 스크립트로 못 만든다(신뢰 설정에 GUI 인증 필수, README "개발용 고정 서명" 참고).' >&2
    echo '           개발 반복 중에는 BATON_TOKEN_STORE=file 로 실행하세요 — scripts/run-dev.sh 의 기본값입니다.' >&2
    SIGN_IDENTITY="-"
  fi
fi

mkdir -p "$HERE/build"
# 빌드 폴더의 Baton.app 이 Spotlight·Launchpad 에 잡혀 설치본 대신 실행되지 않게 색인에서 뺀다(2026-09-28 사용자가 실수로 실행).
touch "$HERE/build/.metadata_never_index"
if [ "$UNIVERSAL" = 1 ]; then
  # `--arch a --arch b` 는 Xcode 의 xcbuild 를 요구해 CLT 만으로는 실패한다 (poc/menubar 실측).
  A="$(build_one arm64-apple-macosx13.0 | tail -1)"
  X="$(build_one x86_64-apple-macosx13.0 | tail -1)"
  test -f "$A" && test -f "$X" || { echo "BUILD FAILED"; exit 1; }
  lipo -create "$A" "$X" -output "$HERE/build/BatonDesktop-universal"
  BIN="$HERE/build/BatonDesktop-universal"
else
  BIN="$(build_one "" | tail -1)"
  test -f "$BIN" || { echo "BUILD FAILED"; exit 1; }
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/BatonDesktop"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDisplayName</key><string>Baton</string>
  <key>CFBundleExecutable</key><string>BatonDesktop</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleName</key><string>Baton</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
EOF
# 앱 아이콘: assets/AppIcon.png(1024, macOS 격자에 맞춘 둥근 사각형)에서 크기별 iconset 을 만들어 icns 로 묶는다.
# sips·iconutil 은 macOS 기본 도구라 Xcode 없이 된다. 원본 그림은 저장소 branding/ 에 있다. 서명 전에 넣어야 한다.
ICON_SRC="$HERE/assets/AppIcon.png"
if [ -f "$ICON_SRC" ]; then
  ICONSET="$HERE/build/AppIcon.iconset"
  rm -rf "$ICONSET" && mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
fi
# 데몬 단일 파일을 번들에 넣는다 (CLO-117-a ①). 앱만 받은 컴퓨터에서 이 파일이 데몬이 된다.
AGENT_OUT="$APP/Contents/Resources/baton.cjs"
if [ "$SKIP_AGENT" = 1 ]; then
  echo "[build.sh] --no-agent: 데몬을 번들에 넣지 않습니다. 앱은 저장소 개발본(apps/desktop-agent/dist/cli.js)으로 폴백합니다."
else
  if bash "$HERE/../../scripts/pack-agent.sh" "$AGENT_OUT" >/tmp/baton-pack-agent.log 2>&1; then
    echo "[build.sh] 데몬 번들 포함: Resources/baton.cjs ($(du -h "$AGENT_OUT" | cut -f1), $(node "$AGENT_OUT" --version 2>/dev/null || echo '버전 확인 실패'))"
  else
    # 여기서 조용히 넘어가면 테스터가 받은 앱이 "저장소가 없다" 로 죽는다. 무엇이 실패했는지 보여 주고 중단한다.
    echo "[build.sh] 오류: scripts/pack-agent.sh 실패 — 데몬을 번들에 넣지 못했습니다." >&2
    tail -20 /tmp/baton-pack-agent.log >&2
    echo "[build.sh] 저장소 개발본으로 쓸 거면 --no-agent 를 붙여 다시 실행하세요." >&2
    exit 1
  fi
fi
codesign --force --sign "$SIGN_IDENTITY" --identifier "$BUNDLE_ID" "$APP"
echo "[build.sh] codesign identity: $SIGN_IDENTITY"
if [ "$SIGN_IDENTITY" = "-" ]; then
  echo "[build.sh] ad-hoc 서명 → 이 빌드는 이전 빌드가 만든 Keychain 항목을 읽을 때 암호 프롬프트가 뜰 수 있습니다."
  echo "[build.sh] 개발 실행은 BATON_TOKEN_STORE=file 을 쓰세요 (scripts/run-dev.sh 기본값)."
fi
codesign -dv "$APP" 2>&1 | grep -E 'Identifier|Signature|Format'
file "$APP/Contents/MacOS/BatonDesktop" | head -1
if [ -f "$AGENT_OUT" ]; then
  echo "[build.sh] 이 앱은 번들 내장 데몬을 씁니다 (저장소 없이도 동작). 설정 창의 \"데몬 런타임\" 에서 확인할 수 있습니다."
else
  echo "[build.sh] 번들에 데몬이 없어 저장소 개발본을 찾습니다 — 저장소 밖으로 옮기면 동작하지 않습니다."
fi
echo "BUILT $APP"
