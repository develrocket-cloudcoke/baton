# 02. Desktop Agent ↔ Baton Server 연결 및 Claude Code Adapter 설계

- 상위 문서: `docs/baton-service-plan.md` (§14~§18 실행 흐름, §24 Desktop Agent, §25 Agent Registry, §27 권한, §29 Adapter, §32 MVP 범위)
- 기준 범위: §32 MVP (지원 Agent = Claude Code 1종, 사용자 A/B 2명). 확장 지점은 §10 에 분리.
- 검증 환경: macOS (Darwin 25.5.0, arm64), Claude Code **2.1.260** (`claude --version`), 로그인 방식 claude.ai 구독(Max). 검증일 2026-09-04.
- 표기 규칙: 실제 실행으로 확인한 사실은 **[검증]**, 공식 문서로만 확인한 것은 **[문서]**, 확인하지 못한 추정은 **[확인 필요]** 로 표시한다.

---

> **구현 현황 안내 (2026-09-11 기준)**:
> 본 문서는 2026-09-04 작성된 설계 초안 및 실측 보고서입니다. 이후 실제 구현 및 검증(W2~W6, CLO-8)을 통해 아래 사항이 확정되었습니다:
> 1. **서버 ↔ 데몬 전송 계층**: 초안의 WebSocket 추천안 대신, **D1 결정에 따라 SSE 하향 이벤트 푸시(`GET /v1/desktop/events/stream`) + HTTPS REST 상향 보고(`POST /v1/desktop/...`)** 로 확정·구현되었습니다.
> 2. **Desktop 구조 (D5, 04 문서)**: Swift 메뉴바 셸(`apps/desktop-macos`)이 Node.js 데몬(`apps/desktop-agent`)을 자식 프로세스로 실행하고 stdin/stdout JSON Lines IPC(`docs/design/04-shell-daemon-ipc.md`)로 통신합니다.
> 3. **Pairing 인증 (05 문서)**: 웹 `/me/devices`에서 발급한 8자리 1회용 코드(`POST /v1/devices/pair`)로 등록하며, 전역 PAIRING_CODE는 제거되었습니다.
> 4. **추가 작업 요청 (CLO-8)**: 결과 검토 단계에서 직전 세션 ID를 승계받아 `claude --resume <sessionId>`로 같은 컨텍스트를 이어 실행합니다.
> 5. **다중 프로젝트 지원 (W6c)**: `settings.projects` JSON 목록을 통해 복수 프로젝트를 등록하고 `projectId`로 작업 디렉터리를 라우팅합니다.

---

## 0. 요약 (결론 먼저)

| 항목 | 결론 |
|---|---|
| Claude Code 헤드리스 실행 | `claude -p --output-format stream-json --verbose` 를 자식 프로세스로 띄우고 stdout 의 NDJSON 을 읽는다. 프롬프트는 **stdin** 으로 넣는다. [검증] |
| 실행 입력 | 프로젝트 밖의 실행 디렉터리(`~/.baton/executions/<execution_id>/`)에 요청·문서·첨부를 배치하고 `--add-dir` 로 읽기 권한을 준다. 프롬프트 파일 하나로 "원본 요청 / 첨부 / B의 추가 명령" 을 구획해 넘긴다. [검증] |
| 진행 상태 | stream-json 의 `assistant.tool_use`, `user.tool_result`, `system.permission_denied`, `result` 이벤트를 §16 상태 문구로 매핑한다. [검증] |
| 결과 수집 | 1차 = stream 의 `tool_use_result`(Edit 의 `structuredPatch`, Write 의 `create`), 2차 = git 이 있으면 실행 전후 `git diff`, 3차 = Agent 에게 규약된 경로에 `result.md` 를 쓰게 한다. Bash 로 생긴 변경은 git 없이는 완전히 잡을 수 없다. [검증] |
| 권한 강제 | 3계층: ① `--allowedTools/--disallowedTools` + `--permission-prompts none` ② `PreToolUse` hook (Baton 정책 엔진) ③ `sandbox` (OS 수준 네트워크·파일 격리). Read/Edit/Shell/Network 는 강제 가능, AWS·Kubernetes Read/Write 는 명령 문자열 휴리스틱 + 자격증명 차단까지만 가능하며 완전 강제는 불가. [검증/문서] |
| 서버→Desktop 명령 전달 | **SSE 하향 푸시 + HTTPS REST 상향 보고** 로 확정 (D1 결정 반영). 초안에서 검토되었던 WebSocket 대신 SSE+REST 파이프라인으로 구현 완료. |
| Desktop Agent 인증 | 웹 발급 1회용 pairing code(`POST /v1/devices/pair`)로 디바이스 토큰 발급, 셸 Keychain(또는 개발용 file) 저장 (05 문서 확정). |
| Desktop Agent 형태 | Swift 메뉴바 셸(`apps/desktop-macos`) + Node CLI 데몬(`apps/desktop-agent`) 자식 프로세스 IPC(04 계약)로 구현 완료 (D5 결정 반영). |
| 추가 작업 요청 | 결과 검토 단계에서 `claude --resume <sessionId>` 로 직전 세션을 이어받아 실행 (기획서 §18, CLO-8). |

---

## 1. 전체 구조

```text
┌──────────────┐   HTTPS (REST, 파일 업/다운)   ┌────────────────────┐
│  Baton Web   │ ─────────────────────────────▶ │    Baton Server    │
│  (A, B 화면)  │ ◀───── SSE/WS (화면 갱신) ───── │  Request/Execution │
└──────────────┘                                │  Agent Registry    │
                                                │  Artifact Store    │
                                                └─────────┬──────────┘
                                   WebSocket (명령 ↓ / 이벤트 ↑, ack)  │  HTTPS (artifact presigned URL)
                                                          ▼
                                              ┌────────────────────────┐
                                              │  Baton Desktop Agent   │  (B 의 PC, CLI 데몬)
                                              │  ├─ Connection (WS)    │
                                              │  ├─ Device Auth        │
                                              │  ├─ Execution Runner   │
                                              │  ├─ Adapter Registry   │
                                              │  │   └─ ClaudeCodeAdapter
                                              │  ├─ Policy (hooks 생성) │
                                              │  ├─ Notifier (OS 알림)  │
                                              │  └─ Local Store        │
                                              └───────────┬────────────┘
                                                          │ spawn (stdin: 프롬프트, stdout: stream-json)
                                                          ▼
                                              ┌────────────────────────┐
                                              │ claude -p ... (자식)   │ cwd = 선택한 Project 루트
                                              │   └─ hooks → baton-hook (정책 판정 CLI, Desktop Agent 가 설치)
                                              └────────────────────────┘
```

역할 경계:

- **Baton Server** 는 Claude Code 를 전혀 모른다. Execution 을 "Adapter 종류 + 입력 번들 + 권한 프로필" 로만 다룬다. Adapter 별 세부는 Desktop Agent 안에 갇힌다 (§29 의 목표).
- **Desktop Agent** 는 outbound 연결만 한다. 인바운드 포트를 열지 않는다 (§27 "다른 사용자가 내 Agent 를 직접 실행할 수 없다" 의 네트워크 수준 보장).
- **Adapter** 는 `prepare → run(stream) → collect → cancel → followUp` 인터페이스만 노출한다 (§9).

---

## 2. Claude Code 헤드리스 실행 방법 조사 (①)

### 2.1 검증된 플래그

아래는 로컬에서 `claude --help` 출력에 존재함을 확인하고, 표시된 방법으로 실제 실행해 본 항목이다.

| 플래그 | `--help` 표기 | 검증 방법·결과 | Baton 용도 |
|---|---|---|---|
| `-p, --print` | 있음 | 비대화형 실행. 프롬프트를 인자 또는 stdin 으로 받음. **[검증]** | 필수 |
| `--output-format stream-json` | 있음 (`text`/`json`/`stream-json`) | NDJSON 이벤트 스트림. `--verbose` 를 함께 줘야 `assistant`/`user` 이벤트가 나옴(문서 권장, 실측에서도 `--verbose` 포함 시 전체 이벤트 출력). **[검증]** | 진행 상태 스트리밍 |
| `--output-format json` | 있음 | 단일 result JSON. `session_id`, `num_turns`, `total_cost_usd`, `permission_denials`, `structured_output` 포함. **[검증]** | 짧은 후속 질의, 결과 요약 |
| `--verbose` | 있음 | stream-json 과 조합. **[검증]** | 필수 |
| `--permission-mode <mode>` | 있음 (`acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`) | `acceptEdits` 로 Write/Edit 무프롬프트 확인. `-p` 의 기본값은 `default`(manual) 이라 파일 쓰기가 거부됨을 확인. **[검증]** | 권한 프로필의 기준선 |
| `--allowedTools <tools...>` | 있음 | `Read,Write`, `Bash(printf *)`, `Bash(nc *)` 등 규칙 문법 동작 확인. **[검증]** | 권한 허용 목록 |
| `--disallowedTools <tools...>` | 있음 | `Bash` 를 주면 Bash 도구 자체가 제거됨, `Bash(kubectl *)` 를 주면 해당 명령만 거부되고 `system/permission_denied` 이벤트 발생. **[검증]** | 권한 차단 목록 |
| `--tools <tools...>` | 있음 | `Read,Glob,Grep` 만 지정 시 내장 도구가 그것만 남음 (MCP 도구는 별도). **[검증]** | 읽기 전용 프로필 |
| `--permission-prompts none` | 있음 (2.1.259+) | 프롬프트가 필요한 호출을 자동 거부하고 `permission_denials` 에 기록, 모델에게 재시도하지 말라고 알림. **[검증]** | 무인 실행 필수 |
| `--resume <session-id>` | 있음 | 첫 실행을 `--session-id <uuid>` 로 고정한 뒤 `--resume <uuid>` 로 이전 맥락(파일에 쓴 단어)을 기억함을 확인. **[검증]** | §18 추가 작업 요청 |
| `--session-id <uuid>` | 있음 | Baton 이 session id 를 미리 발급해 추적 가능. **[검증]** | Execution ↔ 세션 매핑 |
| `--fork-session` | 있음 | `--resume` 과 함께 쓰면 새 session id 로 분기됨을 확인. **[검증]** | 결과 재실행(원본 보존) |
| `--no-session-persistence` | 있음 | 트랜스크립트 미저장. 단 `~/.claude/projects/<cwd>/` 디렉터리는 생성됨. **[검증]** | 사용하지 않음(추가 작업을 위해 세션 보존 필요) |
| `--settings <file-or-json>` | 있음 | hooks 와 sandbox 설정을 JSON 파일로 주입해 동작 확인. **[검증]** | 정책 주입 |
| `--add-dir <dirs...>` | 있음 | cwd 밖의 첨부 디렉터리 파일을 Read 로 읽음 확인. **[검증]** | 첨부/문서 전달 |
| `--include-hook-events` | 있음 | `system/hook_started`, `system/hook_response` 이벤트 출력 확인. **[검증]** | 정책 판정 로그 |
| `--input-format stream-json` | 있음 | stdin 으로 `{"type":"user","message":{...}}` 두 건을 넣어 한 프로세스에서 2턴 진행, 각 턴마다 `result` 이벤트. **[검증]** | 대안 경로 (§9.4) |
| `--json-schema <schema>` | 있음 | `--output-format json` 과 조합 시 `structured_output` 필드에 스키마 준수 객체. **[검증]** | 결과 요약 구조화 |
| `--model <model>` | 있음 | `haiku` 별칭 동작 확인. **[검증]** | 사용자가 선택 |
| `--max-budget-usd <amount>` | 있음 | 실행하지 않음. **[문서]** | 비용 상한(선택) |
| `--append-system-prompt <prompt>` | 있음 | `--bare` 없이 실행 안 함. `--append-system-prompt-file` 은 인자 수용 확인(아래 2.2). **[문서]** | Baton 규약 주입 |
| `--bare` | 있음 | 실행 시 `Not logged in` — **구독 로그인은 무시하고 `ANTHROPIC_API_KEY` 만 읽음**. **[검증]** | MVP 에서는 사용 불가(구독 사용자). §10 참고 |
| `--setting-sources <sources>` | 있음 | 실행하지 않음. **[문서]** | 프로젝트 설정 배제 여부(§6.6) |
| `--strict-mcp-config` / `--mcp-config` | 있음 | 실행하지 않음. **[문서]** | MCP 차단(§6.6) |
| `--dangerously-skip-permissions` | 있음 | 사용 금지. 문서상 `-p` 에서는 프롬프트가 필요한 호출은 거부됨. **[문서]** | 금지 |

### 2.2 `--help` 에 없지만 존재가 확인된 플래그

`claude -p --bogus-flag-xyz` 는 `error: unknown option` 으로 즉시 실패한다 **[검증]**. 따라서 "오류 없이 수용됨" 은 플래그가 실제로 존재한다는 뜻이다.

| 플래그 | 상태 |
|---|---|
| `--max-turns <n>` | `--help` 에 없음. 그러나 `--max-turns 1` 로 3단계 작업을 시키면 `result.subtype = "error_max_turns"`, `is_error = true`, `num_turns = 2` 로 종료됨. **[검증]** 공식 CLI 레퍼런스에도 "print mode only" 로 기재. **[문서]** |
| `--permission-prompt-tool <mcp-tool>` | `--help` 본문의 `--permission-prompts` 설명에만 언급. 인자를 주면 오류 없이 수용됨 **[검증]**. 실제 MCP 도구와의 응답 규약은 미검증 **[확인 필요]**. |
| `--append-system-prompt-file <path>` | `--help` 에 없음. 인자 수용 확인 **[검증]**, 공식 문서에 기재 **[문서]**. |

### 2.3 실행 시 주의사항 (실측으로 드러난 함정)

1. **가변 인자 플래그가 프롬프트를 삼킨다.** `--allowedTools Write "프롬프트"` 처럼 `<tools...>` 형 플래그 뒤에 프롬프트를 두면 프롬프트가 도구 목록으로 해석되어 `Input must be provided either through stdin or as a prompt argument` 오류가 난다. **[검증]** → Baton 은 프롬프트를 항상 **stdin** 으로 넣는다 (10MB 상한 **[문서]**).
2. **`-p` 의 기본 permission mode 는 `default`(manual)** 이며 파일 쓰기가 거부된다. 반드시 `--permission-mode` 를 명시한다. **[검증]**
3. **`-p` 는 워크스페이스 신뢰 대화상자 없이 프로젝트의 `.claude/settings.json` hooks 와 `.mcp.json` 을 로드한다.** **[문서]** 프로젝트에 심어진 hook 이 Baton 정책보다 먼저 실행될 수 있다. §6.6 에서 다룬다.
4. **`--bare` 는 구독 로그인을 읽지 않는다.** MVP 사용자가 구독 계정이면 `--bare` 를 쓸 수 없다. **[검증]**
5. **SIGTERM 으로 종료하면 exit code 143**, 실행 중이던 Bash 는 137 로 죽고 그 턴은 미완으로 남는다. `--resume` 하면 그 턴이 이어진다. **[검증/문서]** 취소 후 재개 시 이 점을 사용자에게 알린다.
6. `--include-partial-messages` 는 `--output-format stream-json` 에서만 허용된다. `json` 과 조합하면 즉시 오류. **[검증]**
7. `thinking_tokens`, `rate_limit_event` 같은 이벤트가 섞여 나온다. 소비자가 모르는 타입은 무시해야 한다. **[검증]**
8. 세션 전사(transcript)는 `~/.claude/projects/<cwd 를 대시로 치환한 이름>/<session_id>.jsonl` 에 저장된다. PostToolUse hook 입력의 `transcript_path` 로 정확한 경로를 받을 수 있다. **[검증]**

### 2.4 Baton 이 실행하는 명령 템플릿 (MVP)

```bash
cd "<project_root>"
claude -p \
  --output-format stream-json --verbose --include-hook-events \
  --session-id "<execution.claude_session_id>" \
  --permission-mode acceptEdits \
  --permission-prompts none \
  --allowedTools <권한 프로필에서 생성> \
  --disallowedTools <권한 프로필에서 생성> \
  --settings "<execution_dir>/claude-settings.json" \
  --add-dir "<execution_dir>/input" "<execution_dir>/output" \
  --append-system-prompt-file "<execution_dir>/system-append.md" \
  --max-turns <프로필 값, 기본 200> \
  --max-budget-usd <사용자 설정, 선택> \
  < "<execution_dir>/prompt.md" \
  > "<execution_dir>/stream.jsonl"
```

Desktop Agent 는 stdout 을 파일로만 쌓지 않고 파이프로 읽어 실시간 파싱하며, 동시에 원본을 `stream.jsonl` 에 보존한다.

---

## 3. 실행 입력 구성 (②)

### 3.1 배치 위치: 프로젝트 안이 아니라 밖

선택지 두 가지를 비교했다.

| 방식 | 장점 | 단점 |
|---|---|---|
| (a) 프로젝트 안 `<project>/.baton/run/<id>/` | Agent 가 상대 경로로 바로 접근 | git 작업 트리를 오염(`git status` 에 잡힘), 실수로 커밋될 수 있음, 결과 diff 에 섞임 |
| (b) 프로젝트 밖 `~/.baton/executions/<id>/` + `--add-dir` | 프로젝트 무오염, diff 가 깨끗함, 실행 기록을 프로젝트와 독립 보관 | 절대 경로를 프롬프트에 써 줘야 함 (실측: 절대 경로를 주면 문제없이 읽음) |

**(b) 를 채택한다.** `--add-dir` 로 cwd 밖 파일을 Read 하는 것을 확인했다 **[검증]**. 실측에서 Agent 가 첨부 경로를 먼저 cwd 기준으로 잘못 추측한 뒤 정정하는 모습이 있었으므로, 프롬프트에는 **항상 절대 경로**를 적는다.

```text
~/.baton/executions/<execution_id>/
├── prompt.md                 # stdin 으로 넣는 최종 프롬프트 (3.3)
├── system-append.md          # Baton 규약 (3.4)
├── claude-settings.json      # hooks + sandbox + permissions (§6)
├── input/
│   ├── request.md            # A 의 원본 요청 (제목·본문), 서버가 생성
│   ├── instructions.md       # B 의 추가 명령 (없으면 빈 파일)
│   ├── docs/                 # 첨부 Document (Markdown, 버전 고정본)
│   │   └── login-error-analysis.v2.md
│   └── attachments/          # 첨부 Artifact (로그, 이미지, JSON …)
│       ├── server.log
│       └── screenshot.png
├── output/                   # Agent 가 결과 문서를 쓰는 곳 (§5.3)
│   └── result.md
├── stream.jsonl              # stream-json 원본
├── events.jsonl              # Baton 이벤트로 변환한 것 (§4)
└── manifest.json             # 실행 메타 (session_id, 시작/종료, exit code, git baseline)
```

### 3.2 원본 요청과 추가 명령의 분리 (§15)

- 서버는 `Request.body`(A) 와 `Execution.instructions`(B) 를 **별도 컬럼**으로 저장한다. 프롬프트 파일은 실행 시점에 서버가 렌더링한 **파생물**이며, 파생물 자체도 `execution_dir` 에 남겨 재현 가능하게 한다.
- 프롬프트 안에서도 두 구획을 명시적 헤더로 나눠, 누가 어떤 지시를 했는지 Agent 와 사람 모두 알 수 있게 한다 (Timeline §22 의 "B 추가 지시사항 작성" 항목과 대응).
- 반려 후 재전송(§12) 으로 문서 버전이 올라간 경우, `docs/` 에는 **Request 가 전송된 시점의 버전**만 넣고 파일명에 버전을 박는다.

### 3.3 `prompt.md` 구조

```markdown
# Baton Request #1024

## 1. 원본 요청 (요청자: A, 2026-09-04 10:05)
제목: 로그인 API 오류 해결 요청

현재 로그인 API에서 발생하는 오류를 분석하고 해결해주세요.

## 2. 첨부 문서 (반드시 먼저 읽을 것)
- /Users/b/.baton/executions/exec_01/input/docs/login-error-analysis.v2.md

## 3. 첨부 파일
- /Users/b/.baton/executions/exec_01/input/attachments/server.log
- /Users/b/.baton/executions/exec_01/input/attachments/screenshot.png   (이미지, 필요 시 Read)

## 4. 실행자의 추가 지시 (실행자: B, 2026-09-04 10:16)
- 운영 환경은 변경하지 말 것
- backend 디렉터리만 수정할 것
- 테스트 결과까지 확인할 것

## 5. 실행 정책 (Policy) (2026-09-04 PoC 반영: F4)
- repository_edit: allow (로컬 워크스페이스 내 파일 수정 허용)
- deployment_apply: deny (운영/인프라 클러스터 실제 배포·적용 금지, 로컬 파일 수정과 구분)
- network_outbound: deny (외부 인터넷 통신 차단)
- outside_write: deny (프로젝트 루트 외 파일 쓰기 금지)

## 6. 작업 완료 조건
- 결과 문서를 /Users/b/.baton/executions/exec_01/output/result.md 에 작성할 것 (형식은 시스템 지시 참조)
```

- 추가 명령이 원본 요청과 충돌하면 **B 의 지시가 우선**한다고 시스템 프롬프트에 명시한다. B 가 실행 주체이고 책임자이기 때문이다 (§4.2).
- (2026-09-04 PoC 반영: F4) B의 "운영 환경 변경 금지" 같은 자연어 지시를 모델이 "로컬 deployment.yaml도 고치지 마"로 오해하지 않도록, `5. 실행 정책` 구획에 **로컬 파일 수정 허용(`repository_edit: allow`)과 실제 클러스터 배포 금지(`deployment_apply: deny`)를 구조화된 policy로 분리 주입**한다.
- 첨부가 크면(수 MB 로그) 프롬프트에 본문을 넣지 않고 경로만 준다. Claude Code 의 Read 도구가 부분 읽기를 지원하므로 Agent 가 알아서 나눠 읽는다.

### 3.4 `system-append.md` (Baton 규약)

`--append-system-prompt-file` 로 넣는다. 내용은 고정 템플릿이며 Adapter 가 관리한다.

- 이 실행은 Baton 이 무인으로 실행 중이며 사람에게 질문할 수 없다 (AskUserQuestion 이 `--permission-prompts none` 으로 제거됨 **[문서]**). 불확실하면 가정을 result.md 에 적고 진행한다.
- (2026-09-04 PoC 반영: F4) 구조화된 정책에 따라 `repository_edit: allow`일 경우 필요한 로컬 설정 파일 및 코드 수정은 적극 수행하되, `deployment_apply: deny`이므로 `kubectl apply`, `helm install` 등 실제 환경 반영 명령은 절대 실행하지 않는다.
- 권한 프로필에서 차단된 도구는 재시도하지 말고 대안을 찾거나 result.md 에 "차단으로 수행 못 함" 으로 기록한다.
- 작업 종료 전에 반드시 `output/result.md` 를 아래 형식으로 쓴다: `## 요약`, `## 변경 파일`, `## 테스트`, `## 미완료·주의`, `## 다음 단계 제안`.
- 프로젝트 루트 밖은 `input/`, `output/` 외에 건드리지 않는다.
- 커밋·푸시·브랜치 생성은 하지 않는다 (결과 검토는 B 가 한다, §18).

### 3.5 첨부 파일 전달 경로

- 서버 → Desktop: 실행 명령(§7.4 `execution.start`) 에 각 첨부의 **presigned download URL + sha256 + 크기** 를 넣고, Desktop Agent 가 HTTPS 로 받아 `input/` 에 놓은 뒤 해시를 검증한다. WebSocket 으로 바이너리를 흘리지 않는다.
- 이미지는 Claude Code 의 Read 도구가 직접 읽을 수 있다(스크린샷 첨부 §6 예시에 대응). PDF 도 Read 가 지원한다. **[문서]**

---

## 4. 진행 상태 스트리밍 (③)

### 4.1 실측한 stream-json 이벤트 목록

`--output-format stream-json --verbose --include-hook-events` 로 실행했을 때 실제로 관찰된 이벤트 **[검증]**:

| `type` | `subtype` | 주요 필드 | 비고 |
|---|---|---|---|
| `system` | `init` | `cwd`, `session_id`, `tools[]`, `permissionMode`, `model`, `mcp_servers[]` | 첫 이벤트(단, hook 이벤트가 앞설 수 있음) |
| `system` | `hook_started` / `hook_response` | `hook_name`(예: `PreToolUse:Bash`), `hook_event`, `output`, `exit_code`, `outcome` | `--include-hook-events` 시 |
| `system` | `permission_denied` | `tool_name`, `tool_use_id`, `decision_reason_type`, `message` | 규칙/`--permission-prompts none` 에 의한 거부 |
| `system` | `thinking_tokens` | `estimated_tokens` | 무시 |
| `system` | `api_retry` | `attempt`, `max_retries`, `error` | 실측 없음, 문서 기재 **[문서]** |
| `rate_limit_event` | – | `rate_limit_info.status`, `unifiedWindows` | 경고 표시용 |
| `assistant` | – | `message.content[]` 에 `thinking` / `tool_use{name,input,id}` / `text` | tool_use 가 진행 상태의 핵심 |
| `user` | – | `message.content[].tool_result`, `tool_use_result`(구조화 결과), `is_error` | Edit 는 `structuredPatch`, Write 는 `type:"create"`, Read 는 `file.filePath`, Bash 는 `stdout/stderr` |
| `result` | `success` / `error_max_turns` / (기타 error_*) | `is_error`, `num_turns`, `duration_ms`, `total_cost_usd`, `permission_denials[]`, `result`(최종 텍스트), `structured_output`, `session_id`, `stop_reason` | 마지막 이벤트 |

서브에이전트 사용 시 `parent_tool_use_id` 가 채워진 `assistant`/`user` 이벤트가 나온다 **[문서]**. MVP 는 최상위(`parent_tool_use_id == null`)만 화면에 올리고 나머지는 원본 로그에만 남긴다.

### 4.2 §16 상태 표시로의 매핑

기획서 §16 의 화면 문구는 아래 규칙으로 생성한다. 단위는 **Baton ExecutionEvent** 이며 서버는 Claude Code 원본 형식을 모른다.

| 트리거 (stream-json) | ExecutionEvent.kind | 화면 문구 예 (§16) |
|---|---|---|
| `system/init` | `started` | "작업 시작" (model, session_id 를 detail 에) |
| `assistant` 의 `tool_use` name=`Read`, `input.file_path` 가 `input/docs/` 또는 `input/attachments/` 하위<br>또는 `tool_use` name=`Bash` 이고 `input.command` 가 `cat/head/less` 로 `input/` 경로를 참조할 때 (2026-09-04 PoC 반영) | `reading_input` | "analysis.md 읽는 중" |
| `tool_use` name ∈ {`Read`,`Glob`,`Grep`} 이고 경로가 프로젝트 안<br>또는 `tool_use` name=`Bash` 이고 `input.command` 가 탐색 패턴(`find`, `ls`, `tree` …) (2026-09-04 PoC 반영) | `exploring` | "프로젝트 구조 확인" (같은 kind 가 연속되면 화면에서는 1건으로 합침) |
| `tool_use` name ∈ {`Write`,`Edit`} 이고 대상이 `output/result.md` (2026-09-04 PoC 반영) | `writing_result` | "결과 문서 작성: result.md" |
| `tool_use` name ∈ {`Edit`,`Write`,`NotebookEdit`,`MultiEdit`} (프로젝트 코드 대상) | `editing` | "코드 수정: config/redis.ts" |
| `tool_use` name=`Bash` 이고 `input.command` 가 테스트 패턴(`npm test`, `pytest`, `go test`, `jest`, `vitest`, `gradle test`, `mvn test` …) | `testing` | "테스트 실행" |
| 위 `testing` 의 `tool_result` 가 `is_error=false` | `test_passed` | "테스트 성공" (stdout 에서 `N passed` 정규식 추출, 실패 시 문구 없이 숫자 생략) |
| 위 `testing` 의 `tool_result` 가 `is_error=true` | `test_failed` | "테스트 실패" |
| `tool_use` name=`Bash` (그 외) | `command` | "명령 실행: git status" (description 필드 우선) |
| `system/permission_denied` | `blocked` | "권한 정책으로 차단: kubectl apply …" |
| `assistant` 의 `text` (최상위) | `note` | Agent 의 중간 설명 (접힘 표시) |
| `rate_limit_event` 가 `status != allowed` / `system/api_retry` | `warning` | "API 제한으로 대기 중" |
| `result` subtype=`success` | `finished` | "작업 완료" |
| `result` subtype=`error_max_turns` | `finished_partial` | "턴 한도 도달, 부분 완료" |
| `result` 그 외 error / 프로세스 비정상 종료 (exit≠0) | `failed` | "작업 실패" (→ Request 상태 `FAILED`) |
| Desktop 이 SIGTERM 전송 | `cancelled` | "사용자가 중단함" |

`tool_use` 와 `tool_result` 는 `tool_use_id` 로 짝을 맞춘다. 테스트 명령 판별은 휴리스틱이므로 오분류가 있어도 기능에는 영향이 없다(문구만 달라짐).

### 4.3 이벤트 전송 형태

```json
{
  "type": "execution.event",
  "execution_id": "exec_01",
  "seq": 42,
  "ts": "2026-09-04T01:05:12.169Z",
  "kind": "editing",
  "summary": "코드 수정: config/redis.ts",
  "detail": { "tool": "Edit", "path": "config/redis.ts", "tool_use_id": "toolu_..." },
  "raw_ref": { "file": "stream.jsonl", "line": 118 }
}
```

- `seq` 는 Execution 내 단조 증가. 서버는 마지막 수신 `seq` 를 저장하고 재연결 시 그 다음부터 받는다 (§7.5).
- 원본 이벤트(`stream.jsonl`) 는 화면에 쓰지 않고 실행 종료 후 Artifact 로 업로드한다 (Agent Execution Log, §31 History). 실시간으로는 요약 이벤트만 보낸다. 초당 수 건 수준이라 WebSocket 으로 충분하다.
- 진행 이벤트가 30초 이상 없으면 Desktop 이 `execution.heartbeat` 를 보내 서버가 "RUNNING 인데 멈춤" 을 구분한다.

---

## 5. 결과 수집 (④)

세 계층을 모두 쓰고, 서로 보완한다.

### 5.1 1차: stream-json 의 도구 결과에서 직접 추출 (git 불필요)

실측 **[검증]**:

- `Edit` 결과 `tool_use_result` = `{filePath, oldString, newString, originalFile, structuredPatch:[{oldStart,oldLines,newStart,newLines,lines[]}], replaceAll}` → **unified diff hunk 를 그대로 재구성**할 수 있다.
- `Write` 결과 = `{type:"create", filePath, content, structuredPatch:[]}` → 신규 파일. (기존 파일 덮어쓰기 시 `type:"update"` 인지는 **[확인 필요]**)
- `Read` 결과 = `{file:{filePath,...}}` → "읽은 파일 목록".
- `Bash` 결과 = `{stdout, stderr, interrupted}` → 테스트 출력 원문.
- (2026-09-04 PoC 반영) 계층1 결과는 `output/result.md` 등 프로젝트 밖 산출물도 포함하므로, 순수 코드 변경 patch와 결과 문서를 분리하기 위해 **반드시 프로젝트 루트 내부 경로 필터를 적용**한다.

장점: 프로젝트가 git 이 아니어도 동작. 단점: **Bash 로 만든 변경(`sed -i`, 코드 생성기, `npm install`)은 잡히지 않는다.**

### 5.2 2차: git 기반 (프로젝트가 git 저장소일 때)

- 실행 전 `manifest.json` 에 baseline 기록: `git rev-parse HEAD`, `git status --porcelain=v1 -z` (이미 더러운 파일 목록), `git stash` 는 **하지 않는다**(사용자 작업 트리를 건드리지 않음).
- 실행 후:
  - 변경 파일 = `git status --porcelain=v1 -z` 결과에서 baseline 에 없던 항목 + baseline 에 있었지만 내용 해시가 바뀐 항목. 실행 전부터 더러웠던 파일은 "실행 전 변경 포함" 배지를 붙여 표시한다(완전 분리 불가).
  - patch = `git add -N <untracked 신규 파일>` 후 `git diff --binary HEAD -- <변경 파일 목록>` 을 `changes.patch` 로 저장. `add -N` 은 인덱스에 intent 만 남기므로 실행 후 `git reset -- <files>` 로 되돌려 사용자 인덱스를 원상 복구한다.
  - `.gitignore` 된 산출물(빌드 결과)은 제외된다. 이는 의도된 동작이다.
- Desktop Agent 가 git 을 호출할 때 Claude Code 의 권한 정책과 무관하게 Desktop 프로세스가 직접 실행한다 (Agent 의 Bash 권한이 막혀 있어도 결과 수집은 가능).

### 5.3 3차: Agent 가 쓰는 결과 문서

- 시스템 규약(§3.4)으로 `output/result.md` 작성을 강제한다. 존재하지 않으면 Desktop 이 `result.result`(최종 텍스트) 를 그대로 `result.md` 로 저장하고 `finished_partial` 로 낮춘다.
- 테스트 결과("34 passed") 는 (a) `result.md` 의 `## 테스트` 절, (b) 4.2 의 `test_passed` 이벤트 stdout 파싱, 두 소스를 합쳐 표시하며 불일치 시 (b) 를 우선한다(실측 데이터).
- `--json-schema` 로 요약을 구조화하는 방법은 `--output-format json` 에서만 검증했다 **[검증]**. `stream-json` 과의 조합에서 `result.structured_output` 이 채워지는지는 **[확인 필요]**. MVP 는 문서 파일 방식만 쓴다.

### 5.4 §17 결과 화면과의 대응

| §17 항목 | 소스 |
|---|---|
| 작업 요약 | `result.md` `## 요약` (없으면 `result.result`) |
| 변경 파일 | git 있으면 5.2, 없으면 5.1 의 Edit/Write 파일 집합 |
| 테스트 | 5.3 |
| 첨부 결과 `result.md` | `output/result.md` 업로드 |
| 첨부 결과 `changes.patch` | git 있으면 5.2 의 patch, 없으면 5.1 의 structuredPatch 를 unified diff 로 합성한 것 (Bash 변경 누락 경고 표시) |
| Agent 실행 로그 (§31 History) | `stream.jsonl` + `events.jsonl` 업로드 |
| 비용·턴 수 | `result.total_cost_usd`, `num_turns`, `duration_ms` |

### 5.5 git 의존 여부 정리

- **필수는 아니다.** 1차+3차만으로 MVP 결과 화면을 채울 수 있다.
- **정확한 patch 와 Bash 변경 추적은 git 이 있어야 한다.** MVP 는 프로젝트 등록(§26) 시 git 여부를 감지해 결과 화면에 "정확도" 배지로 알려 준다.
- git 이 없는 프로젝트의 Bash 변경까지 잡으려면 실행 전후 파일 트리 해시 스캔이 필요하다. 대형 프로젝트에서 비용이 커서 MVP 범위 밖 (§10).

---

## 6. 권한 매핑 (⑤)

### 6.1 강제 계층

| 계층 | 수단 | 강제 강도 | 검증 |
|---|---|---|---|
| L1 도구 규칙 | `--allowedTools`, `--disallowedTools`, `--tools`, `--permission-mode`, `--permission-prompts none` | Claude Code 프로세스가 도구 호출 전에 판정. 모델이 우회를 시도하면 `permission_denied` | **[검증]** |
| L2 정책 hook | `--settings` 로 주입한 `PreToolUse` hook → Desktop Agent 가 설치한 `baton-hook` 바이너리가 stdin 의 `tool_input` 을 보고 `permissionDecision: allow/deny` 반환 | L1 으로 표현 못 하는 규칙(경로 화이트리스트, 서브커맨드 구분, 프로젝트 외부 쓰기 금지). 반환 JSON 의 `deny` 가 실제로 도구를 막고 `tool_result.is_error=true` 로 모델에 전달됨 | **[검증]** |
| L3 OS 샌드박스 | `sandbox.enabled=true`, `sandbox.network.strictAllowlist=true`, `allowedDomains=[]`, `sandbox.filesystem.denyRead/denyWrite`, `sandbox.credentials` | Bash 와 그 자식 프로세스에 OS 가 강제. `-p` 헤드리스에서 동작함. 네트워크 차단 시 DNS 부터 실패(`getaddrinfo` 오류) | **[검증]** (macOS Seatbelt). Linux 는 bubblewrap+socat 설치 필요 **[문서]**, Windows 미지원 **[문서]** |

L1 만으로는 부족한 이유: `Edit` 를 막아도 `Bash(sed -i …)` 로 파일을 고칠 수 있고, `Bash(curl *)` 를 막아도 `python -c "urllib…"` 로 네트워크에 나갈 수 있다. 그래서 **Shell 이 허용된 프로필에서는 L3 가 실질적 경계**다.

### 6.2 §27 권한 항목별 매핑

| §27 항목 | 허용 시 | 차단 시 | 강제 가능성 |
|---|---|---|---|
| **Read File** | `Read`, `Glob`, `Grep` 허용 + `--add-dir input/` | (항상 허용. 읽기 없이는 작업 불가) 단 프로젝트 밖 읽기 제한: L2 hook 이 `file_path` 가 cwd/`add-dir` 밖이면 deny, L3 `sandbox.filesystem.denyRead` 로 Bash 의 `cat` 도 차단 | **가능** |
| **Edit File** | `--permission-mode acceptEdits` + `Edit`,`Write`,`NotebookEdit` 허용. B 의 "backend 디렉터리만" 같은 지시는 L2 hook 이 `file_path` 접두어로 강제 | `--disallowedTools Edit Write NotebookEdit` + `--permission-mode default`. Bash 우회는 L3 `denyWrite: ["<project>"]` (cwd 쓰기 자체 차단) 또는 Shell 도 차단 | **가능** (Shell 허용 시 L3 필요) |
| **Shell** | `Bash` 허용 + L3 sandbox 활성(`autoAllowBashIfSandboxed`) | `--disallowedTools Bash` → 도구가 컨텍스트에서 제거됨 **[검증]**. Task/Agent 서브에이전트가 Bash 를 쓰지 못하도록 `Task` 도 함께 제거 | **가능** |
| **Network** | `WebFetch`,`WebSearch` 허용 + `sandbox.network.allowedDomains` 에 허용 도메인 | `--disallowedTools WebFetch WebSearch` + `sandbox.network.strictAllowlist=true, allowedDomains=[]` → Bash 의 nc/curl 이 DNS 단계에서 실패 **[검증]**. MCP 서버는 `--strict-mcp-config` 로 전부 제거 | **가능** (단 Anthropic API 호출은 claude 프로세스 자체가 샌드박스 밖에서 하므로 영향 없음) |
| **AWS** | `Bash(aws *)` 허용 + `sandbox.network.allowedDomains: ["*.amazonaws.com"]` | ① L1 `--disallowedTools "Bash(aws *)"` 및 `permissions.deny: ["Read(~/.aws/credentials)"]` (2026-09-04 PoC 반영: F2) ② L2 hook: 명령에 `aws `, `terraform`, `cdk`, `sam`, `eksctl` 토큰 포함 시 deny ③ L3 `sandbox.credentials`: `~/.aws` 파일 deny, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`/`AWS_PROFILE` 환경변수 deny ④ 네트워크 `deniedDomains: ["*.amazonaws.com"]` | **부분 가능.** 명령 문자열 판별은 우회 가능(스크립트 안의 SDK 호출). 실질 경계는 ③④ 자격증명·네트워크 차단. (2026-09-04 PoC 반영: F2) **주의**: `sandbox.credentials` 는 Bash 만 막고 내장 `Read` 도구는 막지 못하므로 `permissions.deny: ["Read(//절대경로)"]` 와 PreToolUse hook 을 반드시 세트로 생성해야 한다. SSO 캐시(`~/.aws/sso/cache`)나 인스턴스 메타데이터(169.254.169.254) 같은 경로는 별도 deny 필요 |
| **Kubernetes Read** | L2 hook: `kubectl` 서브커맨드가 `get/describe/logs/top/explain/api-resources/config view/cluster-info` 이면 allow, `--dry-run` 이 붙은 `apply/diff` 는 allow | – | **정책 수준.** `kubectl exec`, `port-forward`, `proxy` 는 읽기로 볼 수 없어 deny 로 분류 |
| **Kubernetes Write** | `kubectl apply/delete/patch/edit/scale/rollout/create/replace/label/annotate/cordon/drain/taint`, `helm install/upgrade/uninstall/rollback`, `kustomize build \| kubectl apply` 를 hook 이 allow | 위 목록을 hook 이 deny. 파이프·`sh -c`·`xargs` 로 감싼 명령은 토큰 단위로 보수적으로 deny | **정책 수준 (완전 강제 불가).** kubeconfig 를 읽는 어떤 클라이언트(python client, k9s, Lens CLI)도 hook 이 알 수 없다. 완전 차단은 `sandbox.credentials` 로 `~/.kube/config`·`KUBECONFIG` 를 deny 하는 것뿐인데, 그러면 Read 도 막힌다. 따라서 "Read 허용 + Write 차단" 조합은 **모델의 협조를 전제로 한 정책**이며 이를 UI 에 명시한다 |

### 6.3 명시적으로 불가능한 항목

1. **Kubernetes Read 는 허용하고 Write 만 OS 수준에서 차단하는 것** — 위 표대로 불가. 자격증명 단위로만 완전 차단 가능.
2. **AWS 의 Read/Write 구분** — §27 에는 AWS 가 단일 항목이므로 MVP 는 on/off 만 제공. IAM 정책으로 읽기 전용 role 을 쓰는 것이 올바른 해법이며 Baton 밖의 문제.
3. **Anthropic API 로 나가는 트래픽 차단** — Network 차단 프로필에서도 claude 프로세스는 API 를 호출한다. "Network 차단" 의 정의를 "Agent 가 실행하는 도구·명령의 네트워크" 로 UI 에 명시한다.
4. **Windows 에서의 L3** — sandbox 미지원 **[문서]**. Windows 는 L1+L2 만 적용되며 Shell 허용 시 Network/Edit 차단이 우회될 수 있음을 등록 시 경고한다. MVP 는 macOS 우선.
5. **프로젝트에 이미 있는 `.claude/settings.json` 의 `permissions.allow`** 가 Baton 의 deny 보다 넓을 수 있다. 우선순위는 deny > ask > allow 이므로 Baton 이 deny 로 명시한 항목은 이긴다 **[문서]**. 그러나 프로젝트 hook 이 `allow` 를 반환하는 경우의 합산 규칙은 **[확인 필요]** → §6.6 에서 프로젝트 설정 자체를 배제하는 방향을 권장.

### 6.4 권한 프로필 → 실행 인자 생성 규칙

Desktop Agent 의 `PolicyCompiler` 가 서버에서 받은 프로필(§26 프로젝트별 설정 + §14 화면의 실행 시 선택)을 아래로 변환한다.

```json
// claude-settings.json (예: Read/Edit/Shell 허용, Network/AWS/K8s Write 차단, K8s Read 허용)
{
  "permissions": {
    "deny": [
      "WebFetch",
      "WebSearch",
      "Bash(aws *)",
      "Bash(terraform *)",
      "Read(/Users/b/.aws/credentials)",
      "Read(/Users/b/.ssh/*)"
    ],
    "disableBypassPermissionsMode": "disable",
    "additionalDirectories": ["/Users/b/.baton/executions/exec_01/input",
                              "/Users/b/.baton/executions/exec_01/output"]
  },
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true,
    "failIfUnavailable": true,
    "network": { "strictAllowlist": true, "allowedDomains": [], "deniedDomains": ["*.amazonaws.com"] },
    "filesystem": { "denyRead": ["~/.aws", "~/.ssh"] },
    "credentials": {
      "files": [{ "path": "~/.aws/credentials", "mode": "deny" }],
      "envVars": [{ "name": "AWS_ACCESS_KEY_ID", "mode": "deny" },
                  { "name": "AWS_SECRET_ACCESS_KEY", "mode": "deny" },
                  { "name": "AWS_SESSION_TOKEN", "mode": "deny" }]
    }
  },
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command",
                    "command": "\"/Users/b/.baton/bin/baton-hook\" canary --out \"/Users/b/.baton/executions/exec_01/canary.ok\"" }] }
    ],
    "PreToolUse": [
      { "matcher": "Bash|Edit|Write|NotebookEdit|Read",
        "hooks": [{ "type": "command",
                    "command": "\"/Users/b/.baton/bin/baton-hook\" pretool --policy \"/Users/b/.baton/executions/exec_01/policy.json\"" }] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write|NotebookEdit|Bash",
        "hooks": [{ "type": "command",
                    "command": "\"/Users/b/.baton/bin/baton-hook\" posttool --out \"/Users/b/.baton/executions/exec_01/hook-events.jsonl\"" }] }
    ]
  }
}
```

#### ⚠ 중대한 주의: settings 파일의 무음 무시 위험과 SessionStart canary 절차 (2026-09-04 PoC 반영: F1)
- **무음 무시 위험**: 실측 결과, `--settings` 파일 내에 스키마에 맞지 않는 키나 잘못된 타입(예: `disableBypassPermissionsMode: true` 불리언)이 하나라도 포함되면 Claude Code는 **어떤 경고나 오류도 출력하지 않고 settings 파일 전체(hooks, sandbox, permissions)를 조용히 무시(Silent Ignore)**한다. 이로 인해 프로젝트 밖 쓰기, curl, aws sts 등이 모두 무제한 통과하는 치명적 보안 결함이 발생할 수 있다.
- **`disableBypassPermissionsMode` 값**: boolean `true`가 아니라 문자열 `"disable"`이어야 한다. **[검증]**
- **SessionStart canary 절차**:
  1. `claude-settings.json`의 `hooks.SessionStart`에 반드시 canary hook을 주입한다.
  2. Desktop 데몬은 프로세스 spawn 후 첫 이벤트 직후 `canary.ok` 파일이 생성되었는지 검사한다.
  3. canary 파일이 생성되지 않으면 "settings 파일이 무음 무시됨(보안 정책 미적용)"으로 간주하고, 자식 프로세스를 즉시 `SIGKILL`로 강제 종료하고 Execution을 `FAILED` 처리한다 (fail-closed 보장).

- (2026-09-04 PoC 반영: F2) `sandbox.credentials` 는 Bash 경로만 막고 내장 `Read` 도구는 막지 못함이 실측 확인되었다. 따라서 `permissions.deny: ["Read(//절대경로)"]` 와 L2 PreToolUse hook 경로 검사를 **반드시 세트로 생성**한다.
- `PreToolUse` hook 이 stdin 으로 받는 JSON 에 `tool_name`, `tool_input`, `cwd`, `session_id`, `transcript_path`, `permission_mode` 가 들어오는 것을 확인했다 **[검증]**. `baton-hook` 은 이 입력과 `policy.json` 만으로 판정하며 네트워크를 쓰지 않는다(지연·오프라인 대비).
- hook 은 여러 개가 병렬로 실행되고 deny 하나면 차단된다(실측에서 사용자 전역 hook 과 Baton hook 이 동시에 실행됨) **[검증]**.

### 6.5 §27 의 핵심 원칙 "다른 사용자가 내 Agent 를 직접 실행할 수 없다"

- 실행 명령(`execution.start`)은 **B 가 웹에서 [Agent 실행] 을 누른 세션의 사용자 토큰으로 서명된 서버 이벤트**에서만 생성된다. Desktop Agent 는 메시지의 `initiated_by` 가 자기 디바이스 소유자와 같지 않으면 거부한다(서버 버그·탈취 방어).
- Desktop Agent 는 인바운드 포트를 열지 않는다.
- 디바이스 토큰은 사용자 단위이며 다른 사용자 토큰으로는 해당 디바이스에 명령을 보낼 수 없다.

### 6.6 프로젝트 자체 설정과의 격리

`-p` 는 프로젝트의 `.claude/settings.json` hooks 와 `.mcp.json` 을 신뢰 확인 없이 로드한다 **[문서]**. A 가 보낸 첨부가 아니라 **B 의 프로젝트 안**에 있는 것이므로 악의적일 가능성은 낮지만, Baton 정책과 충돌할 수 있다.

- MVP 권장: `--setting-sources user` + `--settings <baton>` 로 프로젝트·로컬 설정을 제외하고, `--strict-mcp-config` (MCP 미지정 시 전부 제거) 를 기본으로 켠다. 사용자가 §26 프로젝트 설정에서 "프로젝트 설정 사용" 을 명시적으로 켜면 해제한다.
- `--setting-sources` 와 `--settings` 의 조합 시 `--settings` 가 여전히 적용되는지는 **[확인 필요]** (문서상 `--settings` 는 "이 세션의 추가 설정" 이므로 적용될 것으로 예상).

### 6.7 무인 실행의 프롬프트 처리

- MVP: `--permission-prompts none`. 프롬프트가 필요한 호출은 거부되고 `permission_denials` 에 남는다. Baton 은 이를 `blocked` 이벤트로 보여 주고, B 는 결과 검토(§18) 에서 권한을 넓혀 "Agent 재실행" 을 할 수 있다.
- 확장(§10): `PermissionRequest` hook 을 `baton-hook` 이 받아 Desktop → 서버 → B 의 웹 화면으로 실시간 승인 요청을 띄우는 방식. hook 은 동기 실행이라 타임아웃(기본 60초 **[확인 필요]**) 안에 답이 와야 한다.

---

## 7. Desktop Agent 인증과 서버→Desktop 명령 전달 (⑥)

### 7.1 인증: Device Authorization 흐름

| 후보 | 흐름 | 평가 |
|---|---|---|
| (a) Desktop 에서 웹 로그인(브라우저 리다이렉트, localhost 콜백) | OAuth Authorization Code + PKCE, `http://127.0.0.1:<port>/callback` | 표준적이나 로컬 포트 리스너 필요, 방화벽·원격 SSH 환경에서 불편 |
| (b) **Device Authorization (RFC 8628 형태)** | Desktop 이 서버에 `device_code`+`user_code` 요청 → 사용자가 웹(이미 로그인됨)에서 `user_code` 입력·승인 → Desktop 이 폴링해 토큰 수령 | 인바운드 없음, headless 서버·SSH 에서도 동작, 사용자가 "어느 PC 인지" 이름 붙이는 UX 와 자연스러움 (§25 "민수의 MacBook") |
| (c) 웹에서 발급한 pairing token 을 CLI 에 붙여넣기 | `baton login --token <…>` | 가장 단순. 토큰이 클립보드·셸 히스토리에 남음 |

**(b) 채택.** (c) 는 (b) 의 폴백으로 `--token` 옵션만 남긴다.

토큰 설계:

- **Device Refresh Token**: 장기(예: 90일 슬라이딩), 디바이스 1개에 1개, 서버에서 `device_id` 와 묶어 즉시 폐기 가능(§25 `DISABLED`). OS keychain(macOS Keychain, Linux Secret Service, Windows Credential Manager) 에 저장. 파일 폴백 시 `0600`.
- **Access Token**: 단기(15분), WebSocket 핸드셰이크와 HTTPS 호출에 Bearer 로 사용. 만료 시 refresh.
- 디바이스 등록 시 서버가 `device_id` 와 사용자가 지정한 `display_name`("민수의 MacBook") 을 저장. Agent Registry 의 단위는 `(user, device, adapter)` 삼중이며 MVP 는 adapter = `claude-code` 고정.
- Claude Code 자체의 로그인은 Baton 과 무관하게 **B 가 자기 PC 에서 `claude` 로 미리 해 둔다.** Desktop Agent 는 `claude auth status --json` 의 `loggedIn`, `subscriptionType`, `email` 을 읽어 등록 화면에 표시하고 미로그인 시 `OFFLINE(사유: claude 미로그인)` 로 보고한다 **[검증]**. Baton 이 Anthropic 자격증명을 저장하거나 전달하지 않는다.

### 7.2 서버→Desktop 명령 전달 방식 비교

전제: Desktop 은 NAT/방화벽 뒤, outbound HTTPS 만 가능. 하향(명령) 은 드물고 작다(실행 시작·취소·추가 작업). 상향(진행 이벤트) 은 실행 중 초당 수 건, 수백~수천 건.

| 기준 | (1) WebSocket 단일 연결 | (2) SSE(하향) + HTTPS POST(상향) | (3) Long-poll(하향) + HTTPS POST(상향) |
|---|---|---|---|
| 양방향 | 예 | 하향만 스트림, 상향은 요청/응답 | 하향은 대기 요청, 상향은 요청/응답 |
| 상향 이벤트 비용 | 프레임 1개 | 이벤트마다 HTTP 요청(배치로 완화) | 동일 |
| 취소 명령 지연 | 즉시 | 즉시(SSE 열려 있음) | 최대 폴링 주기 |
| 재연결·순서 보장 | 직접 구현(seq + ack) | `Last-Event-ID` 표준, 상향은 POST 응답으로 ack | 직접 구현 |
| 프록시·LB 친화성 | 일부 기업 프록시가 끊음, LB idle timeout 관리 필요 | HTTP 그대로, 가장 무난 | 가장 무난 |
| 서버 구현 (Next.js/서버리스 계열) | 별도 상태 유지 서버 필요 | SSE 도 장수 연결이라 서버리스에는 부적합, 단 상향은 서버리스 가능 | 서버리스에서도 가능 |
| ack/idempotency | 메시지 봉투에 포함 | POST 응답 = ack | 동일 |
| 구현 복잡도 (Desktop) | 중 | 낮음 | 낮음 |

**추천: (1) WebSocket.** 이유는 ① 실행 중 상향 이벤트가 많아 연결 1개로 흘리는 편이 단순하고 ② 취소·추가 작업 같은 하향 명령이 즉시 도달해야 하며 ③ MVP 규모(사용자 2명, 디바이스 몇 대)에서는 상태 유지 서버 1개로 충분하기 때문이다. 다만 **메시지 봉투와 seq/ack 규약을 전송 계층과 분리**해 두어, 서버를 서버리스로 옮기거나 프록시 문제가 생기면 (2) 로 교체할 수 있게 한다. (3) 은 취소 지연 때문에 채택하지 않는다.

서버 스택이 아직 정해지지 않았다면(설계 1/3, 3/3 문서 참조) 이 절의 결론을 그쪽에 맞춰 (1)↔(2) 로 조정한다. **[확인 필요: 서버 스택]**

### 7.3 연결 수명

```text
Desktop                                  Server
  │── WSS /agent/ws  (Authorization: Bearer <access>) ──▶
  │◀── hello {server_time, resume_from_seq?} ────────────│
  │── register {device_id, adapters:[{type:"claude-code", version:"2.1.260", logged_in:true}], caps} ──▶
  │◀── registered {agent_ids} ───────────────────────────│
  │── heartbeat (30s) ─────────────────────────────────▶│  (2회 누락 → OFFLINE)
  │◀── execution.start {…} ──────────────────────────────│
  │── ack {msg_id} ────────────────────────────────────▶│
  │── execution.event {seq…} × N ───────────────────────▶│
  │◀── ack {seq} (묶음) ─────────────────────────────────│
  │── execution.finished {…} ───────────────────────────▶│
```

- 재연결: 지수 백오프(1s→60s, jitter). 재연결 후 `hello.resume_from_seq` 로 서버가 마지막 수신 seq 를 알려 주면 Desktop 은 로컬 `events.jsonl` 에서 그 이후를 재전송한다. 실행은 연결과 무관하게 계속된다(claude 프로세스는 Desktop 이 관리).
- Agent Registry 상태(§25): `ONLINE` = 연결+heartbeat 정상, `BUSY` = 실행 1건 이상 진행 중, `OFFLINE` = heartbeat 누락, `DISABLED` = 사용자가 웹에서 비활성(서버가 명령을 보내지 않고 refresh token 폐기).
- (2026-09-04 PoC 반영: F3) **동시 실행 정책**: Claude Code 세션 자체는 복수 실행이 가능하지만, 계층2(git diff baseline)가 다른 실행의 작업 트리 변경을 섞어서 수집하는 치명적 결과 귀속 문제가 실측되었다. 따라서 **MVP 에서는 프로젝트당 동시 실행을 엄격히 1건으로 제한**한다. 동일 프로젝트에 대한 추가 실행은 큐잉(`QUEUED`)하거나 거부한다.

### 7.4 메시지 봉투와 종류

```json
{ "id": "msg_01H…", "type": "execution.start", "ts": "…", "reply_to": null,
  "payload": { … } }
```

| type | 방향 | payload 요지 |
|---|---|---|
| `register` / `registered` | ↑ / ↓ | 디바이스·Adapter 목록, 지원 권한 계층(sandbox 가능 여부: OS) |
| `heartbeat` | ↑ | 현재 실행 중 execution_id 목록 |
| `execution.start` | ↓ | `execution_id`, `initiated_by`, `project_id`+`project_path`(디바이스 로컬 경로는 Desktop 이 매핑), `adapter:"claude-code"`, `permission_profile`, `policy`(구조화된 policy 필드, F4), `inputs:{request, instructions, docs[], attachments[]}` (첨부는 presigned URL+sha256), `limits:{max_turns, max_budget_usd}`, `claude_session_id`(서버 발급 UUID) (2026-09-04 PoC 반영) |
| `execution.cancel` | ↓ | `execution_id` → Desktop 이 SIGINT 후 10초 뒤 SIGTERM |
| `execution.follow_up` | ↓ | §18 추가 작업: `execution_id`, `instructions`, `mode:"resume"|"fork"` → `--resume <claude_session_id>` (필요 시 `--fork-session`) 로 새 Execution 생성 |
| `ack` | ↕ | `msg_id` 또는 `seq` |
| `execution.event` | ↑ | §4.3 |
| `execution.finished` | ↑ | `outcome: success|partial|failed|cancelled`, `result_summary`, `changed_files[]`, `artifacts[]`(업로드 완료된 artifact_id: result.md, changes.patch, stream.jsonl), `cost`, `num_turns`, `claude_session_id` |
| `agent.status` | ↑ | claude 로그인 여부 변경, 버전 변경 |
| `error` | ↕ | 코드·메시지 |

- 서버 → Desktop 명령은 **idempotent**: 같은 `execution_id` 의 `start` 를 두 번 받으면 두 번째는 무시하고 현재 상태를 ack 에 실어 보낸다.
- 큰 파일(첨부, 결과 artifact, 로그) 은 모두 HTTPS presigned URL 로 직접 업/다운로드. WebSocket 메시지 상한은 64KB 로 잡는다.

### 7.5 Execution 상태와 §21 Request 상태의 대응

| Desktop 측 사건 | Execution 상태 | Request 상태(§21) |
|---|---|---|
| `execution.start` 수신, 입력 다운로드·검증 중 | `PREPARING` | `READY_TO_RUN` |
| claude 프로세스 spawn, `system/init` 수신 | `RUNNING` | `RUNNING` |
| `result` 수신, 결과 수집·업로드 완료, `execution.finished` ack 됨 | `FINISHED` | `RESULT_REVIEW` |
| exit≠0 / spawn 실패 / 입력 해시 불일치 | `FAILED` | `FAILED` |
| `execution.cancel` 처리 완료 | `CANCELLED` | `READY_TO_RUN` (**확정, 2026-09-11 CLO-11**). 서버가 취소를 먼저 확정하고 Request 를 실행 준비로 되돌린다. 데몬이 뒤이어 올리는 부분 결과는 `Result.kind=PARTIAL` 로만 쌓이고 상태를 바꾸지 않으며 승인 대상이 아니다(01 §3.2) |
| §18 추가 작업 → 새 Execution (parent 링크) | 새 `RUNNING` | `RUNNING` |

---

## 8. Desktop Agent 형태: Swift 셸 + Node 데몬 2계층 구조 (⑦, D5 결정 반영)

(2026-09-04 PoC 반영: D5 결정 및 F6 알림 클릭 한계 해소)

기존 설계의 "순수 무GUI CLI 데몬"과 "무거운 Electron 앱" 사이의 절충으로, **Swift 메뉴바 셸 + Node.js CLI 데몬(자식 프로세스)** 2계층 아키텍처를 채택한다.

```text
┌────────────────────────────────────────────────────────┐
│ macOS 데스크톱 환경                                    │
│                                                        │
│  ┌─────────────────────────┐                           │
│  │ Swift 메뉴바 셸          │                           │
│  │ (apps/desktop-macos)    │                           │
│  │ ├─ 메뉴바 아이콘/팝오버 │                           │
│  │ ├─ UNUserNotification   │ ──(알림 클릭 시)──▶ 브라우저 오픈
│  │ ├─ macOS Keychain       │                           │
│  │ └─ 데몬 프로세스 감시   │                           │
│  └────────────┬────────────┘                           │
│               │ stdio JSON Lines / Unix Socket (0600)  │
│  ┌────────────▼────────────┐                           │
│  │ Node.js CLI 데몬        │                           │
│  │ (apps/desktop-agent)    │                           │
│  │ ├─ Server 연결 (SSE/REST)                           │
│  │ ├─ Claude Code Adapter  │ ── spawn ──▶ claude -p    │
│  │ └─ 3계층 결과 수집      │                           │
│  └─────────────────────────┘                           │
└────────────────────────────────────────────────────────┘
```

### 8.1 역할 분담 및 알림 클릭 콜백 (F6 해소)

| 계층 | 기술 스택 | 주요 책임 | 알림 및 UX 해결 |
|---|---|---|---|
| **Desktop 셸 (UI/OS)** | Swift (macOS 네이티브 메뉴바) | • 메뉴바 상태 아이콘 (ONLINE/BUSY/OFFLINE)<br>• 간이 팝오버 (최근 활동, 설정 링크)<br>• **macOS 네이티브 `UNUserNotificationCenter` 알림 발행 및 클릭 콜백**<br>• macOS Keychain 보안 저장소 접근<br>• 로그인 시 자동 실행(`SMAppService`)<br>• Node 데몬 프로세스 spawn 및 라이프사이클 관리 | **F6 완전 해소**: AppleScript `display notification`과 달리, 사용자가 알림 배너를 클릭했을 때 대리자 메서드(`userNotificationCenter(_:didReceive:withCompletionHandler:)`)가 호출되어 지정된 Request URL(`http://localhost:3000/requests/{id}`)을 기본 브라우저로 즉시 오픈한다. |
| **Desktop 데몬 (Core)** | Node.js (TypeScript) | • 서버 인증 (Device Pairing 토큰 교환)<br>• 서버 통신 (SSE 이벤트 수신 및 REST 상태/결과 보고)<br>• Claude Code Adapter 제어 (spawn, stdin 프롬프트, stdout NDJSON 파싱)<br>• 권한 통제 (SessionStart canary 검사, PreToolUse hook, sandbox 주입)<br>• 3계층 결과 수집 (stream patch, git diff, result.md) | OS 종속성이 배제된 순수 비즈니스 로직. 향후 Linux/Windows 확장 시 데몬 코드를 100% 재사용하고 셸만 해당 OS에 맞게 교체한다. |

### 8.2 프로세스 간 통신 (IPC)
- Swift 셸과 Node 데몬은 **stdio 상의 JSON Lines 스트림** 또는 로컬 Unix Domain Socket(권한 `0600`)으로 통신한다.
- 메시지 형식:
  - 데몬 → 셸: `{"type": "notify", "title": "...", "message": "...", "url": "..."}`, `{"type": "status", "presence": "BUSY"}`
  - 셸 → 데몬: `{"type": "terminate"}`
- 개발자 콘솔 단독 실행(`node apps/desktop-agent/dist/main.js start`) 시에는 Swift 셸이 없으므로, PoC에서 실측한 `display dialog` (15초 타임아웃, 웹 열기 버튼) fallback 방식으로 동작한다.

---

## 9. Claude Code Adapter 인터페이스와 실행 시퀀스

### 9.1 Adapter 인터페이스 (Desktop 내부, 언어 중립 의사 정의)

```text
interface AgentAdapter {
  id: "claude-code"
  detect(): { installed, version, logged_in, sandbox_capable }        // claude --version, claude auth status --json
  prepare(exec: ExecutionSpec): PreparedRun                           // execution_dir 생성, prompt/system/settings/policy 렌더링, git baseline
  run(prep: PreparedRun, sink: (ExecutionEvent) => void): RunHandle   // spawn, stdout NDJSON 파싱, 이벤트 변환
  cancel(handle: RunHandle): void                                     // SIGINT → 10s → SIGTERM
  collect(prep, handle): ExecutionResult                              // §5 (1차/2차/3차) 결과 합성, artifact 파일 목록
  followUp(prev: PreparedRun, instructions, mode): PreparedRun        // --resume [--fork-session]
}
```

서버는 `adapter.id` 와 `ExecutionSpec`, `ExecutionEvent`, `ExecutionResult` 만 안다. 이 세 스키마가 §29 의 Adapter 경계다.

### 9.2 실행 시퀀스 (§14 → §17)

1. B 가 웹에서 Agent·Project 선택, 추가 명령 입력, [Agent 실행] → 서버가 Execution 생성(`READY_TO_RUN`), `claude_session_id` 발급, 첨부 presigned URL 생성, `execution.start` 전송.
2. Desktop: `initiated_by` 검증 → `execution_dir` 생성 → 첨부 다운로드·해시 검증 → `prompt.md`, `system-append.md`, `claude-settings.json`, `policy.json` 렌더링 → git baseline 기록 → `PREPARING` 이벤트.
3. spawn `claude -p …`(§2.4). stdin 에 `prompt.md` 를 쓰고 닫는다. stdout 을 줄 단위로 파싱해 §4.2 매핑 → `execution.event` 전송 + `events.jsonl` 기록. `system/init` 수신 시 `RUNNING`.
4. `result` 수신 또는 프로세스 종료 → `collect`: 변경 파일·patch·`result.md`·로그를 만들고 presigned URL 로 업로드 → `execution.finished`.
5. 서버가 Request 를 `RESULT_REVIEW` 로 바꾸고 B 에게 알림(§18).
6. B 가 "추가 작업 요청" → `execution.follow_up` → Desktop 이 같은 `execution_dir` 를 재사용해 `prompt-followup-<n>.md` 를 만들고 `claude -p --resume <claude_session_id> …` 로 새 Execution 실행. git baseline 은 **최초 실행 전** 것을 유지해 누적 diff 를 만든다.
7. B 가 결과 승인 → A 에게 전달(§19). Desktop 은 관여하지 않는다.

### 9.3 취소

- `execution.command.cancel_requested` → SIGTERM(exit 143 **[검증]**) → 5초(`BATON_CANCEL_GRACE_MS`) 내 종료 없으면 SIGKILL. 자식 Bash 는 Claude Code 가 함께 종료한다 **[문서/검증]**. 셸 종료(stdin EOF)는 SIGINT 로 구분한다(04 §3.4).
- 취소 후에도 `collect` 를 실행해 **부분 결과를 올린다(2026-09-11 CLO-11 구현)**: 계층1·2 중 내용이 있는 patch 를 `PATCH` 로, `result.md` 가 있으면 `RESULT_ATTACHMENT` 로 `/v1/uploads` 에 올린 뒤 `POST /v1/desktop/executions/{id}/result` 에 `{status:'CANCELLED', summary, changedFiles, artifactIds}` 로 보고한다. `summary` 는 `result.md` 의 `## 요약` 절, 없으면 변경 파일 수로 만든다.
- 수집된 변경·patch·`result.md` 가 하나도 없으면 보고하지 않는다(웹이 "취소됨 (수집된 변경 없음)" 으로 보여 준다). 업로드·보고 실패는 로그만 남기고 취소 처리 자체는 성공으로 끝낸다 — 서버는 이미 `CANCELLED` 를 확정했으므로 되돌릴 것이 없다.
- 서버가 시킨 취소가 아니라 데몬이 스스로 멈춘 경우(셸 종료·stdin EOF)는 서버가 아직 `RUNNING` 으로 알고 있으므로 `FAILED` 로 보고한다.

### 9.4 대안: 한 프로세스에서 다중 턴 (`--input-format stream-json`)

한 프로세스를 띄워 두고 stdin 으로 사용자 메시지를 계속 넣는 방식이 동작함을 확인했다 **[검증]**. §18 추가 작업을 프로세스 재시작 없이 처리할 수 있으나, ① 프로세스가 B 의 검토 시간 내내 살아 있어야 하고 ② 취소·크래시 복구가 복잡해진다. MVP 는 `--resume` 방식을 쓰고 이 방식은 §10 에 남긴다.

---

## 10. 확장 지점 (MVP 이후)

1. **다른 Adapter (Codex, Gemini CLI, OpenCode)** — §9.1 인터페이스 구현체 추가. 각 CLI 의 헤드리스 옵션·이벤트 형식은 별도 조사 필요.
2. **실시간 권한 승인** — `PermissionRequest` hook → Desktop → 서버 → B 웹 화면. `--permission-prompts host` 와 `--permission-prompt-tool`(MCP) 도 같은 목적의 대안. 응답 규약 **[확인 필요]**.
3. **자동 승인(§28)** — 서버의 신뢰 규칙이 `execution.start` 를 사람 개입 없이 발행. Desktop 쪽 변경 없음. 단 §6.5 의 `initiated_by` 검증 규칙을 "시스템 자동 승인" 주체로 확장해야 함.
4. **Agent SDK(TypeScript/Python) 전환** — CLI spawn 대신 SDK 의 `canUseTool` 콜백으로 hook 없이 정책을 강제할 수 있음 **[문서]**. Desktop 이 Node/Python 런타임을 품게 되는 대가가 있어 MVP 는 CLI.
5. **`--bare` 모드** — API key 사용자(Enterprise/Console) 에게는 `--bare` 로 사용자 환경(hooks, CLAUDE.md, MCP) 을 완전히 배제한 결정적 실행 제공. 구독 사용자는 불가 **[검증]**.
6. **트레이 앱 셸** — §8. D5 결정에 따라 macOS는 Swift 메뉴바 셸로 이미 포함됨. Windows/Linux 확장 시 해당 OS용 셸 추가 (2026-09-04 PoC 반영).
7. **Windows 지원** — sandbox 미지원이므로 WSL2 실행 또는 컨테이너 실행(§6.3) 을 선택지로.
8. **git 없는 프로젝트의 완전한 변경 추적** — 실행 전후 트리 해시 스냅샷(§5.5).
9. **프로젝트별 작업 트리 격리(git worktree)** — (2026-09-04 PoC 반영: F3) MVP는 프로젝트당 동시 1건 실행으로 제한하여 해결. 향후 같은 프로젝트에서 동시 다중 실행을 지원하려면 실행마다 `git worktree`로 독립된 작업 트리를 분기 생성해 git diff 귀속 오염을 원천 격리하는 아키텍처 도입.
10. **한 프로세스 다중 턴 실행** — §9.4.
11. **비용·한도 정책** — `--max-budget-usd`, `rate_limit_event` 를 팀 정책과 연결.

---

## 11. 확인 필요 항목 종합

| # | 항목 | 어디에 영향 | 확인 방법 / 검증 결과 (2026-09-04 PoC 반영) |
|---|---|---|---|
| 1 | `--permission-prompt-tool` 의 MCP 응답 규약 | §6.7, §10-2 | 작은 MCP 서버를 만들어 `-p` 로 실행 |
| 2 | `--json-schema` 와 `stream-json` 조합에서 `structured_output` 제공 여부 | §5.3 | 실행 테스트 |
| 3 | `Write` 로 기존 파일 덮어쓸 때 `tool_use_result.type` 값 | §5.1 | 실행 테스트 |
| 4 | `sandbox.credentials` 필드명·동작(macOS 에서 파일 deny) | §6.4 | **[해소: F2]** 실측 결과 Bash 경로는 차단되나 내장 `Read` 도구는 못 막음을 확인. `permissions.deny: ["Read(//절대경로)"]` 와 PreToolUse hook 을 세트로 생성해 완전 차단함 |
| 5 | `--setting-sources user` + `--settings` 조합 시 `--settings` 적용 여부, 프로젝트 hook 이 `allow` 를 반환할 때의 합산 규칙 | §6.6 | 실행 테스트 |
| 6 | hook 실행 타임아웃 기본값(실시간 승인 확장 시) | §6.7 | 문서 hooks 레퍼런스 확인 |
| 7 | AWS SSO 캐시·IMDS 경로 등 추가로 막아야 할 자격증명 경로 | §6.2 | 보안 검토 |
| 8 | 취소된 Execution 의 Request 상태(`RESULT_REVIEW` vs `FAILED`) | §7.5 | 기획 결정 |
| 9 | 서버 스택(장수 연결 가능 여부) → WebSocket vs SSE+POST 최종 확정 | §7.2 | **[해소: D1]** SSE 하향 푸시 + HTTPS REST 상향 보고로 최종 확정 반영됨 |
| 10 | CLI 데몬에서의 알림 클릭 → 웹 열기 (macOS `osascript` 의 한계) | §8 | **[해소: F6, D5]** Swift 메뉴바 셸의 `UNUserNotificationCenter` 네이티브 알림 클릭 대리자 콜백으로 해결. CLI 단독 폴백은 `display dialog` (15초 타임아웃) 사용 |
| 11 | 디바이스당 동시 실행 시 Claude Code 세션 저장소 경합 | §10-9 | **[해소: F3]** 세션 자체는 충돌 없으나 git baseline 오염 실측. MVP 는 **프로젝트당 동시 1건 제한**으로 확정 해결 |

---

## 부록 A. 검증 로그 요약

모든 테스트는 scratchpad 의 빈 디렉터리에서 `--model haiku` 로 실행했다. 프로젝트 파일은 건드리지 않았다.

| # | 실행 | 관찰 |
|---|---|---|
| A1 | `claude --version` / `claude --help` | 2.1.260. §2.1 표의 "있음" 항목 확인 |
| A2 | `-p --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools Read,Write` + Read/Write 작업 | 21줄 NDJSON. `system/init` → `assistant(tool_use Read)` → `user(tool_result)` → … → `result{subtype:success,num_turns,total_cost_usd}` |
| A3 | `-p --bogus-flag-xyz` | `error: unknown option` (미지 플래그는 즉시 실패) |
| A4 | `-p --output-format json --max-turns 1` + 3단계 작업 | `subtype:error_max_turns, is_error:true, num_turns:2`, 첫 파일만 생성 |
| A5 | `--settings hooks.json --include-hook-events`, PreToolUse(Bash) 가 deny JSON 반환, PostToolUse(Write) 가 stdin 을 파일에 기록 | Bash 차단되어 `tool_result.is_error:true, "Baton policy: Shell blocked"`, 모델이 Write 로 우회. PostToolUse stdin 에 `session_id, transcript_path, cwd, permission_mode, tool_name, tool_input` 확인. `hook_started/hook_response` 이벤트 출력 |
| A6 | `--allowedTools Write "프롬프트"` (프롬프트를 마지막 인자로) | `Input must be provided either through stdin or as a prompt argument` — 가변 인자가 프롬프트를 삼킴 |
| A7 | stdin 프롬프트 + `--session-id <uuid>` → `--resume <uuid>` → `--resume --fork-session` | 재개 시 이전 턴에서 쓴 단어 `pineapple` 회수. fork 시 새 session_id |
| A8 | 기본 mode + `--permission-prompts none` + Write 시도 | 거부, `permission_denials:[{tool_name:Write,…}]`, 모델이 "승인될 수 없다" 고 응답 |
| A9 | `--disallowedTools Bash` | 모델이 "Bash 도구가 없다" 고 응답, `permission_denials` 비어 있음(도구 자체 제거) |
| A10 | `--tools Read,Glob,Grep` | 내장 도구가 3개만 남음(MCP 도구는 남음) |
| A11 | `--output-format json --json-schema {...}` | `structured_output` 에 스키마 준수 객체 |
| A12 | `--input-format stream-json` 로 user 메시지 2건 | 한 프로세스에서 2턴, 턴마다 `result`, 두 번째 턴이 첫 턴 내용 기억 |
| A13 | `--add-dir ../attach` + stdin 프롬프트 + Edit | cwd 밖 첨부 Read 성공. Edit 결과에 `structuredPatch` |
| A14 | `--allowedTools "Bash(printf *)" "Bash(nc *)" --disallowedTools "Bash(kubectl *)"` | nc 는 실행되어 외부 443 연결 성공(권한 규칙만으로는 네트워크 비차단). kubectl 은 `system/permission_denied{decision_reason_type:subcommandResults}` |
| A15 | `--settings` 로 `sandbox.enabled, strictAllowlist, allowedDomains:[], failIfUnavailable` | `nc example.com 443` → `getaddrinfo` 실패(네트워크 차단). cwd 쓰기 성공. `ls ~/.ssh` 성공(기본 읽기 허용 → denyRead 필요) |
| A16 | `--include-partial-messages` + `--output-format json` | 오류: stream-json 전용 |
| A17 | 실행 중 SIGTERM | exit 143, 진행 중 Bash 는 137 |
| A18 | `--bare --append-system-prompt-file sp.txt` | `Not logged in`(구독 무시). 플래그는 수용됨 |
| A19 | `claude auth status` | JSON: `loggedIn, authMethod:"claude.ai", subscriptionType, email, orgId` |
| A20 | `claude -p --permission-prompt-tool foo "say hi"` | 오류 없이 수용(존재 확인만) |

## 부록 B. 이벤트 샘플 (A13 발췌, 경로 축약)

```json
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_01","name":"Edit","input":{"file_path":".../proj/data.txt","old_string":"beta","new_string":"delta","replace_all":false}}]},"session_id":"…"}
{"type":"user","message":{"content":[{"tool_use_id":"toolu_01","type":"tool_result","content":"The file .../proj/data.txt has been updated. …"}]},"tool_use_result":{"filePath":".../proj/data.txt","oldString":"beta","newString":"delta","originalFile":"alpha\nbeta\ngamma\n","structuredPatch":[{"oldStart":1,"oldLines":3,"newStart":1,"newLines":3,"lines":[" alpha","-beta","+delta"," gamma"]}],"userModified":false,"replaceAll":false},"session_id":"…"}
{"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"toolu_02","decision_reason_type":"subcommandResults","message":"Permission to use Bash with command kubectl version --client 2>&1 has been denied.","session_id":"…"}
{"type":"result","subtype":"success","is_error":false,"num_turns":5,"duration_ms":10899,"total_cost_usd":0.068,"permission_denials":[],"result":"…","session_id":"…","stop_reason":"end_turn"}
```
