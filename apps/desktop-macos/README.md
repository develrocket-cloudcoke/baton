# apps/desktop-macos — Baton macOS 메뉴바 셸

Swift Package(SwiftPM) 로 만든 메뉴바 상주 앱. Xcode 없이 Command Line Tools 만으로 빌드한다. Apple 프레임워크만 사용한다.

역할(`docs/00-mvp-plan.md` D5, `docs/design/04-shell-daemon-ipc.md`):

- 메뉴바 아이콘 + **축소된 팝오버**(연결 상태 · 실행 중인 작업 한 줄 · 최근 알림 3건 · "설정 열기"/"기록 열기"/"종료")
- **설정·활동 기록 창**(사이드바 2개: 설정 / 활동 기록). 창이 열려 있는 동안에만 Dock 아이콘이 보인다 (CLO-107)
- 시스템 알림(UNUserNotificationCenter) 게시와 클릭 콜백 → 데몬에 `notification.clicked` 전달 + `webUrl` 열기
- 로그인 시 자동 실행(SMAppService) 토글
- 디바이스 토큰 저장(기본 Keychain, 개발용 파일 저장소), 설정 UserDefaults 저장 (데몬의 영속화 대행)
- Node 데몬(`apps/desktop-agent`)을 자식 프로세스로 띄우고 stdin/stdout JSON Lines 로 통신, 크래시 시 백오프 재시작, 앱 종료 시 데몬 종료

## 구조

```text
Package.swift
Sources/BatonIPC/            봉투(Envelope)·메시지 payload(Codable)·바이트 기반 JSON Lines 파서 (UI 와 분리)
Sources/BatonDesktop/        AppDelegate(메뉴바·팝오버·창·위임 처리), DaemonSupervisor(spawn·재시작·요청/응답),
                             Notifications, Keychain, Settings(UserDefaults), LoginItem, Log,
                             PopoverView(축소 팝오버), MainWindow(창·Dock 전환), SettingsPane, ActivityPane
Sources/BatonIPCSelfTest/    CLT 환경용 자체 검증 실행 파일 (XCTest 없이)
Tests/BatonIPCTests/         XCTest (Xcode 가 있는 환경에서 `swift test`)
scripts/fake-daemon.mjs      계약대로 응답하는 가짜 데몬 (셸 단독 검증)
scripts/run-dev.sh           빌드 후 실행 (--fake 로 가짜 데몬, 기본 토큰 저장소는 파일)
build.sh                     swift build → build/Baton.app 조립 → ad-hoc codesign (--universal 지원)
```

## 빌드·실행

```bash
bash build.sh                  # 현재 아키텍처. --universal 은 arm64/x86_64 를 따로 빌드해 lipo
swift run baton-ipc-selftest   # IPC 파서·Codable 검증 (CLT 에는 XCTest/Testing 모듈이 없어 `swift test` 불가)
bash scripts/run-dev.sh --fake # 가짜 데몬과 함께 실행. 로그: ~/Library/Logs/Baton/{shell,daemon}.log
bash scripts/run-dev.sh           # 빌드 후 실행 (토큰 저장소 기본값 = 파일, 아래 "토큰 저장소" 참고)
bash scripts/run-dev.sh --keychain # 제품 기본값(Keychain)으로 실행
bash scripts/run-dev.sh --stop
```

데몬 실행 명령은 **창 → 설정**의 "데몬 명령" 또는 `defaults write dev.baton.desktop shell.daemonCommand "<cmd>"` 로 바꾼다.
기본값은 `node <repo>/apps/desktop-agent/dist/cli.js daemon --ipc stdio` (앱 번들 위치에서 저장소 루트를 추정).

## 화면 구조 (CLO-107, 2026-09-11)

팝오버 하나에 탭 세 개를 넣던 구조를 **상단바 팝오버 + 창** 으로 나눴다. 사용 빈도로 나눈 결과다 —
알림 수신·상태 확인·브라우저로 넘어가기는 상단바가 낫고, pairing·프로젝트 추가·로그 읽기는 창이 낫다.
특히 팝오버는 다른 곳을 클릭하면 닫히므로 **로그를 읽으면서 다른 창을 함께 볼 수 없었다**. 문제가 생겼을 때 가장 필요한 화면이 가장 보기 어려웠다.

| | 팝오버 (상단바) | 창 (설정·활동 기록) |
|---|---|---|
| 여는 법 | 메뉴바 아이콘 클릭 | 팝오버의 "설정 열기"·"기록 열기", 또는 첫 실행 시 자동 |
| 크기 | 340×300 고정 | 900×600 기본, 크기 조절 가능 (최소 720×460, 크기·위치 기억) |
| 내용 | 연결 상태, 실행 중인 작업 한 줄, 최근 알림 3건, 설정/기록 열기, 종료 | **설정**: 서버 URL·pairing·프로젝트 목록·디바이스·토큰 저장소·알림 권한·로그인 항목·데몬 명령<br>**활동 기록**: 실행 진행 이력 + 셸/데몬 로그 (검색·복사·따라가기) |
| Dock 아이콘 | 없음 | **창이 열려 있는 동안에만** 표시 |

- `LSUIElement=true` 는 그대로다. 평소에는 Dock 아이콘이 없고, 창을 열 때 `NSApp.setActivationPolicy(.regular)`,
  닫을 때 `.accessory` 로 되돌린다. 전환 직후 창이 뒤로 내려가지 않도록 policy 를 먼저 바꾸고 activate 한 뒤
  다음 런루프에서 한 번 더 앞으로 올린다.
- **첫 실행(토큰 없음)** 이면 팝오버 대신 이 창이 열리고 설정 화면 맨 위에 pairing 3단계 안내가 나온다.
  처음 쓰는 사람이 상단바 아이콘을 찾는 것보다 창이 눈에 띈다.
- **노치 맥북에서 메뉴바가 넘쳐 상단바 아이콘이 숨는 경우**(status item window 높이 0 → `popover.show` 가 조용히 실패)의
  폴백도 이 창으로 간다. CLO-107 이전에는 팝오버 사본을 담은 별도 `NSPanel` 을 띄웠는데, 그 코드는 제거했다.
- 전체를 일반 앱으로 옮기지는 않는다. 큰 화면은 웹 앱이 맡는다 — 요청 목록·상세·검토를 네이티브로 다시 만들면 두 벌을 유지하게 된다.


## 토큰 저장소 (디바이스 토큰)

| 조건 | 저장 위치 | 비고 |
|---|---|---|
| 기본값 (제품 경로) | **Keychain** generic password, service = **번들 id**(기본 `dev.baton.desktop`), account `deviceToken` | `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` |
| 환경변수 `BATON_TOKEN_STORE=file` | **파일** `$BATON_HOME/device-token` (없으면 `~/.baton/device-token`), 디렉터리 0700 / 파일 0600 | 개발 반복용 |

- 지금 무엇을 쓰는지는 창 **설정** 화면의 "Pairing" 절에 `토큰 저장소: Keychain (기본값)` / `토큰 저장소: 파일 <경로> (BATON_TOKEN_STORE 환경변수)` 로 표시되고, 바로 아래 줄에 읽기 상태(`토큰 저장됨` / `토큰 없음` / `읽는 중…` / `읽기 실패: …`)가 나온다.
- service 를 번들 id 로 잡아 두어서 `BATON_BUNDLE_ID` 로 빌드한 검증용 앱은 정식 번들의 Keychain 항목을 건드리지 않는다.
- 읽기·쓰기는 **항상 main thread 밖**(전용 직렬 큐)에서 한다. Keychain 프롬프트가 떠 있어도 셸 UI 와 데몬 IPC 는 계속 돈다. 6초(`TokenService.replyDeadline`) 안에 못 읽으면 데몬에 `keychain_error` 를 돌려주고, 데몬은 죽지 않고 `token_unavailable` 사유와 함께 not_paired 로 떨어진다. 나중에 프롬프트에 응답해 읽기가 성공하면 셸이 `settings.changed` 를 보내고 데몬이 재시작 없이 연결한다.

## 개발용 고정 서명 — 왜 스크립트로 자동화하지 못하는가 (CLO-9 실측, 2026-09-11)

ad-hoc(`codesign -s -`) 서명은 빌드마다 cdhash 가 바뀐다. Keychain 항목의 ACL 은 코드 서명 기준이라, 재빌드한 앱이 이전 빌드가 만든 항목을 읽으면 "키체인에서 Baton이(가) ‘<번들 id>’에 저장된 비밀 정보를 사용하려고 합니다" 프롬프트가 뜬다. 서명을 고정하면 사라지지만, **고정 서명용 자체 서명 인증서를 무인 스크립트로 만들 수 없다.**

| 단계 | 명령 | 자동화 |
|---|---|---|
| 1. 코드 서명용 자체 서명 인증서 생성 | `openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 3650` + `extendedKeyUsage=critical,codeSigning` | **가능** |
| 2. PKCS#12 로 묶기 | `openssl pkcs12 -export -inkey key.pem -in cert.pem -out id.p12 -name "Baton Dev"` | **가능** |
| 3. 전용 keychain 생성·잠금 해제 | `security create-keychain -p <pw> baton-dev.keychain-db` / `security unlock-keychain` | **가능** |
| 4. import + codesign 접근 허용 | `security import id.p12 -k <keychain> -P <pw> -T /usr/bin/codesign` + `security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k <pw> <keychain>` | **가능** |
| 5. **코드 서명 신뢰 부여** | `security add-trusted-cert -r trustRoot -p codeSign -k <keychain> cert.pem` | **불가능 — GUI 인증 필수** |

- 5번을 실행하면 `SecurityAgent`(macOS 인증 대화상자)가 떠서 관리자 암호를 요구하고, 취소하면 `SecTrustSettingsSetTrustSettings: The authorization was canceled by the user.` 로 실패한다. `-d`(admin 도메인)는 추가로 `sudo` 까지 필요하다.
- 신뢰가 없으면 identity 는 `CSSMERR_TP_NOT_TRUSTED` 로 남고, `codesign --sign "Baton Dev"` 는 **`Baton Dev: no identity found`** 로 거부한다. 즉 4번까지만 자동화해 봐야 쓸모가 없다.
- **그래서 개발 반복 중에는 서명을 고정하는 대신 토큰 저장소를 파일로 바꾸는 쪽을 권장한다.** `scripts/run-dev.sh` 의 기본값이 `BATON_TOKEN_STORE=file` 이다.
- ⚠️ **자체 서명 인증서로도 키체인 프롬프트는 업데이트마다 한 번 뜬다(2026-09-28 실측).** 토큰 항목의 ACL 은 두 겹이다:
  ① 허용 앱 목록은 `identifier "dev.baton.desktop" and certificate leaf = …` 로 기록돼 고정 인증서로 통과하지만,
  ② **파티션 목록(partition_id)** 은 팀 ID 가 없는 앱이면 `cdhash:<빌드 지문>` 으로 기록돼 새 빌드마다 빠진다.
  팀 ID 는 Apple 개발자 프로그램(Developer ID)에서만 나온다 → 프롬프트를 없애려면 Developer ID 서명이 필요하다.
  확인: `security dump-keychain -a ~/Library/Keychains/login.keychain-db` 에서 svce=dev.baton.desktop 항목의 partition_id.
  **결정(2026-09-28): 당분간 이대로 간다** — 업데이트마다 "항상 허용" 을 한 번 누른다. Developer ID(Apple 개발자 프로그램,
  연 $99, 공증 포함)는 배포 대상이 늘어 이 한 번이 부담이 될 때 다시 검토한다. 토큰을 파일에 두는 방식은 보안상 택하지 않았다.
- **2026-09-28 부터: `bash scripts/setup-dev-signing.sh` 를 사용자 본인 터미널에서 한 번 실행한다.** 1~4번은 스크립트가 하고,
  5번(신뢰 부여)은 macOS 가 띄우는 관리자 암호 창에 사람이 답한다. 이후 `build.sh` 는 "Baton Dev" 가 있으면 `--dev` 없이도 그것으로 서명한다.
  개인 키는 로그인 키체인에만 있다 — 이 Mac 을 잃으면 새로 만들어야 하고, 설치한 사람들에게 키체인 허용을 한 번 더 묻게 된다.
- 이미 고정 identity 를 가진 Mac(키체인 접근 → 인증서 지원으로 직접 만들었거나 Developer ID 가 있는 경우)에서는 `bash build.sh --dev` 가 `BATON_CODESIGN_IDENTITY` 또는 `"Baton Dev"` 이름의 identity 를 찾아 쓴다.
- 프롬프트가 이미 떠 있으면: **거부** → `security delete-generic-password -s <번들 id> -a deviceToken` → 앱에서 재-pairing. (데몬은 죽지 않으므로 앱을 껐다 켤 필요는 없다)

## 알림 권한

macOS 의 알림 권한은 **번들 id** 에 묶인다. 한 번 `denied` 가 되면 앱이 권한 프롬프트를 다시 띄울 수 없다.

- 창 **설정** 화면의 "알림 권한" 절이 현재 상태(`허용됨` / `거부됨` / `미결정` / `임시 허용`)를 보여 주고, 거부 상태면 빨간 안내 상자와 **"시스템 설정 열기"** 버튼이 나온다. 버튼은 `x-apple.systempreferences:com.apple.Notifications-Settings.extension`(macOS 13+) 를 열고, 실패하면 구버전 `com.apple.preference.notifications` 로 폴백한다.
- 앱이 다시 활성화될 때마다(`applicationDidBecomeActive`) 권한 상태를 다시 읽으므로, 시스템 설정에서 켜고 돌아오면 표시가 바로 갱신된다.

### 복구 절차

1. 팝오버 → "설정 열기" → **시스템 설정 열기** (또는 시스템 설정 → 알림).
2. 목록에서 **Baton** 을 찾아 **"알림 허용"** 을 켠다.
3. 앱으로 돌아오면 표시가 `허용됨` 으로 바뀐다. 안 바뀌면 "권한 요청" 을 누른다.

### 주의

- **권한 프롬프트가 떠 있는 동안 앱을 강제 종료하면 그 번들 id 는 `denied` 로 기록된다.** 복구는 시스템 설정뿐이다.
- 검증하다 번들이 `denied` 로 굳었으면 `BATON_BUNDLE_ID` 로 다른 번들 id 를 써서 빌드하면 권한 상태가 초기화된 상태로 시작한다(`BATON_BUNDLE_ID=dev.baton.clo9 bash build.sh`). 번들 id 를 바꾸면 Keychain service·`defaults` 도메인도 함께 분리되므로 정식 설치본을 건드리지 않는다. 검증이 끝나면 `defaults delete <번들 id>` 와 `security delete-generic-password -s <번들 id> -a deviceToken` 로 정리한다.
- `LaunchServices` 를 거치지 않고 터미널에서 바이너리를 직접 실행하면 macOS 가 알림 등록을 거절해 `Notifications are not allowed for this application` 이 날 수 있다(CLO-9 검증에서 실측). 알림까지 확인하려면 `open build/Baton.app` 으로 띄운다.

## 개발 편의 플래그 (제품 동작에는 영향 없음)

| 설정 | 효과 |
|---|---|
| 환경변수 `BATON_DEV_OPEN_POPOVER=1` 또는 `defaults write <bundle> shell.devOpenPanel -bool true` | 시작 1.5초 뒤 설정·기록 창을 연다 (접근성 도구로 UI 검사용). CLO-107 이전의 폴백 패널을 대신한다 |
| `defaults write <bundle> shell.devWindowPane activity` | 위 플래그로 열 창의 첫 화면 (`settings` 기본 / `activity`) |
| `defaults write <bundle> shell.devActivityQuery <검색어>` | 활동 기록 검색창의 초기값. 접근성 도구의 타이핑·set-value 가 SwiftUI `TextField` 바인딩을 갱신하지 못해 검색 결과를 캡처할 수 없으므로 둔 우회로다 |
| `defaults write <bundle> shell.devPairingCode <code>` | pairing code 입력란을 미리 채운다 |
| 환경변수 `BATON_BUNDLE_ID` (build.sh) | 번들 id 변경. 알림 권한·Keychain service·`defaults` 도메인이 모두 번들 id 에 묶여 있어 검증 시 유용 |
| 환경변수 `BATON_TOKEN_STORE=file` | 디바이스 토큰을 Keychain 대신 파일에 저장 (위 "토큰 저장소") |
| 환경변수 `BATON_HOME` | 파일 토큰 저장소·데몬 실행 디렉터리의 기준 경로. 검증용 실행을 사용자의 `~/.baton` 과 분리한다 |
| `bash build.sh --dev` | `BATON_CODESIGN_IDENTITY` 또는 "Baton Dev" identity 로 고정 서명. 없으면 경고 후 ad-hoc (위 "개발용 고정 서명") |

## 실측 메모 (2026-09-04 ~ 2026-09-11, macOS 26.5 / CLT 6.3.3)

- `UNUserNotificationCenter.current()` 를 NSApplication launch 전에 호출하면 이후 권한 요청이 "Notifications are not allowed for this application" 으로 실패한다. `applicationWillFinishLaunching` 에서 처음 호출해야 한다.
- 권한 프롬프트가 떠 있는 동안 앱을 kill 하면 그 번들 id 는 `denied` 로 기록된다. 복구는 시스템 설정 → 알림에서 수동.
- 접근성(AX) `set-value` 는 SwiftUI `TextField` 바인딩을 갱신하지 않는다(값만 바뀌고 버튼 활성화가 안 됨). 자동화 시 실제 키 입력이 필요하다.
- ad-hoc(`--sign -`) 서명은 빌드마다 cdhash 가 바뀐다. 이전 빌드가 저장한 Keychain 항목을 새 빌드가 읽으면 "Baton이(가) dev.baton.desktop 에 저장된 비밀 정보를 사용하려고 합니다" 프롬프트가 뜨고(로그인 키체인 암호 요구) `SecItemCopyMatching` 이 그 스레드를 막는다. W4b 에서는 그게 main thread 라 데몬 IPC 가 통째로 멈췄고 데몬이 timeout 으로 죽었다. **CLO-9 에서 읽기를 전용 직렬 큐로 옮겨 해결**했다 — 프롬프트가 71초 떠 있어도 셸·데몬 모두 살아 있었다(`docs/clo9-verification.md`). 개발 중에는 여전히 `BATON_TOKEN_STORE=file` 이 편하다.
- 창 "활동 기록" 의 진행 목록은 "따라가기" 가 켜져 있으면 항목이 추가될 때 끝으로 자동 스크롤한다(`ScrollViewReader`). 접근성 도구의 합성 스크롤/드래그는 SwiftUI `ScrollView` 를 움직이지 못했다(W4b 실측).
- `NSHostingController` 는 SwiftUI 의 fitting size 를 창에 밀어 넣는다. `NavigationSplitView` 는 그 값이 화면 폭만큼 커서 창이 1512pt 로 열렸다(CLO-107 실측). `sizingOptions = []` 로 크기 전파를 끄고 `setContentSize` + `minSize` 로 직접 정한다.
- 창 크기·위치는 `NSWindow` frame autosave (`defaults` 키 `NSWindow Frame BatonMainWindow`) 로 유지된다. 검증 중 기본 크기를 바꿨는데 창이 그대로면 이 키를 지운다.
- volta 의 `node` 는 shim 이라 spawn 한 pid 와 실제 node pid 가 다르다. 셸은 `daemon.hello.pid` 를 종료 대상으로 쓴다.
- `swift build --arch a --arch b` 는 Xcode 의 xcbuild 가 필요해 CLT 에서 실패한다 → `--triple` 별 빌드 + `lipo`.
