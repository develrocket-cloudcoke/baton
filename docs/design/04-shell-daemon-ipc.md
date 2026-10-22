# 04. Desktop 셸 ↔ 데몬 IPC 계약 (stdin/stdout JSON Lines)

- 적용 대상: `apps/desktop-macos` (Swift 메뉴바 셸, W2b) 와 `apps/desktop-agent` (TypeScript 데몬, W2). 이후 Windows/Linux 셸도 이 계약을 그대로 쓴다.
- 근거: `docs/00-mvp-plan.md` D5 (Swift 셸 + Node 데몬 자식 프로세스), `docs/design/02-desktop-agent-and-adapter.md` §8, `poc/menubar/REPORT.md` §7.
- 역할 분담 (이 문서의 대전제):
  - **셸 = UI + 영속화 대행.** 메뉴바·팝오버·시스템 알림·로그인 항목을 담당하고, 데몬 대신 **설정(UserDefaults)** 과 **디바이스 토큰(Keychain)** 을 저장한다. 서버와 직접 통신하지 않는다.
  - **데몬 = 로직.** pairing, SSE 구독, Claude Code Adapter, 서버 REST 보고를 담당한다. 디스크에 비밀값을 쓰지 않고, 설정·토큰은 셸에 요청해서 받는다.
- 이 문서는 데몬 구현자가 그대로 코딩하는 계약이다. "권장"·"예를 들어" 없이 **MUST / MUST NOT** 로 쓴다.
- **구현 현황 안내 (2026-09-11 기준)**: 본 IPC 계약(프로토콜 v=1)은 `apps/desktop-macos`와 `apps/desktop-agent` 간에 완전 구현되어 동작 중이며, §10(팀 뿌리기·알림 dismiss) 및 §11(다중 프로젝트 `projects` 설정·중복 데몬 exit 17·실행 취소·heartbeat 60초)이 모두 반영되어 있습니다.

---

## 1. 전송 계층

| 항목 | 규칙 |
|---|---|
| 프로세스 | 셸이 데몬을 자식 프로세스로 spawn 한다. 명령은 셸 설정 `daemonCommand` (기본값 `node <repo>/apps/desktop-agent/dist/cli.js daemon --ipc stdio`). 셸은 명령 문자열을 공백 기준으로 나눠 argv 로 넘긴다(따옴표·셸 해석 없음). |
| 채널 | 데몬 **stdin** = 셸→데몬, 데몬 **stdout** = 데몬→셸. 데몬 **stderr** = 사람용 로그(셸이 `~/Library/Logs/Baton/daemon.log` 에 append). 데몬은 stdout 에 JSON Lines 외의 바이트를 MUST NOT 쓴다(디버그 출력은 stderr). |
| 프레이밍 | 메시지 1건 = JSON object 1개 + `\n`(0x0A). 메시지 안의 개행은 JSON 이스케이프(`\n`). 인코딩 UTF-8. BOM 금지. CR 은 무시한다(수신 측은 `\r\n` 도 받아들인다). |
| 크기 | 한 줄 최대 **1 MiB**. 초과 시 수신 측은 그 줄을 버리고 `ipc.oversize` 를 로그에 남긴다(연결은 유지). |
| 파서 | 수신 측은 바이트 버퍼에서 0x0A 를 찾아 자르는 **바이트 기반 파서**를 MUST 쓴다. 텍스트 line API(예: Swift `AsyncBytes.lines`) 는 빈 줄을 삼키거나 CR 처리가 달라 PoC 에서 이벤트 유실이 있었다. |
| 빈 줄 | 빈 줄(길이 0)은 keep-alive 로 간주하고 무시한다. |
| 환경변수 | 셸은 데몬에 `BATON_IPC=stdio`, `BATON_SHELL=macos`, `BATON_SHELL_VERSION=<셸 버전>`, `BATON_LOG_DIR=<로그 디렉터리>` 를 넣는다. PATH 는 셸이 `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` 을 앞에 붙여 전달한다(GUI 앱의 PATH 가 빈약하기 때문). |

## 2. 메시지 봉투

```json
{"v":1,"type":"request.notify","id":"d-42","ts":"2026-09-04T08:00:00.123Z","payload":{...}}
{"v":1,"type":"ack","id":"s-7","ts":"2026-09-04T08:00:00.130Z","replyTo":"d-42","payload":{}}
```

| 필드 | 타입 | 규칙 |
|---|---|---|
| `v` | int | 프로토콜 버전. 이 문서는 **1**. 양쪽 모두 MUST 넣는다. |
| `type` | string | 메시지 종류. `<도메인>.<동사>` 소문자 점 표기. §3 의 표에 없는 값은 "알 수 없는 타입"(§5). |
| `id` | string | 보낸 쪽에서 유일. 셸은 `s-<증가번호>`, 데몬은 `d-<증가번호>` 를 쓴다. 프로세스 재시작 시 번호는 1 부터 다시 시작해도 된다(재시작 후 이전 id 를 참조하는 응답은 오지 않는다). |
| `ts` | string | ISO 8601 UTC, 밀리초 포함 (`YYYY-MM-DDTHH:mm:ss.SSSZ`). |
| `replyTo` | string | **응답일 때만** 넣는다. 원 메시지의 `id`. 요청/이벤트에는 넣지 않는다(`null` 도 넣지 않는다). |
| `payload` | object | 항상 object. 내용이 없으면 `{}`. 배열·null·스칼라 금지. |

- 키 표기는 **camelCase**. (서버 REST 의 snake_case 와 다르다. 데몬이 변환한다.)
- 알 수 없는 payload 필드는 무시한다(전방 호환). 정의된 필드의 타입이 다르면 §5 의 `invalid_payload`.
- 메시지 분류: **request** = 상대가 반드시 응답(`replyTo`)해야 함, **event** = 응답 없음, **reply** = `replyTo` 를 가진 응답.

## 3. 메시지 목록

### 3.1 방향·분류 요약

| type | 방향 | 분류 | 응답 type |
|---|---|---|---|
| `daemon.hello` | 데몬→셸 | request | `shell.hello` |
| `daemon.status` | 데몬→셸 | event | – |
| `request.notify` | 데몬→셸 | request | `ack` |
| `execution.progress` | 데몬→셸 | event | – |
| `settings.schema` | 데몬→셸 | event | – |
| `settings.get` | 데몬→셸 | request | `settings.value` |
| `settings.set` | 데몬→셸 | request | `settings.value` |
| `token.get` | 데몬→셸 | request | `token.value` |
| `token.set` | 데몬→셸 | request | `token.value` |
| `daemon.log` | 데몬→셸 | event | – |
| `shell.hello` | 셸→데몬 | reply | – |
| `settings.changed` | 셸→데몬 | event | – |
| `pair.start` | 셸→데몬 | request | `pair.result` |
| `notification.clicked` | 셸→데몬 | request | `ack` |
| `daemon.shutdown` | 셸→데몬 | request | `ack` |
| `ack` | 양방향 | reply | – |
| `error` | 양방향 | reply | – |

`settings.get/set`, `token.get/set` 은 **데몬이 요청하고 셸이 응답**한다("Keychain 대행"). 셸이 먼저 값을 밀어 넣는 경로는 `shell.hello`(초기값) 와 `settings.changed`(변경 통지) 두 가지뿐이다.

### 3.2 핸드셰이크

**`daemon.hello`** (데몬→셸, request). 데몬 프로세스가 시작한 뒤 **10초 안에 첫 줄로** MUST 보낸다. 그 전에는 다른 메시지를 MUST NOT 보낸다.

```json
{"v":1,"type":"daemon.hello","id":"d-1","ts":"2026-09-04T08:00:00.000Z","payload":{
  "protocol":1,
  "daemonVersion":"0.1.0",
  "pid":48213,
  "capabilities":["pairing","sse","claude-code"]
}}
```

| payload | 타입 | 규칙 |
|---|---|---|
| `protocol` | int | 데몬이 구현한 프로토콜 버전. 셸의 버전과 다르면 §5 `protocol_mismatch`. |
| `daemonVersion` | string | 표시용. |
| `pid` | int | 데몬 자신의 pid. 셸이 종료 시 신호를 보낼 때 쓴다. |
| `capabilities` | string[] | 표시용. 현재 정의: `pairing`, `sse`, `claude-code`. |

**`shell.hello`** (셸→데몬, `daemon.hello` 의 reply). 현재 설정과 토큰을 함께 준다. 데몬은 이 값으로 바로 시작할 수 있고, 이후 `settings.get`/`token.get` 으로 다시 읽어도 된다.

```json
{"v":1,"type":"shell.hello","id":"s-1","ts":"…","replyTo":"d-1","payload":{
  "protocol":1,
  "shellVersion":"0.1.0",
  "platform":"macos",
  "settings":{"serverUrl":"https://baton.example.com","projects":"[{\"name\":\"backend-api\",\"path\":\"/Users/b/work/backend-api\",\"projectIds\":{}}]","deviceId":"dev_01H…","lastEventId":"183"},
  "deviceToken":"eyJhbGciOi…"
}}
```

| payload | 타입 | 규칙 |
|---|---|---|
| `protocol` | int | 셸의 프로토콜 버전. |
| `shellVersion`, `platform` | string | 표시용. `platform` ∈ `macos`, `windows`, `linux`. |
| `settings` | object | §4 의 전체 설정. 값이 없는 키는 `null`. |
| `deviceToken` | string \| null | Keychain 의 디바이스 토큰. 없으면 `null`. |

핸드셰이크 완료 뒤 데몬은 즉시 `settings.schema` 와 `daemon.status` 를 보낸다(순서 무관).

### 3.3 데몬 → 셸

**`daemon.status`** (event). 상태가 바뀔 때마다, 그리고 바뀌지 않아도 **60초마다** 보낸다(셸은 120초 동안 못 받으면 데몬을 hung 으로 보고 재시작한다, §6).

```json
{"v":1,"type":"daemon.status","id":"d-9","ts":"…","payload":{
  "state":"connected",
  "since":"2026-09-04T08:00:03.000Z",
  "deviceId":"dev_01H…",
  "lastError":null,
  "activeExecutionId":null
}}
```

| payload | 타입 | 규칙 |
|---|---|---|
| `state` | string | `idle`(토큰 없음/미연결), `connecting`(pairing 또는 SSE 연결 중), `connected`(SSE 연결됨, 대기), `running`(Execution 실행 중). |
| `since` | string | 현재 `state` 가 시작된 시각. |
| `deviceId` | string \| null | 서버가 준 디바이스 id. |
| `lastError` | object \| null | `{ "code": string, "message": string, "at": string }`. 마지막 오류. 정상 복귀 후에도 남길 수 있으며, 셸은 `state` 가 `connected`/`running` 이면 회색으로 표시한다. |
| `activeExecutionId` | string \| null | `running` 일 때 실행 중인 Execution id. |

**`request.notify`** (request, 응답 `ack`). 셸이 시스템 알림을 띄운다. 같은 `notificationId` 가 다시 오면 셸은 기존 알림을 갱신한다(중복 배너 금지).

```json
{"v":1,"type":"request.notify","id":"d-12","ts":"…","payload":{
  "notificationId":"ntf_01H…",
  "kind":"request.delivered",
  "requestId":"req_01H…",
  "title":"새로운 Baton 요청",
  "body":"A → 나 · 로그인 API 오류 해결 요청",
  "webUrl":"https://baton.example.com/requests/req_01H…"
}}
```

| payload | 타입 | 규칙 |
|---|---|---|
| `notificationId` | string | 알림 식별자. 셸은 이 값을 `UNNotificationRequest.identifier` 로 쓴다. |
| `kind` | string | `request.delivered`, `request.returned`, `request.rejected`, `execution.finished`, `execution.failed`, `result.delivered`, `generic`. 셸은 모르는 값을 `generic` 으로 취급한다. |
| `requestId` | string \| null | 관련 Request. |
| `title`, `body` | string | 알림 제목·본문. 각 200자 이내(셸이 자른다). |
| `webUrl` | string \| null | 클릭 시 셸이 기본 브라우저로 여는 URL. `http`/`https` 만 허용, 그 외 스킴은 셸이 열지 않고 `notification.clicked` 만 보낸다. |

**`execution.progress`** (event). 팝오버 "활동" 탭에 한 줄씩 표시한다. 셸은 최근 200건만 보관한다.

```json
{"v":1,"type":"execution.progress","id":"d-30","ts":"…","payload":{
  "executionId":"exe_01H…",
  "requestId":"req_01H…",
  "phase":"testing",
  "message":"테스트 실행",
  "at":"2026-09-04T08:05:12.169Z"
}}
```

| payload | 타입 | 규칙 |
|---|---|---|
| `phase` | string | 02 §4.2 의 kind: `started`, `reading_input`, `exploring`, `editing`, `command`, `testing`, `test_passed`, `test_failed`, `blocked`, `note`, `warning`, `writing_result`, `finished`, `finished_partial`, `failed`, `cancelled`. 셸은 모르는 값을 `note` 처럼 표시한다. |
| `message` | string | 표시 문구 (200자 이내). |
| `at` | string | 이벤트 발생 시각. |

**`settings.schema`** (event). 셸의 설정 화면이 이 스키마로 폼을 그린다. 핸드셰이크 직후 1회, 이후 바뀌면 다시 보낸다.

```json
{"v":1,"type":"settings.schema","id":"d-2","ts":"…","payload":{"fields":[
  {"key":"serverUrl","label":"서버 URL","type":"url","required":true,"default":"https://baton.example.com","help":"Baton 서버 주소"},
  {"key":"projects","label":"프로젝트 목록","type":"projects","required":false,"default":"[]","help":"이름 + 로컬 경로. 설치된 에이전트마다 등록된다"},
  {"key":"deviceId","label":"디바이스 ID","type":"string","required":false,"default":null,"readonly":true},
  {"key":"lastEventId","label":"마지막 이벤트","type":"string","required":false,"default":"0","hidden":true}
]}}
```

| field | 타입 | 규칙 |
|---|---|---|
| `key` | string | `^[a-zA-Z][a-zA-Z0-9]*$`. 셸은 UserDefaults 키 `settings.<key>` 에 저장한다. |
| `type` | string | `string`, `url`, `path`(디렉터리 선택 버튼), `bool`, `int`. 값은 각각 string/string/string/bool/int 로 저장·전달한다. 비밀값 타입은 없다(토큰은 `token.*` 로만 다룬다). |
| `required`, `readonly`, `hidden` | bool | 기본 false. `readonly` 는 표시만, `hidden` 은 표시하지 않음. |
| `default` | any \| null | 값이 없을 때 셸이 돌려주는 기본값. |

**`settings.get`** (request, 응답 `settings.value`). `keys` 를 생략하면 전체.

```json
{"v":1,"type":"settings.get","id":"d-3","ts":"…","payload":{"keys":["serverUrl","lastEventId"]}}
{"v":1,"type":"settings.value","id":"s-4","ts":"…","replyTo":"d-3","payload":{"settings":{"serverUrl":"https://baton.example.com","lastEventId":"183"}}}
```

**`settings.set`** (request, 응답 `settings.value` 에 **전체** 설정). `patch` 의 값이 `null` 이면 그 키를 삭제한다. 셸은 `readonly` 여부와 무관하게 데몬의 set 을 받아들인다(데몬이 `deviceId`, `lastEventId` 를 갱신하는 경로).

```json
{"v":1,"type":"settings.set","id":"d-20","ts":"…","payload":{"patch":{"deviceId":"dev_01H…","lastEventId":"184"}}}
{"v":1,"type":"settings.value","id":"s-9","ts":"…","replyTo":"d-20","payload":{"settings":{"serverUrl":"…","projects":"…","deviceId":"dev_01H…","lastEventId":"184"}}}
```

**`token.get`** / **`token.set`** (request, 응답 `token.value`). 셸은 Keychain(service `dev.baton.desktop`, account `deviceToken`) 에 저장한다. `token.set` 의 `deviceToken` 이 `null` 이면 삭제(로그아웃).

```json
{"v":1,"type":"token.get","id":"d-4","ts":"…","payload":{}}
{"v":1,"type":"token.value","id":"s-5","ts":"…","replyTo":"d-4","payload":{"deviceToken":null}}
{"v":1,"type":"token.set","id":"d-18","ts":"…","payload":{"deviceToken":"eyJhbGciOi…"}}
{"v":1,"type":"token.value","id":"s-8","ts":"…","replyTo":"d-18","payload":{"deviceToken":"eyJhbGciOi…"}}
```

Keychain 접근이 실패하면 셸은 `error{code:"keychain_error"}` 로 응답하고, 데몬은 메모리의 토큰으로 계속 동작하되 `daemon.status.lastError` 에 남긴다.

**`daemon.log`** (event, 선택). 셸의 "활동" 탭 로그 영역에 표시한다. `level` ∈ `debug`, `info`, `warn`, `error`. 양이 많은 로그는 stderr 로 보내고, 이 메시지는 사용자에게 보여줄 가치가 있는 것만 쓴다.

```json
{"v":1,"type":"daemon.log","id":"d-33","ts":"…","payload":{"level":"warn","message":"SSE 재연결 (3회째)"}}
```

### 3.4 셸 → 데몬

**`settings.changed`** (event). 사용자가 설정 화면에서 값을 바꿔 저장했을 때 전체 설정을 보낸다. 데몬은 필요한 경우(예: `serverUrl` 변경) 스스로 재연결한다.

```json
{"v":1,"type":"settings.changed","id":"s-12","ts":"…","payload":{"settings":{"serverUrl":"https://baton.example.com","projects":"[{\"name\":\"backend-api\",\"path\":\"/Users/b/work/backend-api\",\"projectIds\":{}}]","deviceId":"dev_01H…","lastEventId":"184"}}}
```

**`pair.start`** (request, 응답 `pair.result`). 사용자가 pairing code 를 입력하고 "Pairing" 을 눌렀을 때. 데몬은 서버에 pairing 을 요청하고, 성공하면 **먼저 `token.set` 과 `settings.set`(deviceId) 을 셸에 보내 저장을 끝낸 뒤** `pair.result` 를 응답한다. 응답 제한 시간은 30초.

```json
{"v":1,"type":"pair.start","id":"s-20","ts":"…","payload":{"pairingCode":"BATON-PAIR-123","deviceName":"민수의 MacBook"}}
{"v":1,"type":"pair.result","id":"d-40","ts":"…","replyTo":"s-20","payload":{"ok":true,"deviceId":"dev_01H…","error":null}}
{"v":1,"type":"pair.result","id":"d-41","ts":"…","replyTo":"s-21","payload":{"ok":false,"deviceId":null,"error":{"code":"invalid_pairing_code","message":"pairing code 가 올바르지 않습니다"}}}
```

**`notification.clicked`** (request, 응답 `ack`). 사용자가 시스템 알림을 클릭했을 때. 셸은 이 메시지를 보내는 것과 **별개로** `webUrl` 이 있으면 즉시 기본 브라우저로 연다(데몬 응답을 기다리지 않는다). 데몬이 죽어 있으면 셸은 메시지를 버리고 URL 만 연다.

```json
{"v":1,"type":"notification.clicked","id":"s-30","ts":"…","payload":{
  "notificationId":"ntf_01H…",
  "requestId":"req_01H…",
  "webUrl":"https://baton.example.com/requests/req_01H…",
  "action":"default",
  "clickedAt":"2026-09-04T08:06:00.000Z"
}}
```

| payload | 타입 | 규칙 |
|---|---|---|
| `action` | string | `default`(배너 본문 클릭), `dismiss`(닫음). |

**`daemon.shutdown`** (request, 응답 `ack`). 데몬은 `ack` 를 보낸 뒤 실행 중인 자식 프로세스(claude)에 SIGINT 를 보내고 **5초 안에 exit code 0** 으로 종료한다. `reason` ∈ `app_quit`, `restart`, `settings_changed`, `protocol_mismatch`.

```json
{"v":1,"type":"daemon.shutdown","id":"s-40","ts":"…","payload":{"reason":"app_quit"}}
```

### 3.5 공통 응답

```json
{"v":1,"type":"ack","id":"d-50","ts":"…","replyTo":"s-30","payload":{}}
{"v":1,"type":"error","id":"s-51","ts":"…","replyTo":"d-12","payload":{"code":"invalid_payload","message":"title is required","retryable":false,"details":{"field":"title"}}}
```

| payload | 타입 | 규칙 |
|---|---|---|
| `code` | string | §5 의 코드 중 하나 또는 도메인 코드(snake_case). |
| `message` | string | 사람이 읽을 설명. |
| `retryable` | bool | 같은 요청을 다시 보내도 되는지. |
| `details` | object | 선택. |

## 4. 설정 키 (셸 UserDefaults, `settings.<key>`)

| key | 타입 | 소유 | 비고 |
|---|---|---|---|
| `serverUrl` | string | 사용자 입력 | 필수. |
| `deviceId` | string \| null | 데몬(`settings.set`) | pairing 성공 시 데몬이 기록. |
| `agents` | string (JSON 객체) | 데몬(`settings.set`) | `{"CLAUDE_CODE":"<agentId>", …}`. 설치된 에이전트마다 하나. 기본값 `"{}"`. |
| `lastEventId` | string | 데몬(`settings.set`) | SSE `Last-Event-ID`. 데몬이 이벤트 처리 후마다 기록. |
| `deviceName` | string | 셸 기본값(호스트명) | pairing 시 표시명. |

셸 전용(데몬에 보내지 않음): `daemonCommand`(데몬 실행 명령), `launchAtLogin`(SMAppService 상태는 시스템이 진실이므로 캐시일 뿐). 디바이스 토큰은 UserDefaults 에 MUST NOT 저장한다.

## 5. 오류 규칙

| 상황 | 동작 |
|---|---|
| JSON 파싱 실패한 줄 | 수신 측은 그 줄을 버리고 `ipc.malformed` 로그. **셸은 연속 3줄** 파싱 실패 시 데몬을 재시작한다(§6). 데몬은 계속 동작한다. |
| 봉투 필드 누락/타입 오류 (`v`,`type`,`id`,`ts`,`payload`) | 버리고 `ipc.invalid_envelope` 로그. `id` 가 있으면 `error{code:"invalid_envelope"}` 응답. |
| 알 수 없는 `type` | request 로 추정할 수 없으므로: `id` 가 있으면 `error{code:"unknown_type", retryable:false}` 응답, 그리고 무시. |
| payload 필드 타입 오류 | `error{code:"invalid_payload", details:{field}}` 응답 후 무시. |
| `protocol` 불일치 | 셸이 `error{code:"protocol_mismatch"}` 를 `daemon.hello` 에 응답하고 `daemon.shutdown{reason:"protocol_mismatch"}` 를 보낸 뒤 재시작하지 않는다. UI 에 "데몬 버전 불일치" 표시. |
| request 응답 지연 | 셸→데몬 request 는 10초(`pair.start` 는 30초) 안에 응답이 없으면 `timeout` 으로 처리하고 UI 에 표시한다. 데몬→셸 request 는 셸이 동기적으로(100ms 안에) 응답한다. |
| 응답의 `replyTo` 가 미지 | 버리고 로그. |
| 데몬이 `daemon.hello` 전에 다른 메시지를 보냄 | 셸은 버리고 로그. |
| `request.notify` 의 `webUrl` 스킴이 http/https 가 아님 | 셸은 알림은 띄우되 클릭 시 URL 을 열지 않는다. |

오류 코드(고정): `invalid_envelope`, `invalid_payload`, `unknown_type`, `protocol_mismatch`, `timeout`, `keychain_error`, `not_paired`, `invalid_pairing_code`, `server_unreachable`, `internal`.

## 6. 데몬 생명주기와 재시작 정책 (셸 구현 규칙)

1. **spawn**: 앱 시작 시 `daemonCommand` 로 spawn. stdin/stdout 파이프, stderr → 로그 파일. 시작 시각 기록.
2. **핸드셰이크 타임아웃**: 10초 안에 `daemon.hello` 가 없으면 SIGKILL 후 재시작(아래 백오프).
3. **hung 감지**: `daemon.status` 를 120초 동안 못 받으면 SIGTERM → 3초 → SIGKILL 후 재시작.
4. **비정상 종료 재시작**: 데몬이 셸의 `daemon.shutdown` 없이 종료되면(exit code 무관) 백오프 후 재시작. 백오프 = 1s, 2s, 4s, 8s, 16s, 32s, **최대 60s**. 데몬이 **5분** 이상 살아 있으면 백오프를 1s 로 리셋. 백오프 중 UI 는 `state=idle`, `lastError={code:"daemon_exited", message:"exit <code>"}` 로 표시한다.
5. **정상 종료**: `daemon.shutdown` 을 보낸 뒤의 종료는 재시작하지 않는다(재시작 목적이면 셸이 직접 다시 spawn).
6. **앱 종료 순서**: `daemon.shutdown{reason:"app_quit"}` → `ack` 또는 5초 대기 → SIGTERM → 3초 → SIGKILL. 그 다음 셸이 종료한다.
7. **process group**: 셸은 데몬을 자기 프로세스 그룹에 두지 않고 **데몬이 자기 pgid 의 리더가 되도록** 실행한다(macOS 셸은 `posix_spawn` 의 `POSIX_SPAWN_SETSID` 에 해당하는 옵션이 Foundation `Process` 에 없으므로, 데몬 CLI 가 시작 직후 `setsid`/`setpgid(0,0)` 를 스스로 호출한다 — Node 는 `child_process` 로 자식을 `detached:true` 로 띄워 같은 효과를 낸다). 종료 시 셸은 `kill(-pgid, SIGTERM)` 로 데몬과 그 자식(claude)을 함께 종료한다. `pgid` 는 `daemon.hello.pid` 와 같다고 가정한다.
8. **stdin EOF**: 셸이 비정상 종료(crash, SIGKILL)되면 데몬의 stdin 이 EOF 가 된다. 데몬은 stdin EOF 를 받으면 자식 프로세스에 SIGINT 를 보내고 **5초 안에 종료**한다. 이것이 고아 데몬을 막는 최종 수단이다.
9. **단일 인스턴스**: 셸은 데몬을 한 번에 하나만 띄운다. 재시작 전 이전 프로세스가 완전히 종료되었는지(`waitpid`) 확인한다.
10. **로그**: 데몬 stderr 와 셸의 IPC 오류 로그는 `~/Library/Logs/Baton/daemon.log`, `~/Library/Logs/Baton/shell.log` 에 append. 파일당 5 MB 넘으면 `.1` 로 회전(1세대만 보관).

## 7. 시퀀스 예시

```text
셸                                         데몬
 │  spawn ─────────────────────────────────▶│
 │◀── daemon.hello {protocol:1,pid} ────────│
 │── shell.hello {settings, deviceToken} ──▶│   (reply)
 │◀── settings.schema ──────────────────────│
 │◀── daemon.status {state:idle}  ──────────│   (토큰 없음)
 │── pair.start {pairingCode} ─────────────▶│   (사용자 입력)
 │◀── token.set {deviceToken} ──────────────│
 │── token.value ──────────────────────────▶│   (Keychain 저장 완료)
 │◀── settings.set {deviceId} ──────────────│
 │── settings.value ───────────────────────▶│
 │◀── pair.result {ok:true} ────────────────│
 │◀── daemon.status {state:connecting} ─────│
 │◀── daemon.status {state:connected} ──────│
 │◀── request.notify {…} ───────────────────│   (서버 SSE 로 Request 도착)
 │── ack ──────────────────────────────────▶│
 │   (사용자가 배너 클릭 → 셸이 webUrl open)  │
 │── notification.clicked ─────────────────▶│
 │◀── ack ──────────────────────────────────│
 │◀── daemon.status {state:running} ────────│
 │◀── execution.progress × N ───────────────│
 │◀── settings.set {lastEventId} ───────────│
 │── settings.value ───────────────────────▶│
 │◀── daemon.status {state:connected} ──────│
 │── daemon.shutdown {app_quit} ───────────▶│   (앱 종료)
 │◀── ack ──────────────────────────────────│
 │   waitpid (≤5s) → SIGTERM → SIGKILL       │
```

## 8. 적합성 체크리스트 (데몬 구현 완료 기준)

- [ ] stdout 에 JSON Lines 외 출력이 없다 (`node cli.js daemon --ipc stdio < /dev/null | head -1` 이 `daemon.hello` 한 줄).
- [ ] `daemon.hello` 가 첫 줄이며 10초 안에 나온다.
- [ ] `shell.hello` 를 받기 전에는 다른 메시지를 보내지 않는다.
- [ ] `daemon.status` 를 60초마다 보낸다.
- [ ] `daemon.shutdown` 에 `ack` 후 5초 안에 exit 0.
- [ ] stdin EOF 후 5초 안에 종료하고 자식 claude 프로세스도 남지 않는다.
- [ ] `settings.set`/`token.set` 의 응답(`*.value`) 을 받은 뒤에만 `pair.result{ok:true}` 를 보낸다.
- [ ] 알 수 없는 type 의 request 에 `error{unknown_type}` 로 응답한다.
- [ ] 1 MiB 초과 줄을 보내지 않는다.

`apps/desktop-macos/scripts/fake-daemon.mjs` 가 이 체크리스트를 만족하는 참조 구현이다(서버 통신은 없고 시나리오만 재생).

## 9. 구현 메모 — macOS 셸 (apps/desktop-macos, 2026-09-04)

W2b 에서 이 계약을 Swift 셸에 구현하고 `scripts/fake-daemon.mjs` 로 검증했다. 데몬(W2) 구현 시 참고할 셸 측 동작:

| 항목 | 셸 동작 (실측) |
|---|---|
| 핸드셰이크 | `daemon.hello` 수신 즉시 `shell.hello` 로 응답. 응답에 현재 설정 전체와 Keychain 토큰(없으면 `null`) 포함. 이후 `settings.get/set`, `token.get/set` 요청은 main thread 에서 동기 처리(수 ms). |
| `request.notify` | `UNNotificationRequest.identifier = notificationId` 로 게시하고 `ack`. 팝오버 "알림" 탭에 최근 5건 유지. 클릭 시 `webUrl`(http/https) 을 `NSWorkspace.open` 으로 열고 `notification.clicked` 전송(데몬 응답과 무관). |
| 재시작 | 비정상 종료 시 1s→2s→4s… 최대 60s 백오프(실측: exit 3 → 1s → 2s 순으로 재시작). `daemon.shutdown` 후 종료는 재시작하지 않음. 앱 종료 시 `daemon.shutdown{app_quit}` → `ack` → exit 0 확인 후 셸 종료. |
| stdin EOF | 셸이 kill 되면 데몬 stdin 이 EOF → fake-daemon 은 즉시 종료(§6-8 준수 확인). 실제 데몬도 반드시 구현. |
| pid | volta 등 shim 을 거치면 spawn pid 와 실제 node pid 가 다르다. 셸은 `daemon.hello.pid` 를 신호 대상으로 쓴다 → 데몬은 **자기 실제 pid** 를 넣어야 한다. |
| 로그 | 데몬 stderr 는 `~/Library/Logs/Baton/daemon.log` 에 그대로 append. stdout 에 JSON 외 출력이 섞이면 `ipc.malformed` 로 기록되고 연속 3회면 재시작된다. |
| 검증 도구 | `swift run baton-ipc-selftest`(봉투/파서), `bash scripts/run-dev.sh --fake`(전체 흐름). fake-daemon 은 `SIGUSR1` 로 `request.notify` 를 추가 발송한다. |

## 10. 추가 메시지 — 조직·팀 (W5d-1, 2026-09-07, 추가 전용)

05 문서(조직·팀·통신 허용 모델) §3.2 팀 전체 뿌리기와 §3.4 사용자별 pairing 코드를 위해 아래를 추가한다. §3 의 기존 메시지는 바뀌지 않는다.

### 10.1 `notification.dismiss` (데몬→셸, request, 응답 `ack`)

팀에 뿌려진 요청을 다른 팀원이 먼저 처리(claim)해 서버가 `request.claimed` 를 보내면, 데몬은 그 요청으로 띄웠던 알림을 지우라고 셸에 요청한다. 셸은 시스템 알림(배너·알림 센터 항목)을 제거하고, 팝오버 "알림" 탭 항목은 지우지 않고 `note` 로 갱신한다(뱃지 "처리 중").

```json
{"v":1,"type":"notification.dismiss","id":"d-60","ts":"…","payload":{
  "notificationId":"ntf_req_req_01H…",
  "requestId":"req_01H…",
  "reason":"claimed",
  "note":"처리 중: 박인프라",
  "claimedBy":"박인프라"
}}
```

| payload | 타입 | 규칙 |
|---|---|---|
| `notificationId` | string \| null | 제거할 알림 id. null 이면 셸은 `requestId` 가 같은 알림 항목을 모두 대상으로 한다. |
| `requestId` | string \| null | 관련 Request. |
| `reason` | string | `claimed`(다른 팀원이 처리), `withdrawn`, `generic`. 셸은 모르는 값을 `generic` 으로 취급한다. |
| `note` | string \| null | 알림 탭 항목에 남길 한 줄. `claimed` 면 `"처리 중: <이름>"`. |
| `claimedBy` | string \| null | 처리한 사람 표시명. |

- 셸이 해당 알림을 목록에 갖고 있지 않아도(앱 재시작 등) `notificationId` 가 있으면 시스템 알림 제거는 시도하고 `ack` 를 보낸다.
- `reason` 이 `claimed` 이면 셸은 항목의 `kind` 를 `request.claimed` 로 바꿔 뱃지를 "처리 중" 으로 표시한다.

| type | 방향 | 분류 | 응답 type |
|---|---|---|---|
| `notification.dismiss` | 데몬→셸 | request | `ack` |

### 10.2 `request.notify` 의 팀 뿌리기 표기 (규칙 추가)

- 서버 SSE `request.delivered` payload 에 `recipientTeam`(`{ id?, name }` 또는 팀 이름) 이 있고 `recipientUserId` 가 `null` 이면 팀 전체 뿌리기다. 데몬은 `title` 을 `"팀 <이름> 에 새 요청"`, `body` 를 `"<보낸 사람> → 팀 <이름> · <요청 제목>"` 으로 만든다(`kind` 는 그대로 `request.delivered`).
- 데몬은 `request.delivered` 알림의 `notificationId` 를 `ntf_req_<requestId>` 로 고정한다. 같은 요청이 재전송되면 같은 id 로 갱신되고(§3.3 중복 배너 금지), claim 시 같은 id 를 `notification.dismiss` 로 지운다.
- 서버 SSE `request.claimed` payload: `{ requestId, title?, claimedBy: { userId?, displayName } | string, claimedAt?, self?, webUrl? }`. 서버는 처리한 본인에게는 보내지 않는다(05 §3.2). 데몬은 방어적으로 `self === true` 이거나 `claimedBy.userId` 가 자신의 `userId`(pairing 응답에 있을 때만 저장, 설정 키 `userId`, hidden) 와 같으면 무시한다.

### 10.3 `pair.start` / `pair.result` (규칙 추가)

- `pair.start.pairingCode` 는 웹 "내 디바이스" 에서 발급한 사용자별 1회용 코드 `XXXX-XXXX`(05 §3.4) 다. IPC 필드명은 그대로 `pairingCode` 이고, 데몬이 서버 `POST /v1/devices/pair` 에 `{ code, deviceName }` 으로 보낸다(소문자·공백·하이픈 누락은 데몬이 정규화).
- 서버가 403(만료·재사용·미발급)·400(형식) 을 주면 `pair.result.error` 는 `{ code: "invalid_pairing_code", message: <서버 사유 그대로> }` 다(예: `"만료된 pairing 코드입니다."`). 셸은 이 `message` 를 설정 탭 pairing 상태에 표시한다.
- 설정 탭 안내 문구: "웹 → 내 디바이스에서 발급한 코드 (XXXX-XXXX, 10분 안에 입력)".

## 11. 추가 — 프로젝트 여러 개·heartbeat·실행 취소·중복 데몬 (W6c, 2026-09-09, 추가 전용)

`docs/mvp-acceptance.md` §4 이슈 4·5(Agent presence 만료, 데몬의 프로젝트 매핑), §9.4 이슈 1(디바이스 정보)을 해소한다.
§3 의 기존 메시지 종류는 바뀌지 않고, 설정 키 하나와 종료 코드 하나가 늘어난다.

### 11.1 설정 키 `projects` — 프로젝트 목록 (§4 표에 추가)

| key | 타입 | 소유 | 비고 |
|---|---|---|---|
| `projects` | string (JSON 배열) | 사용자 입력(셸 목록 UI) + 데몬(`projectIds` 기록) | `[{ "name": string, "path": string, "projectIds": { "<provider>": string \| null } }]`. 기본값 `"[]"`. |

- `settings.schema` 의 `type` 에 **`projects`** 를 추가한다. 셸은 이 타입을 텍스트 필드가 아니라 **행 목록 UI**(이름 + 로컬 경로, 추가·삭제, 디렉터리 선택)로 그린다. 그 밖의 타입 규칙(§3.3)은 그대로다.
- 값은 UserDefaults 에 **JSON 문자열**로 저장한다(문자열이라 §3.3 의 `settings.value` 타입 규칙을 그대로 지킨다).
- **소유권**: `name`·`path` 는 사용자가, `projectIds` 는 데몬이 쓴다. 서버의 Project 는 **Agent 소속**이라(`schema.prisma`) 같은 경로라도 provider 마다 Project 가 따로 생긴다 — 그래서 id 가 하나가 아니라 provider → id 맵이다. 데몬은 비어 있는 (provider, 경로) 조합을 `POST /v1/desktop/projects` 로 등록하고 받은 id 를 채워 `settings.set{patch:{projects}}` 로 되돌려 저장한다.
- **실행 라우팅**: 데몬은 `execution.command.requested` 의 `projectId` 와 같은 항목의 `path` 에서 Claude Code 를 실행한다.
  - 매핑에 없으면 **claude 를 띄우지 않고** `POST /v1/desktop/executions/:id/result` 에 `status:"FAILED"` 와 사유(등록된 프로젝트 목록 포함)를 보고하고, `execution.progress{phase:"failed"}` 와 `request.notify{kind:"execution.failed"}` 를 셸에 보낸다.
  - 명령에 `projectId` 가 없으면(구버전 서버) 목록의 첫 프로젝트를 쓰고 경고 로그를 남긴다.
  - `projectId` 는 어느 provider 의 것이든 같은 로컬 경로를 가리키므로, 데몬은 맵 전체에서 찾는다.

### 11.1.1 설치된 에이전트마다 Agent 를 등록한다

`provider` 를 사람이 고르던 설정 키는 **없앴다.** 데몬이 시작·재연결할 때 `CLAUDE_CODE`/`CODEX`/`AGY`
어댑터의 `detect()`(= `<binary> --version`)를 돌려 **설치된 것마다** `POST /v1/desktop/agents` 로
Agent 를 등록하고 `settings.agents` 에 `{provider: agentId}` 로 보관한다.

- 서버는 이미 (device, provider) 당 Agent 하나를 재사용한다(`canonicalAgent`) — 서버 변경은 없다.
- heartbeat 는 provider 마다 capability 가 다르므로 **등록된 Agent 마다 한 번씩** 보낸다.
- 실행 명령은 `provider` 로 어댑터를, `agentId` 로 우리 것인지 확인한다. 등록하지 않은 provider
  (그 CLI 가 이 기기에 없다) 면 실행하지 않고 FAILED + 사유를 보고한다.
- `--provider` 플래그·`BATON_PROVIDER` 는 "이것만 쓴다" 는 **제한**으로 남는다(테스트·콘솔용).

**구버전 호환(한 번만, 데몬 시작 시 자동)**
- `projectPath`(단일 경로) → `projects` 목록의 항목 하나로 옮기고 키를 지운다.
- 항목의 `projectId`(단수) → 그때 등록돼 있던 `agentProvider` 자리의 `projectIds` 로 옮긴다.
- `provider`·`projectId`·`agentId`·`agentProvider` 키는 지운다.

### 11.2.1 디바이스 해제 — `connection.revoked` (종료하지 않는다)

서버가 SSE 를 끊는 이유는 두 가지이고 **데몬이 해야 할 일이 반대다.**

| 이벤트 | 언제 | 데몬 |
|---|---|---|
| `connection.replaced` | 다른 데몬이 같은 디바이스로 붙었다 | 종료한다 (exit 17) |
| `connection.revoked` | 사람이 웹에서 이 디바이스를 해제했다 | **종료하지 않는다.** 토큰·등록 id 를 지우고 `idle`(`not_paired`) 로 돌아가 다음 pairing 을 기다린다 |

2026-09-21 이전에는 해제도 `connection.replaced` 로 보냈다. 그래서 웹에서 디바이스를
해제하면 데몬이 exit 17 로 죽고, 셸은 그 코드를 "중복 실행" 으로 보아 **재시작을 포기**했다.
그 상태에서 다시 pairing 하려 하면 보낼 데몬이 없어 `daemon not running` 이 떴고,
앱을 재시작하는 것 말고는 복구할 방법이 없었다.

셸도 같이 고쳤다 — **pairing 은 데몬이 죽어 있어도 돼야 한다.** `ensureRunning()` 이
필요하면 데몬을 먼저 띄우고 핸드셰이크를 기다린 뒤 `pair.start` 를 보낸다. 백오프 대기 중
같은 다른 이유로 데몬이 없을 때도 같은 경로로 복구된다.

### 11.2 중복 데몬 종료 — 종료 코드 `17` (§6 재시작 정책에 추가)

서버는 디바이스당 SSE 연결을 1개로 제한하고(`apps/server/src/desktop/connections.ts`), 새 데몬이 붙으면 **기존 연결에 `event: connection.replaced`(payload `{ reason }`, `id:` 없음)를 보낸 뒤 스트림을 닫는다.** 데몬은 이때:

1. 재연결하지 **않는다**(백오프 없음).
2. `daemon.status{ state:"idle", lastError:{ code:"connection_replaced", message:<서버 사유> } }` 와 `daemon.log{level:"error"}` 로 셸에 알린다.
3. 정리 후 **exit code 17** 로 종료한다.

**셸 규칙(§6-4 예외)**: 종료 코드가 `17` 이면 백오프 재시작을 하지 않고 `state=failed`, 사유 "다른 데몬이 이 디바이스에 연결되어 종료했습니다 (중복 실행)" 로 표시한다. 재시작하면 두 데몬이 서로를 밀어내는 루프가 된다. 데몬 CLI 의 상수는 `EXIT_CONNECTION_REPLACED`, 셸은 `DaemonSupervisor.exitConnectionReplaced`.

서버가 스트림 요청 자체를 `409` 로 거절하는 경우도 같게 취급한다. `401` 은 토큰이 늦게 저장되는 경우가 있어 기존대로 백오프 재연결이다.

### 11.3 실행 취소 (`execution.command.cancel_requested`)

- 서버 payload: `{ eventName, executionId, requestId }` (`packages/shared` `ExecutionCancelRequestedSchema`). 데몬은 선택 필드 `reason` 도 받는다.
- **실행 중**이면 자식 claude 에 `SIGTERM` → 유예(`BATON_CANCEL_GRACE_MS`, 기본 5초) 후 `SIGKILL`. 셸 종료 경로(§3.4 `daemon.shutdown`, stdin EOF)의 `SIGINT` 와 구분한다.
- **큐 대기 중**이면 시작하지 않는다. **명령보다 취소가 먼저** 와도 기록해 두고 그 `executionId` 는 실행하지 않는다.
- 보고: `POST /v1/desktop/executions/:id/result` 에 `status:"CANCELLED"`(+`outcome`, `failureReason`, 부분 `changedFiles`). 서버는 취소 시점에 이미 Execution 을 CANCELLED 로 바꾸므로 이 보고는 4xx 가 날 수 있다 — **실패해도 로그만 남기고 넘어간다**(artifact 업로드도 하지 않는다).
- 셸 표시: `execution.progress{phase:"cancelled"}` 를 두 번 보낸다(취소 요청을 받은 시점, 실제로 끝난 시점). `cancelled` 는 §3.3 의 phase 목록에 이미 있다.

### 11.4 heartbeat 와 디바이스 정보 (서버 API, 데몬 구현 기준)

데몬은 SSE 연결과 별개로 **60초마다**(`BATON_HEARTBEAT_INTERVAL_MS` 로 조정) `POST /v1/desktop/heartbeat` 를 보낸다. 실패(네트워크·5xx)는 **로그만 남기고 계속**하고, 404 면 미구현 서버로 보고 조용히 넘어간다.

```json
{ "platform":"macos", "osVersion":"Darwin 25.5.0", "appVersion":"0.1.0", "hostname":"…",
  "deviceId":"dev_…", "agentId":"agt_…", "state":"connected", "activeExecutionIds":[], "at":"2026-09-09T…Z" }
```

- 앞 4개가 `packages/shared` `DeviceMetadataSchema` 로 서버가 검증하는 필드다. 뒤 5개는 02 §7.4 의 "현재 실행 중 execution_id 목록" 을 위한 확장이며 서버 스키마가 버려도 무방하다.
- **pairing 에도 같은 4개 필드를 함께 보낸다**(`POST /v1/devices/pair` = `{ code, deviceName, platform, osVersion, appVersion, hostname }`, `DevicePairV2RequestSchema`). 웹 "내 디바이스" 의 플랫폼 표시(§9.4 이슈 1)가 이 값을 쓴다.
- `platform` 은 셸이 준 `BATON_SHELL`(`macos`/`windows`/`linux`)을 우선 쓰고, 없으면 Node `process.platform` 을 같은 어휘로 옮긴다. `appVersion` 은 `BATON_SHELL_VERSION`(셸 버전)이 있으면 그것, 없으면 데몬 버전이다.
