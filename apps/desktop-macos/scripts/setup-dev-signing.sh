#!/bin/bash
# Baton 개발용 고정 코드 서명 인증서("Baton Dev")를 이 Mac 의 로그인 키체인에 만든다. 한 번만 실행한다.
#
# 왜: ad-hoc 서명은 빌드마다 바뀌어, 새 버전을 설치할 때마다 키체인이 "Baton 이 비밀 정보를 사용하려고 합니다" 를
# 다시 묻는다. 같은 인증서로 서명하면 코드 서명 요구 조건은 고정되지만, 팀 ID 가 없어 키체인 partition_id 가
# 빌드 지문(cdhash) 기준이라 업데이트마다 한 번은 여전히 묻는다(2026-09-28 실측 — README "고정 서명" 참조).
#
# 사람이 해야 하는 것(자동화 불가 — CLO-9 실측): 신뢰 부여 단계에서 macOS 가 관리자 암호 창을 띄운다.
# 이 스크립트는 반드시 **사용자 본인의 터미널**에서 실행한다. 암호는 macOS 창에 직접 넣는다.
#
# 개인 키는 로그인 키체인에만 남는다. 이 Mac 을 잃으면 새 인증서를 만들어야 하고, 그때 설치한 사람들에게 한 번 더 묻는다.
# 사용법: bash apps/desktop-macos/scripts/setup-dev-signing.sh
set -euo pipefail

NAME="Baton Dev"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
OPENSSL=/usr/bin/openssl   # macOS 기본(LibreSSL). OpenSSL 3 의 기본 PKCS#12 암호화는 security import 가 못 읽는다.

if security find-identity -v -p codesigning | grep -q "\"$NAME\""; then
  echo "이미 \"$NAME\" 서명 인증서가 있습니다. 할 일이 없습니다."
  security find-identity -v -p codesigning | grep "\"$NAME\""
  exit 0
fi

# 예전 실행이 신뢰 단계에서 멈춰 "신뢰되지 않은" 같은 이름의 인증서·키가 남아 있으면 지우고 새로 만든다(중복 방지).
while security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; do
  echo "신뢰되지 않은 이전 \"$NAME\" 인증서를 지웁니다."
  security delete-identity -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1 || security delete-certificate -c "$NAME" "$KEYCHAIN" >/dev/null
done

WORK=$(mktemp -d)
cleanup() { rm -rf "$WORK"; }   # 개인 키 파일은 키체인에 넣은 뒤 지운다
trap cleanup EXIT
chmod 700 "$WORK"

cat > "$WORK/openssl.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

echo "1/4 인증서 만드는 중 (10년)"
"$OPENSSL" req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -config "$WORK/openssl.cnf" -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null

echo "2/4 로그인 키체인에 넣는 중"
# 임시 묶음용, 이 실행 안에서만 쓴다. `tr </dev/urandom | head` 는 pipefail 에서 SIGPIPE 로 스크립트를 조용히 멈췄다(2026-09-28).
P12_PASS=$("$OPENSSL" rand -hex 16)
"$OPENSSL" pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "$NAME" \
  -out "$WORK/id.p12" -passout "pass:$P12_PASS"
security import "$WORK/id.p12" -k "$KEYCHAIN" -P "$P12_PASS" -T /usr/bin/codesign >/dev/null

echo "3/4 코드 서명 신뢰 부여 — macOS 가 관리자 암호 창을 띄웁니다. 암호를 넣고 허용해 주세요."
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$WORK/cert.pem"

echo "4/4 확인"
if security find-identity -v -p codesigning | grep -q "\"$NAME\""; then
  security find-identity -v -p codesigning | grep "\"$NAME\""
  echo
  echo "완료. 이제 build.sh 가 자동으로 \"$NAME\" 로 서명합니다."
  echo "처음 빌드할 때 \"codesign 이 키체인의 키를 사용하려고 합니다\" 창이 뜨면 [항상 허용] 을 눌러 주세요."
else
  echo "신뢰 부여가 끝나지 않았습니다(암호 창을 취소했거나 거부됨). 다시 실행해 주세요." >&2
  exit 1
fi
