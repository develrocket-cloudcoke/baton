# 07. 실행 중 사람 승인 (Interactive Approval)

실행 중에 에이전트가 정책으로 막힌 도구를 쓰려 할 때, **그 자리에서 사람에게 물어
허용·거부를 받는다.** 지금은 정책이 미리 정한 대로 즉시 거부하고 진행 화면에만
"권한 정책으로 차단" 이 남는다 — 보이지만 답할 수 없다.

관련 문서: [01 도메인·API](01-domain-and-api.md), [02 데스크톱 에이전트·어댑터](02-desktop-agent-and-adapter.md)

## 1. 왜 hook 이 기다리는 방식인가

`claude` 는 `--permission-prompts none` 으로 돌린다. 프롬프트에 답할 사람이 없다는
선언이고, 대신 PreToolUse hook 이 `allow`/`deny` 를 낸다(`hook.ts` `decidePreToolUse`).

hook 은 **별도 프로세스**이고, hook 이 늦게 답하면 **그 도구 호출이 그대로 멈춰 있다.**
이 성질을 쓴다. Claude 의 대화형 프롬프트 UI 에 의존하지 않고, 판정이 우리 경로
(hook → 서버 → 웹 → 사람) 안에서 끝난다.

```
claude ──PreToolUse──> hook ──POST approval──> server ──SSE──> 웹(실행자)
                        │                         ▲              │
                        │  (폴링, 마감시간까지)     └── 결정 ──────┘
                        └──> allow / deny ──> claude 가 도구 실행 또는 차단
```

## 2. 할 수 있는 것과 못 하는 것

|                  | 실행 중            | 회차 사이            |
| ---------------- | ------------------ | -------------------- |
| 허용·거부 선택   | **가능** (이 문서) | 정책으로 미리 지정   |
| 자유 텍스트 답변 | **불가**           | 추가 작업(follow-up) |

`claude -p` 는 시작한 대화에 새 사용자 입력을 받지 않는다. 그래서 "포트를 뭐로
할까요" 같은 텍스트 질의응답은 이 경로로 못 한다 — 회차를 끝내고 추가 작업으로 준다.

## 3. 정책

`Policy` 에 승인 모드를 추가한다. **기본값은 현재 동작(`deny`)이며, 바꾸지 않으면
동작이 달라지지 않는다.**

| 값            | 뜻                                                               |
| ------------- | ---------------------------------------------------------------- |
| `deny` (기본) | 지금과 같다. 정책에 걸리면 즉시 거부하고 진행한다                |
| `ask`         | 정책에 걸리면 실행자에게 묻고 답을 기다린다. 무응답이면 거부한다 |

`ask` 는 **차단 판정을 질문으로 바꾸는 것뿐**이다. 애초에 `allow` 인 것은 묻지 않고,
`ask` 로 바꿔도 허용 범위가 넓어지지 않는다 — 사람이 그때그때 열어 주는 것이다.

## 4. 엔티티

```
ExecutionApproval
  id              uuid
  executionId     → Execution
  toolName        string        예: Bash, Write
  detail          text          도구 입력 요약 (명령 원문 등) — 신뢰할 수 없는 값
  reason          string        정책이 막은 사유 (hook 이 만든 문구)
  status          PENDING | ALLOWED | DENIED | EXPIRED
  decidedByUserId → User?       결정한 사람 (실행자)
  decidedAt       datetime?
  expiresAt       datetime      이 시각까지 답이 없으면 EXPIRED
  createdAt       datetime
```

- 결정은 **한 번만** 가능하다. 이미 PENDING 이 아니면 409.
- `Execution_approval_immutable` 과 같은 결에 맞춘다: 결정된 행의 status·decidedBy·
  decidedAt 은 DB 트리거로 변경을 막는다(`audit-protection.ts` 에 추가).

## 5. API

### 데몬(device token)

```
POST /v1/desktop/executions/:executionId/approvals
  body { toolName, detail, reason }
  201  { approvalId, expiresAt }
```

- 해당 Execution 이 이 디바이스의 것이고 status 가 RUNNING 이어야 한다. 아니면 403.
- 생성과 동시에 실행자에게 SSE 로 알린다.

```
GET /v1/desktop/approvals/:id
  200  { status, expiresAt }
```

- 마감이 지났고 아직 PENDING 이면 **읽는 시점에 EXPIRED 로 확정**하고 그대로 답한다
  (별도 스케줄러를 두지 않는다).

### 웹(사용자 JWT)

```
POST /v1/approvals/:id/decision
  body { decision: 'ALLOWED' | 'DENIED' }
  200  { status }
```

- **실행자(확정 수신자)만** 결정할 수 있다. 요청자는 403 — 남의 컴퓨터에서 도는
  도구를 요청자가 열어 주면 안 된다.
- 마감이 지났으면 409 (EXPIRED).

## 6. hook 동작

`decidePreToolUse` 가 `deny` 를 냈고 정책이 `ask` 일 때만:

1. `POST …/approvals` → `approvalId`
2. 0.7초 간격으로 `GET …/approvals/:id` 폴링
3. `ALLOWED` → `{}` (통과) / `DENIED`·`EXPIRED` → 기존과 같은 `deny` 출력
4. **서버에 닿지 못하면 즉시 `deny`.** 네트워크 실패가 허용으로 바뀌면 안 된다.

### 마감 시간과 hook 타임아웃 (구현 시 실측 필요)

Claude Code 는 hook 을 무한정 기다리지 않는다. hook 설정의 `timeout`(초)을 명시하고,
**우리 마감은 그보다 짧게** 둔다. 설정값이 실제로 먹는지, 초과 시 Claude 가 어떻게
처리하는지(거부로 보는지, 통과로 보는지)를 **실측해서 이 문서에 적는다.** 초과가
통과로 처리된다면 `ask` 를 기본값으로 쓸 수 없다.

권장 초기값: hook `timeout` 180초, 우리 마감 150초.

### 2026-09-18 실측: 현재 설계로 구현 보류

실제 Claude Code **2.1.263**으로 임시 파일을 `Read` 한 번만 호출했다.
`--permission-prompts none --permission-mode default --allowedTools Read`에
해당하는 조건에서 별도 PreToolUse 프로세스가 지연 후 명시적 `deny`를 출력하게 했다.
사용자·프로젝트 설정은 제외했고, 가짜 CLI는 사용하지 않았다.

| 설정           | hook 동작          | 관측 결과                                                                            |
| -------------- | ------------------ | ------------------------------------------------------------------------------------ |
| `timeout: 2`   | 즉시 `deny`        | 파일 읽기 거부, `permission_denials` 기록                                            |
| `timeout: 2`   | 5초 뒤 `deny` 예정 | 약 2.04초 후 hook `cancelled` / exit 1, **파일 읽기 실행**, `permission_denials: []` |
| timeout 미지정 | 70초 뒤 `deny`     | 약 70.05초 기다린 뒤 파일 읽기 거부                                                  |

미지정 실험은 70초까지 기다린다는 사실만 확인했다. 기본 timeout의 정확한 값과
그 한도를 넘겼을 때의 동작은 아직 측정하지 않았으며, 60초라고 가정하면 안 된다.
반면 명시적 timeout 초과가 거부가 아니라 기본 권한 판정으로 이어지는 것은
실제 파일 내용이 tool result에 반환된 것으로 확인했다.

따라서 **180초/150초 간격만으로 fail-closed를 보장할 수 없다.** hook이 멈추거나
시간 안에 거부를 출력하지 못하면 기존에 허용된 도구가 실행될 수 있다.
`approval_mode=deny` 기본값은 유지하되, `ask` 구현은 설계 보완 전까지 보류한다.
정상적인 네트워크 오류를 catch하는 것과 hook 프로세스 자체의 timeout/종료는
서로 다른 실패 경로다.

보완 후보는 `ask` 실행의 기본 도구 권한을 거부로 두고 유효한 승인에만 명시적
`allow`를 반환하는 구조다. 다만 Claude의 도구별 기본 허용, 명시적 deny 규칙,
sandbox 자동 허용, hook allow 우선순위를 실제 CLI로 다시 검증해야 하므로
아직 확정된 해결책이 아니다. 단순 watchdog만으로 timeout과 실행 사이 경합이
없다고 가정하지 않는다. 이 경계를 확정한 후 서버·데몬·웹 구현을 재개한다.

### 2026-09-18 추가 실측: 안전한 공통 기준선 없음

같은 Claude Code 2.1.263에서 기준선별로 `allow`, 5초 지연(명시한
`timeout: 2`로 취소), `deny`를 비교했다. `--permission-prompts none`을
고정하고 사용자·프로젝트 설정과 MCP를 제외했다. 허용 목록에는 도구를 넣지
않았고, disallowed 기준선만 해당 도구를 금지 목록에 넣었다.

**실행 판정은 assistant의 주장이나 permission_denials가 아니라 tool result에
임시 파일의 고유 내용이 반환됐는지로 했다.** 호출 입력도 확인해 Bash가 지정한
명령을 실제 요청했는지 검증했다. 아래 각 셀은 `allow / 취소 / deny` 순서이며,
`실행`은 내용 반환, `차단`은 오류 tool result와 내용 미반환이다.

| 기준선 (sandbox 꺼짐)             | Read                     | Bash: cat으로 같은 파일 읽기 | Bash: Python으로 같은 파일 읽기 |
| --------------------------------- | ------------------------ | ---------------------------- | ------------------------------- |
| default, 허용·금지 목록 모두 제외 | 실행 / 실행 / 차단       | 실행 / 실행 / 차단           | 실행 / 차단 / 차단              |
| disallowedTools에 해당 도구 포함  | 미호출 / 미호출 / 미호출 | 미호출 / 미호출 / 미호출     | 미호출 / 미호출 / 미호출        |
| dontAsk, 허용·금지 목록 모두 제외 | 실행 / 실행 / 차단       | 실행 / 실행 / 차단           | 실행 / 차단 / 차단              |
| manual, 허용·금지 목록 모두 제외  | 실행 / 실행 / 차단       | 실행 / 실행 / 차단           | 실행 / 차단 / 차단              |
| plan, 허용·금지 목록 모두 제외    | 실행 / 실행 / 차단       | 실행 / 실행 / 차단           | 실행 / 실행 / 차단              |

`--help`에 표시되는 모드 중 자동 승인을 줄이는 후보인 `dontAsk`, `manual`,
`plan`을 비교했다. 편집 자동 승인이나 권한 우회를 지향하는 `acceptEdits`,
`bypassPermissions`, `auto`는 거부 기준선 후보로 채택하지 않았다.

`--disallowedTools`는 도구가 모델에 노출되지 않아 tool_use와 PreToolUse 자체가
없었다. 따라서 이 행은 hook이 실행된 뒤 deny를 이겼다는 실험이 아니다.
실제 CLI 사용 경로에서는 명시적 hook allow도 호출할 수 없어 조건 (나)를 충족하지
못한다. 다른 행은 Read와 cat의 timeout 후 실제 내용 반환으로 조건 (가)에 실패했다.

Python 명령만 보면 default/dontAsk/manual이 두 조건을 충족하지만 **명령별
기본 권한 분류에 따른 부분적인 결과**다. 같은 Bash에서 cat은 통과하므로 도구
전체의 기준선이 아니다. Baton이 막아야 하는 명령·경로를 Claude의 기본 분류가
동일하게 막는다고 가정할 수 없다.

#### sandbox 자동 허용 비교

Bash의 동일한 Python 파일 읽기 명령으로 `sandbox.enabled=true`,
`failIfUnavailable=true`를 고정하고 `autoAllowBashIfSandboxed`만 바꿨다.
표는 위와 같이 `allow / 취소 / deny` 순서다.

| 모드    | 자동 허용 false    | 자동 허용 true     |
| ------- | ------------------ | ------------------ |
| default | 실행 / 차단 / 차단 | 실행 / 실행 / 차단 |
| dontAsk | 실행 / 차단 / 차단 | 실행 / 실행 / 차단 |

즉 sandbox 자동 허용은 판정에 실제로 끼어든다. `dontAsk`만으로도 막히지 않는다.
명시적 deny는 양쪽에서 차단됐지만, hook 취소 때는 자동 허용이 켜진 쪽에서 실제
파일 내용이 반환됐다. 앞선 sandbox 비활성화 실험에서도 Read와 cat은 실행됐으므로
자동 허용을 끄는 것만으로 전체 문제를 해결할 수도 없다.

이번 추가 실측은 총 69회다: Read/cat 기준선 행렬과 sandbox 비교 36회,
Python 행렬과 sandbox 비교 21회, sandbox 필수화 및 자동 허용 비교 12회.
기준선별 단일 관측이며 CLI 버전·명령·설정 범위를 넘겨 일반화하지 않는다.
재현 스크립트와 원본 tool result는 내부 검증 기록에 보관한다.

#### 결론과 구현 범위

**현재 Claude Code 2.1.263와 이 문서의 PreToolUse 승인 경로에서는 실행 중 승인을
요구된 fail-closed 조건으로 구현할 수 없다.** 정확히는 측정한 기준선 어느 것도
Read와 Bash 입력에 공통으로 (가) 무응답 시 차단, (나) 명시적 allow 시 실행을
만족하지 않았다. Claude Code의 모든 미측정 설정 조합에 대한 불가능 증명은 아니다.

CLO-130의 서버·데몬·웹 구현은 진행하지 않는다. 기본 `approval_mode=deny`와
기존 제품 코드를 그대로 유지한다. timeout을 늘리거나 특정 명령의 성공 사례만으로
승인 경로를 열지 않는다. 새로운 권한 메커니즘이 제공되거나 별도 설계가 승인되기
전까지 이 문서 4~9절은 구현 대기 상태다.

## 7. 웹 UI

실행 진행 화면(`execution-progress-live.tsx`)에 대기 중 승인을 띄운다.

- 도구 이름, **명령 원문(고정폭, 원문 그대로)**, 정책 사유, 남은 시간
- `허용` / `거부` 버튼. 결정하면 즉시 사라지고 진행 로그에 결과가 남는다
- 요청자 화면에는 버튼을 띄우지 않는다 (있어도 서버가 403 을 준다)

### 신뢰 경계

`detail` 은 **에이전트가 만든 문자열**이고 에이전트는 남이 보낸 요청문을 읽는다.
즉 이 값은 프롬프트 인젝션의 출구가 될 수 있다.

- 마크다운·HTML 로 렌더링하지 않는다. 평문으로만 표시한다
- 길이를 제한한다(예: 2000자) — 넘으면 자르고 잘렸음을 표시한다
- "이것은 에이전트가 요청한 명령이며 내용은 신뢰할 수 없다" 는 맥락을 화면에 둔다
- 06 §5 의 자기선언 금지와 같은 원칙이다: 에이전트가 제시한 문구로 사람의 판단을
  유도할 수 있음을 전제하고 설계한다

## 8. 감사 기록

- `EXECUTION_APPROVAL_REQUESTED`, `EXECUTION_APPROVAL_DECIDED` 를 TimelineEvent 에 남긴다
- payload 에 toolName·status·decidedByUserId·사유를 담는다. detail 원문은 길이 제한 후 저장
- TimelineEvent 는 append-only 다(트리거). 승인 이력은 지워지지 않는다

## 9. 실패 모드 (설계상 정한 것)

| 상황                       | 동작                                               |
| -------------------------- | -------------------------------------------------- |
| 사람이 답하지 않음         | 마감 후 EXPIRED → 거부                             |
| 서버 연결 끊김             | hook 이 즉시 거부                                  |
| 데몬 종료·실행 취소        | PENDING 은 EXPIRED 로 정리, hook 은 이미 죽어 있다 |
| 같은 실행에서 여러 번 질문 | 각각 별도 행. 순차로 처리된다(도구 호출이 직렬)    |
| 요청자가 결정 시도         | 403                                                |

## 10. 범위 밖 (이 문서에서 다루지 않음)

- 실행 중 자유 텍스트 입력 (2절)
- "한 번 허용하면 이 실행에서 같은 명령은 계속 허용" 같은 기억 — 필요해지면 별도로
  정한다. 처음부터 넣으면 한 번의 승인이 어디까지 번지는지 사람이 예측하기 어렵다

## 11. host MCP 승인 창구 재검증 (2026-09-18)

6절의 결과는 `--permission-prompts none`에서 PreToolUse 자체가 판정을 내리는
경로에 대한 실측이다. host MCP 승인 창구에 대한 불가능 결론으로 확장하지 않는다.
공식 CLI 문서의 `--permission-prompts host`와 `--permission-prompt-tool`을 사용해
별도의 승인 창구를 검증했다. [공식 CLI 참조](https://code.claude.com/docs/en/cli-reference).

### 구성과 실행 판정

실제 Claude Code 2.1.263에 로컬 stdio MCP 승인 서버 하나를 연결했다.
PreToolUse는 즉시 `permissionDecision: "ask"`를 반환하고, CLI는
`--permission-prompts host --permission-prompt-tool mcp__approvalprobe__approve`로
실행했다. 승인 서버는 `behavior: "allow"`와 원래 입력을 담은 `updatedInput`,
또는 `behavior: "deny"`를 반환했다. 사용자·프로젝트 설정과 다른 MCP는 제외했다.

Read와 Bash(cat)를 각각 sandbox 자동 허용 on/off에서 측정했다. sandbox는 켜고
`failIfUnavailable=true`를 고정했다. 승인 도구는 모델의 일반 도구 목록에 없었고,
대상 tool_use의 ID와 MCP 승인 요청의 tool_use_id가 연결되는 것을 확인했다.
성공은 **tool_result에 임시 marker의 실제 내용이 반환됐는지**로 판단했다.
assistant 응답과 permission_denials만으로 실행 여부를 판단하지 않았다.

### MCP 응답 행렬

| 승인 도구 동작           | Read 자동 허용 off   | Read on              | Bash(cat) off        | Bash(cat) on         |
| ------------------------ | -------------------- | -------------------- | -------------------- | -------------------- |
| 즉시 allow               | 실행                 | 실행                 | 실행                 | 실행                 |
| 즉시 deny                | 차단                 | 차단                 | 차단                 | 차단                 |
| 5초 후 allow             | 실행                 | 실행                 | 실행                 | 실행                 |
| 70초 후 allow            | 실행                 | 실행                 | 실행                 | 실행                 |
| 180초 후 allow           | 실행                 | 실행                 | 실행                 | 실행                 |
| MCP isError 응답         | 오류·미실행          | 오류·미실행          | 오류·미실행          | 오류·미실행          |
| 응답 없이 프로세스 생존  | 관찰 종료까지 미실행 | 관찰 종료까지 미실행 | 관찰 종료까지 미실행 | 관찰 종료까지 미실행 |
| 서버 시작 직후 종료      | 오류·미실행          | 오류·미실행          | 오류·미실행          | 오류·미실행          |
| 승인 요청 수신 직후 종료 | 오류·미실행          | 오류·미실행          | 오류·미실행          | 오류·미실행          |

승인 서버의 요청 수신~응답 기록 간격은 각각 약 5.00초, 70.00초,
179.99초였다. 지연 중 fallback 실행 없이 승인 응답 뒤에만 marker가 반환됐다.
오류 응답은 `Error calling tool`, 실행 중 종료는 `Connection closed`, 시작 실패는
승인 MCP 도구를 찾을 수 없다는 오류로 끝났다. sandbox 자동 허용 on/off가 이
행렬의 결과를 바꾸지 않았다.

### 승인 창구에 도달하기 전의 경계

host로 바꿨다고 hook 자체의 실패가 차단되는 것은 아니다. 별도 대조군에서 hook이
5초 뒤 ask를 출력하도록 하고 timeout을 2초로 두자 네 조합 모두 hook이 취소됐고,
**MCP 승인 요청은 0회인데 Read와 cat의 실제 marker가 반환됐다.** 승인 서버는
호출됐다면 deny를 반환하도록 구성했다.

따라서 `none`만이 기존 누수의 원인이라고 결론 내릴 수 없다. host는 이미 ask가
된 요청의 응답 창구이며, hook이 ask를 만들지 못하면 기본 권한 판정으로 진행하는
문제는 남는다. 아래 승인 서버 실패 실험과 이 진입 전 실패를 구분해야 한다.

### 관찰 범위와 채택 판단

무응답 MCP는 응답 스레드가 계속 살아 있게 만들었다. 실행 중 PID 생존을 확인했고,
CLI 시작 후 240초의 외부 관찰 한도까지 marker는 반환되지 않았다. 이후 측정기가
해당 테스트 프로세스 그룹에 SIGTERM을 보내 정리했으며, 이때 `Connection closed`
오류와 종료 코드 143이 기록됐다. **240초는 Claude의 자동 timeout이 아니다.**
무한 대기 전 구간의 안전성을 유한 실험만으로 증명했다고 주장하지 않는다.
180초 뒤 승인 성공은 확인했지만, 승인 창구의 자동 대기 상한은 이 범위에서
발견하지 못했다. `MCP_TIMEOUT`, `MCP_TOOL_TIMEOUT` 환경변수는 지정하지 않았다.

총 40회(승인 행렬 36회, hook timeout 대조군 4회)를 측정했다.
**ask가 승인 창구에 도달한 이후의 MCP 경로는 요청된 (가) 실패 시 미실행,
(나) 즉시 승인 시 실행, (다) 70초 승인 시 실행을 관찰 범위에서 모두 충족했다.**
따라서 승인 응답 창구 후보로 MCP 경로를 채택할 근거가 생겼다. 이 행렬에서 MCP가
탈락하지 않았으므로, 조건부 후속 실험인 SDK canUseTool 행렬은 실행하지 않았다.
SDK가 더 안전하다고 추정하거나 미측정 상태로 대체하지 않는다.

그러나 **hook ask → host MCP 전체 구조의 fail-closed는 아직 충족하지 못했다.**
hook이 ask를 내기 전 timeout되는 반례가 그대로 남아 있어, 전체 구현을 안전하다고
선언하거나 제품 코드에 적용하지 않는다. 즉시 ask hook은 장시간 기다리는 hook보다
노출 시간을 줄이지만, 실패를 허용으로 바꾸지 않는 보장은 아니다. 이 진입 경계에
대한 설계 판단을 받은 뒤 제품 구현 재개 여부를 정한다. 기존 deny 기본 동작은
변경하지 않는다.

## 12. 정적 permissions.ask 진입 경계 검증 (2026-09-18)

11절의 hook timeout 누수는 정적 ask 규칙이 없는 조건이었다. 실제 Claude Code
2.1.263에서 `permissions.ask`를 추가한 뒤 같은 host MCP 경로로 재측정했다.
Read는 `permissions.ask: ["Read"]`, Bash는 `Bash(cat <검증 파일 절대 경로>)`로
해당 명령을 정확히 지정했다. 허용 목록과 금지 목록에는 넣지 않았다.
`--permission-mode default`, `--permission-prompts host`, 승인 MCP 도구 설정은
유지하고 sandbox는 활성화, `failIfUnavailable=true`, 자동 허용만 on/off로 바꿨다.

### 행렬 결과

각 hook 상태 × MCP allow/deny × Read/Bash(cat) × sandbox 자동 허용 on/off의
**40회**를 측정했다. 아래 결과는 네 도구·sandbox 조합에서 모두 동일했다.
실행은 tool_result의 실제 marker 반환으로 판정하고, MCP 요청 수는 해당
서버가 수신한 요청 기록으로 확인했다.

| hook 상태                    | MCP 요청 수 (실행당) | MCP allow일 때 | MCP deny일 때 |
| ---------------------------- | -------------------- | -------------- | ------------- |
| hook 설정 없음               | 1                    | marker 반환    | marker 미반환 |
| 5초 지연, timeout 2초로 취소 | 1                    | marker 반환    | marker 미반환 |
| 즉시 ask                     | 1                    | marker 반환    | marker 미반환 |
| 즉시 deny                    | 0                    | marker 미반환  | marker 미반환 |
| 즉시 allow                   | 1                    | marker 반환    | marker 미반환 |

핵심 취소 사례에서 hook_response는 `outcome: "cancelled"`, `exit_code: 1`로
CLI 스트림에 나타났고, 이후 **정적 ask 규칙에 의해 MCP 요청이 한 번 발생했다.**
MCP deny면 실제 내용은 반환되지 않았다. 즉시 hook allow도 정적 ask를 우회하지
못했다. 반대로 즉시 hook deny는 승인 창구에 도달하기 전에 차단했다. hook ask와
정적 ask가 겹쳐도 중복 승인 요청은 관측되지 않았다.

추가로 hook 취소와 MCP `isError` 응답·시작 실패·요청 수신 직후 종료를 결합한
**12회**도 측정했다. 네 조합 모두 실제 marker가 반환되지 않았고, 앞의 두 경계를
결합해도 실패가 허용으로 바뀌지 않았다. 시작 실패는 MCP 호출 불가 오류,
나머지는 승인 서버 오류·연결 종료 오류였다. 이번 측정은 합계 52회다.

### 설계에 반영할 결론

**측정한 Read와 Bash(cat)의 진입 구멍은 정적 ask + host MCP 조합으로 닫혔다.**
단순히 hook 취소 이벤트를 뒤늦게 감지해 실행을 종료하는 방식에 의존하지 않는다.
정적 ask가 실행 전에 승인 창구로 넘기는 경계이며, hook은 유일한 게이트가 아니다.

`approval_mode=ask` 구현은 다음 조건을 유지해야 한다.

- 승인 대상 범위를 정적 `permissions.ask`에 완전히 포함한다. 이 실험의 정확한
  cat 한 명령 규칙을 모든 Bash 입력이나 다른 도구에 대한 검증으로 일반화하지 않는다.
- hook deny는 승인 경로에 도달하지 않으므로 사람이 예외를 승인할 수 있는 정책
  차단은 ask 또는 통과로 연결하고, 절대 허용할 수 없는 차단만 즉시 deny한다.
- hook allow도 ask 규칙을 우회하지 못하므로 MCP가 정책 판정을 다시 수행해야 한다.
  기존 정책상 허용인 요청은 빠르게 allow하고, 사람 승인이 필요한 요청만 기다린다.
- MCP의 오류·연결 실패·무응답은 명시적 허용이 될 수 없다. 무응답 관찰 범위와
  180초 승인 성공은 11절을 따른다. 제품의 유한 마감은 MCP 측에서 deny로 끝낸다.
- 기본 `approval_mode=deny`의 argv·settings·동작은 바꾸지 않는다.

SDK 대체 실험은 필요하지 않았다. 이 결과는 검증한 버전과 설정·도구 범위의
측정 근거이며, 아직 서버·데몬·웹 구현이나 전체 제품의 보안 검증 완료를 뜻하지
않는다. 이후 구현에서는 생성된 ask 규칙의 범위 누락을 별도 테스트해야 한다.

## 13. 웹 승인 조회와 갱신

웹은 `GET /v1/executions/:executionId/approvals`로 해당 실행의 승인 목록을
생성 순서대로 받는다. 사용자 JWT가 필요하며 실행자이자 확정 수신자인 사용자만
조회할 수 있다. 응답은 `id`, `executionId`, `toolName`, `detail`, `reason`,
`status`, `expiresAt` 및 결정·생성 정보를 포함한다. 조회 중 마감이나 실행 종료가
확인되면 같은 실행 잠금 아래 EXPIRED로 확정하고 감사 이벤트를 남긴다.

진행 화면은 최초 진입과 SSE 재연결 시 목록을 복구하고,
`execution.approval_requested` / `execution.approval_decided`를 받으면 해당
실행의 목록을 갱신한다. 두 이벤트도 실행자이자 확정 수신자에게만 전달한다.
마감 시각에는 버튼을 없애고 목록을 재조회한다. 이미 결정된 승인에 대한 409나
통신 실패는 화면에 표시하며, 허용을 추정하거나 자동으로 재시도하지 않는다.
명령·경로는 최대 2000자의 평문이며 사전 보호 항목 승인 모달과 별개다.
