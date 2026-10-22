# @baton/desktop-agent — Desktop 데몬 (Node 22, TypeScript)

Baton Desktop 의 로직 계층. macOS 셸(`apps/desktop-macos`)의 자식 프로세스로 돌거나, 셸 없이 콘솔 모드로 돈다.

- pairing code → device token (`POST /v1/devices/pair`)
- SSE 구독 `GET /v1/desktop/events/stream` (`Last-Event-ID` 재연결, 멱등, 지수 백오프)
- `execution.command.requested` 수신 → 프로젝트당 1건 큐(F3) → Claude Code Adapter 실행
- 기획서 §18 추가 작업 요청: payload 에 `followUpInstruction` + `resumeSessionId` 가 오면 `claude --resume <세션id>` 로 이어 실행
- 진행 상태를 셸(IPC `execution.progress`)과 서버(`POST /v1/desktop/executions/{id}/status`)에 보고
- 결과 3계층(stream structuredPatch / git diff / result.md) 수집 → artifact 업로드(`POST /v1/uploads` → PUT → complete) → `POST /v1/desktop/executions/{id}/result`
- 셸↔데몬 IPC 는 `docs/design/04-shell-daemon-ipc.md` 계약을 따른다 (봉투·17 메시지·바이트 파서)

## 명령

```bash
baton login --code BATON-PAIR-123 --server http://127.0.0.1:4180 --project /path/to/project   # 콘솔 모드 pairing (파일 저장)
baton start [--server <url>] [--project <path>]      # 셸 없이 실행 (알림·진행은 stderr 로 표시)
baton daemon --ipc stdio                             # 셸의 자식으로 실행 (stdout=JSON Lines)
baton status                                         # ~/.baton/config.json, 토큰 유무
baton hook <canary|pretool|posttool> --policy <policy.json>   # Claude Code hook 진입점 (내부용)
```

환경변수: `BATON_HOME`(기본 `~/.baton`), `BATON_CLAUDE_MODEL`(기본 sonnet), `BATON_MAX_TURNS`(기본 60), `BATON_LOG_LEVEL`, `BATON_SSE_IDLE_RECONNECT_MS`(기본 20000, 서버가 live push 를 구현하기 전까지 주기 재연결), `BATON_STATUS_INTERVAL_MS`.

## 구조

```text
src/cli.ts                     인자 파서(의존성 없음), login/start/daemon/status/hook
src/ipc/                       envelope(zod)·line-parser(바이트)·channel(요청/응답)·messages(스키마·설정 필드)
src/services/shell-services.ts 셸 대행 인터페이스: IpcShellServices(셸이 Keychain/UserDefaults) / LocalShellServices(파일 0600 + 콘솔)
src/settings/store.ts          ~/.baton/config.json, ~/.baton/device-token
src/transport/                 api-client(fetch), sse-client, events(명령 payload·policy 스키마)
src/adapter/claude-code/       exec-dir, prompt(6구획+F4, 이어가기 프롬프트), policy(settings.json·hook 정책·인자), hook(canary/pretool/posttool), stream-mapper(02 §4.2), collector(3계층), runner(실행·resume 폴백)
src/queue/execution-queue.ts   프로젝트당 동시 1건
src/daemon.ts                  조립: 설정/토큰 → pairing → 등록 → SSE → 큐 → Adapter → 보고
test/fake-server.mjs           01 §5.3 계약 가짜 서버 (CLI: PORT=4180 node test/fake-server.mjs, 테스트용 /__test/*)
test/fake-claude.mjs           stream-json 을 흉내내는 가짜 claude (ok / nocanary / hang / resumefail 모드, --resume 지원)
```

## 실행 디렉터리 (`~/.baton/executions/<executionId>/`)

`prompt.md`, `system-append.md`, `claude-settings.json`, `policy.json`, `canary.ok`, `input/{docs,attachments}/`, `output/result.md`, `stream.jsonl`, `events.jsonl`, `hook-events.jsonl`, `changes.stream.patch`, `changes.git.patch`, `manifest.json`.

실행 디렉터리는 **Execution 마다 새로 만든다**. §18 추가 작업(2회차 이상)도 새 `executionId` 로 오므로 이전 회차의 `prompt.md`·`result.md`·`stream.jsonl` 이 덮이지 않는다.

## 추가 작업 요청 (기획서 §18, `--resume`)

결과 검토 화면에서 B 가 "추가 작업 요청"을 하면 서버가 이어갈 세션 id 와 이번 회차 지시만 담아 새 Execution 을 보낸다.

| 계약 필드 | 뜻 | 데몬 동작 |
|---|---|---|
| `resumeSessionId` | 이어갈 claude 세션 id (없으면 새 실행) | `--session-id <uuid>` 대신 `--resume <세션id>` 로 실행 |
| `followUpInstruction` | 이번 회차에 할 일 | 프롬프트에 **이 지시만** 싣는다. 원본 요청·첨부는 세션이 이미 갖고 있어 반복하지 않는다 |
| 시작 보고 `sessionId` | 서버가 기억할 세션 id | `POST …/status` 의 `sessionId`. 값의 출처는 stream-json `system/init` 의 `session_id` 다 |

- **결과 수집 기준점**: 계층2 는 회차 시작 시점의 워킹트리를 tree 로 스냅샷해(`collector.snapshotTree`) 실행 후 스냅샷과 비교한다. `git diff HEAD` 를 쓰면 이전 회차 변경까지 다시 잡혀 patch 가 이어붙기 때문이다. 사용자의 `.git/index` 는 건드리지 않고 사본을 `GIT_INDEX_FILE` 로 쓴다(tree 를 못 만드는 저장소는 예전 `diff HEAD` 방식으로 떨어진다).
- **resume 실패(세션 만료·삭제)**: `--resume` 이 실패하면 claude 는 `system/init` 을 내지 않는다. 판정 기준은 **init 부재 하나뿐**이다 — 실측(2026-09-11, CLO-8d 통합 검증)으로 실제 claude 는 없는 세션을 resume 하면 init 없이 `{"type":"result","subtype":"error_during_execution","errors":["No conversation found with session ID: …"]}` 를 내보내고 exit 1 한다. "result 이벤트도 없어야 한다" 를 조건에 넣으면 이 경로를 놓친다(그 버그로 실전에서 폴백이 안 걸렸다). 세션을 열었다면 무슨 오류가 나도 init 이 먼저 오므로 오탐은 없다.
  실패로 판정하면 한 번만 **새 세션으로 원본 맥락(프롬프트 7구획 "이어서 할 일" 포함)을 다시 실어** 재시도하고, 그 사실을 `warning` 진행 상태로 보고한다(`manifest.resumeFallback`).

## 보안 정책 (02 §6, F1~F4)

- `claude-settings.json` 은 실측된 키만 쓴다. 키 하나가 스키마에 어긋나면 파일 전체가 무음 무시되므로(F1) `SessionStart` canary hook 이 `canary.ok` 를 만들지 않으면 `system/init` 직후 SIGKILL 하고 `FAILED` 로 보고한다.
- `sandbox.credentials` 는 Bash 만 막으므로 `permissions.deny` 의 `Read(//경로)` 와 PreToolUse hook 경로 검사를 세트로 넣는다(F2).
- policy(`repository_edit`, `deployment_apply`, `network_outbound`, `outside_write`, `shell_execution`)를 프롬프트 5구획·시스템 프롬프트·hook 정책·settings 로 각각 변환한다(F4).

## 테스트

```bash
pnpm --filter @baton/desktop-agent typecheck build test     # test = tsx --test test/*.test.ts
BATON_SKIP_REAL_CLAUDE=1 pnpm --filter @baton/desktop-agent test   # 실제 claude 호출(haiku 1회, ≈$0.04) 제외
```

- `ipc.test.ts` 봉투 라운드트립, 바이트 파서, 채널 요청/응답·timeout
- `sse.test.ts` fake-server 로 실제 소켓 끊기 → `Last-Event-ID` 재연결, 중복 replay 무시
- `adapter.test.ts` 프롬프트/settings/인자 스냅샷, hook 판정, stream 매핑, fake-claude 로 runner(canary 통과·deny·3계층), canary 실패 경로
- `daemon.test.ts` 콘솔 모드 한 바퀴 (pairing → 등록 → SSE → 명령 → 실행 → status/result/artifact)
- `follow-up.test.ts` §18 추가 작업: `--resume` 인자, 이어가기 프롬프트, 2회차 계층2(이번 회차 변경만), resume 실패 폴백, fake-server 데몬 E2E
- `real-claude.test.ts` 실제 `claude -p --max-turns 3 --model haiku` 1회 + `--resume` 2회차 1회(세션 맥락 유지 확인)
- `test/e2e-logs/clo8b-e2e.sh` §18 흐름을 콘솔 데몬 + fake-server 로 재현 (로그: `clo8b-README.md`)

## 서버 계약 메모 (apps/server 와 맞출 것)

- `followUpInstruction`/`resumeSessionId`(명령 payload)와 `sessionId`(status 보고)는 CLO-8a(서버)와 합의한 계약이다. fake-server 의 `POST /__test/follow-up` 이 그 흐름을 흉내낸다.
- 서버의 `execution.command.requested` payload 에는 아직 `originalInstruction`/`additionalInstruction`/`attachments` 가 없다. 데몬은 없으면 "서버가 본문을 제공하지 않았다"고 프롬프트에 적고 첨부 문서를 근거로 진행한다.
- 서버 `/result` 는 body 의 `status` 를 보지 않고 항상 SUCCEEDED 로 처리한다. 데몬은 `status: 'FAILED'` + `failureReason` 을 보내므로 서버가 이를 읽도록 맞춰야 한다.
- 서버 SSE 는 접속 시 outbox 를 재생만 하고 live push 가 없다. 데몬은 `BATON_SSE_IDLE_RECONNECT_MS` 마다 재연결해 새 명령을 받아온다.
- `/v1/desktop/agents`, `/v1/desktop/projects`, `/v1/uploads` 는 서버에 아직 없다(404 면 건너뛴다). fake-server 에는 있다.
