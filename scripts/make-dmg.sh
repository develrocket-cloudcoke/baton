#!/bin/bash
# macOS 기본 도구만으로 Baton.app + Applications 링크가 있는 배포 이미지를 만든다.
# 사용법: bash scripts/make-dmg.sh [Baton.app 경로] [출력.dmg 경로]
# 앱이 없으면 기존 build.sh를 호출한다. 최신 데몬 번들은 앱 빌드 단계에서 포함해야 한다.
# BATON_CODESIGN_IDENTITY: 있으면 해당 identity, 없으면 ad-hoc 서명(개발자 인증 아님).
# BATON_DMG_LAYOUT=0: GUI 없는 빌드에서 Finder 배치를 생략한다(기본 1).
#
# 공증 절차(Developer ID Application 인증서와 Apple 개발자 계정 필요):
# 1. BATON_CODESIGN_IDENTITY='Developer ID Application: ...'로 이 스크립트를 실행한다.
# 2. xcrun notarytool submit <출력.dmg> --keychain-profile <프로필> --wait
# 3. Accepted 확인 후 xcrun stapler staple <출력.dmg>
# 4. xcrun stapler validate <출력.dmg> 및 spctl --assess --type open
#    --context context:primary-signature --verbose <출력.dmg>로 검증한다.
# 계정 자격증명 등록/공증은 자동 실행하지 않는다. 서명만으로 공증되지는 않는다.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${1:-$ROOT/apps/desktop-macos/build/Baton.app}"
OUT="${2:-/tmp/baton-dist/Baton.dmg}"
[ "$#" -le 2 ] || { echo '사용법: make-dmg.sh [Baton.app] [출력.dmg]' >&2; exit 2; }
[ "$(uname -s)" = Darwin ] || { echo 'macOS에서 실행하세요.' >&2; exit 1; }
if [ ! -d "$APP" ]; then
  if [ "$APP" != "$ROOT/apps/desktop-macos/build/Baton.app" ]; then
    echo "지정한 앱을 찾을 수 없습니다: $APP" >&2; exit 1
  fi
  bash "$ROOT/apps/desktop-macos/build.sh"
fi
[ -f "$APP/Contents/Info.plist" ] || { echo '유효한 .app이 아닙니다.' >&2; exit 1; }
EXECUTABLE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")
[ -x "$APP/Contents/MacOS/$EXECUTABLE" ] || { echo '앱 실행 파일이 없습니다.' >&2; exit 1; }
[ ! -e "$OUT" ] || { echo "기존 출력은 덮어쓰지 않습니다: $OUT" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"
OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/baton-dmg.XXXXXX")
MOUNT="$WORK/mount"
ATTACHED=0
cleanup() {
  if [ "$ATTACHED" = 1 ] && ! hdiutil detach "$MOUNT" >/dev/null; then
    echo "임시 볼륨 분리에 실패했습니다. 작업 폴더를 보존합니다: $WORK" >&2
    return
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
mkdir "$WORK/stage" "$MOUNT"
# 원본 앱을 바꾸지 않고 Resources/baton.cjs 등 번들 전체를 그대로 보존한다.
ditto "$APP" "$WORK/stage/Baton.app"
ln -s /Applications "$WORK/stage/Applications"
if [ ! -f "$WORK/stage/Baton.app/Contents/Resources/baton.cjs" ]; then
  echo '[baton-dmg] 경고: Resources/baton.cjs가 없습니다. 이 이미지는 독립 설치용 데몬이 없는 개발 빌드입니다.' >&2
fi
IDENTITY="${BATON_CODESIGN_IDENTITY:--}"
# build.sh 와 같은 규칙: "Baton Dev" 고정 인증서가 있으면 그것으로 다시 서명한다. 없으면 ad-hoc.
# 예전엔 여기서 항상 ad-hoc 으로 덮어써, build.sh 가 고정 서명을 해도 DMG 안의 앱은 빌드마다 서명이 바뀌었다(2026-09-28).
if [ "$IDENTITY" = '-' ] && security find-identity -v -p codesigning 2>/dev/null | grep -q '"Baton Dev"'; then
  IDENTITY="Baton Dev"
fi
if [ "$IDENTITY" = '-' ]; then
  codesign --force --deep --sign - "$WORK/stage/Baton.app"
  echo '[baton-dmg] 경고: 이 dmg 는 서명되지 않았다 — 앱의 ad-hoc 서명은 개발자 인증이나 Apple 공증이 아닙니다.' >&2
else
  codesign --force --deep --options runtime --timestamp --sign "$IDENTITY" "$WORK/stage/Baton.app"
  echo '[baton-dmg] identity 서명을 적용했습니다. Apple 공증은 별도로 진행해야 합니다.'
fi
codesign --verify --deep --strict "$WORK/stage/Baton.app"
hdiutil create -quiet -volname "Baton-${WORK##*.}" -fs HFS+ -format UDRW -srcfolder "$WORK/stage" "$WORK/writable.dmg"
hdiutil attach -quiet -readwrite -noverify -noautoopen -mountpoint "$MOUNT" "$WORK/writable.dmg"
ATTACHED=1
if [ "${BATON_DMG_LAYOUT:-1}" = 1 ]; then
  # 경로는 AppleScript 인수로 넘겨 공백/따옴표가 있는 작업 경로도 지원한다.
  osascript - "$MOUNT" <<'APPLESCRIPT'
on run argv
  set targetFolder to POSIX file (item 1 of argv) as alias
  tell application "Finder"
    open targetFolder
    set targetWindow to container window of targetFolder
    set current view of targetWindow to icon view
    set toolbar visible of targetWindow to false
    set statusbar visible of targetWindow to false
    set bounds of targetWindow to {200, 160, 760, 500}
    set arrangement of icon view options of targetWindow to not arranged
    set icon size of icon view options of targetWindow to 96
    set text size of icon view options of targetWindow to 14
    set position of item "Baton.app" of targetFolder to {140, 145}
    set position of item "Applications" of targetFolder to {410, 145}
    update targetFolder without registering applications
    delay 2
    close targetWindow
  end tell
end run
APPLESCRIPT
else
  echo '[baton-dmg] Finder 배치 생략(BATON_DMG_LAYOUT=0).'
fi
# 다른 Baton 볼륨이 열려 있어도 Finder가 작업 볼륨을 혼동하지 않게 마지막에 이름을 바꾼다.
diskutil renameVolume "$MOUNT" Baton >/dev/null
sync
hdiutil detach -quiet "$MOUNT"
ATTACHED=0
hdiutil convert -quiet "$WORK/writable.dmg" -format UDZO -imagekey zlib-level=9 -o "$WORK/Baton.dmg"
# ad-hoc 서명 DMG는 다운로드 격리 후 컨테이너 단계에서 차단될 수 있다.
# 인증서가 없으면 내부 앱만 ad-hoc 서명하고 DMG 자체는 미서명으로 배포한다.
if [ "$IDENTITY" != '-' ]; then
  codesign --force --timestamp --sign "$IDENTITY" "$WORK/Baton.dmg"
fi
hdiutil verify "$WORK/Baton.dmg"
mv "$WORK/Baton.dmg" "$OUT"
shasum -a 256 "$OUT"
echo "[baton-dmg] 완료: $OUT"
