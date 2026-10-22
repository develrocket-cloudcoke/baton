# Baton MVP 도메인 모델 · Request 상태머신 · API 설계 초안

> **문서 정합성 및 기준 안내 (2026-09-11 기준)**:
> 본 문서는 Baton MVP의 초기 설계 기준 문서입니다. 이후 구현 및 검증 과정에서 아래와 같이 사양이 구체화·확장되었으며, 충돌 시 해당 최신 문서가 우선합니다:
> 1. **조직·팀·통신 허용 및 Pairing**: `docs/design/05-organization-teams.md` (2026-09-07)가 우선 (단일 팀 제한 해제, `Organization`, `TeamLink`, `senderTeamId`/`recipientTeamId`, `recipientUserId` nullable[팀 뿌리기/claim], 8자리 1회용 pairing code).
> 2. **Desktop 데몬 IPC 및 다중 프로젝트·취소·heartbeat**: `docs/design/04-shell-daemon-ipc.md` (W6c, 2026-09-09)가 우선.
> 3. **결과 검토 단계 추가 작업 요청**: 기획서 §18, `CLO-8` (2026-09-11) 반영 (`RESULT_REVIEW → READY_TO_RUN`, `claude --resume` 세션 승계).
> 4. **실제 REST 엔드포인트 전체**: `apps/server/w5b-swagger.json` (Swagger) 및 §5 표 참조.

## 1. 목적과 범위

이 문서는 `docs/baton-service-plan.md` §6, §15, §21~§23, §32를 구현 가능한 MVP 모델로 구체화한다. MVP는 **사용자 A와 B의 1:1 협업 및 팀 간 협업**, **Claude Code 1종**, Markdown 문서와 파일 첨부, Desktop Agent를 통한 로컬 실행을 대상으로 한다.

모든 시간은 서버가 기록한 UTC timestamp를 기준으로 하고, 화면은 사용자 locale로 변환한다. 식별자는 서버가 발급하는 불투명 ID(UUID v4 기반)이며, `created_at`/`updated_at`은 모든 변경 가능 엔티티에 공통으로 둔다.

### 용어와 불변식

- `Request`는 A가 B 또는 B의 팀에게 전달하는 업무의 논리적 단위다. `RequestRevision`은 Request 본문·수신자·첨부 구성을 재전송할 때의 불변 snapshot이며, 별도 API 리소스로 노출하지 않고 Request 내부 컬렉션으로 관리한다.
- `original_instruction`은 발신자 A가 확정해 보낸 원본 요청이다. `additional_instruction`은 수신자 B가 실행 전에 작성한 추가 명령이다(추가 작업 요청 시 이번 회차 지시를 담는다). 두 값은 절대로 합쳐 저장하지 않으며, Execution 시점에는 각각의 snapshot을 보존한다.
- B의 Agent/Project는 B만 실행 대상으로 선택할 수 있다. A는 B의 Agent를 직접 실행하거나 추가 명령을 작성할 수 없다.
- Document와 Artifact는 `LocalDiskStorage`(`/tmp/baton-storage`) 또는 S3 호환 스토리지를 통해 저장되며, `POST /v1/uploads` 및 `complete` 파이프라인으로 sha256 무결성을 검증한다.

## 2. 엔티티

### 2.1 User와 Team (05 문서 확정 모델)

> 05 문서(`05-organization-teams.md`)에 따라 조직(`Organization`), 관리자가 허용한 통신 경로(`TeamLink`), 사용자당 다중 팀 소속이 지원됩니다.

| 엔티티 | 필드 | 설명 |
| --- | --- | --- |
| Organization | `id`, `name`, `slug`, `created_by_user_id`, `created_at` | 조직 경계 (기본 seed: `example`). |
| OrgMembership | `org_id`, `user_id`, `role`, `joined_at` | 사용자-조직 관계. `role`: `ORG_ADMIN`, `MEMBER`. |
| User | `id`, `email`, `display_name`, `status`, `created_at` | 서비스 사용자. `status`: `ACTIVE`, `INACTIVE`. 비밀번호는 해시 저장. |
| Team | `id`, `org_id`, `name`, `created_by_user_id`, `created_at` | 조직 내 팀(협업 경계). `[org_id, name]` 복합 unique. |
| TeamMembership | `team_id`, `user_id`, `role`, `joined_at` | 사용자-팀 관계 (다대다). `role`: `TEAM_LEAD`, `MEMBER`. |
| TeamLink | `id`, `org_id`, `from_team_id`, `to_team_id`, `created_by_user_id` | 관리자가 허용한 팀 간 통신 경로. 양방향 허용 시 두 행 쌍으로 생성. |

### 2.2 실행 환경 및 디바이스

| 엔티티 | 필드 | 설명 |
| --- | --- | --- |
| Device | `id`, `user_id`, `device_name`, `platform`, `os_version`, `app_version`, `hostname`, `last_seen_at` | 사용자가 1회용 pairing code로 등록한 클라이언트 디바이스 (메뉴바/콘솔). 60초 주기 heartbeat로 `last_seen_at` 갱신(2분 무응답 시 OFFLINE 판정). |
| PairingCode | `id`, `user_id`, `code_hash`, `expires_at`, `used_at` | 웹 `/me/devices`에서 발급하는 8자리(`XXXX-XXXX`) 1회용 10분 유효 코드. |
| Agent | `id`, `owner_user_id`, `device_id`, `provider`, `display_name`, `status`, `last_seen_at` | 사용자의 디바이스가 등록한 AI Agent. MVP `provider`는 `CLAUDE_CODE`. 디바이스당 1개 활성 유지(CLO-13). `status`: `ONLINE`, `OFFLINE`, `BUSY`, `DISABLED`. |
| Project | `id`, `owner_user_id`, `agent_id`, `display_name`, `local_path_hint`, `status` | Agent가 실행할 로컬 프로젝트 (다중 프로젝트 지원). `local_path_hint`는 로컬 절대 경로. |

### 2.3 협업 콘텐츠

| 엔티티 | 필드 | 설명 |
| --- | --- | --- |
| Request | `id`, `sender_team_id`, `recipient_team_id`, `sender_user_id`, `recipient_user_id`, `title`, `state`, `current_revision_no`, `current_revision_id`, `return_reason`, `claimed_at`, `accepted_at`, `completed_at` | 업무 논리 단위. `recipient_user_id`가 null이면 팀 전체 뿌리기이며, 첫 수락/반려/거절 시 claim되어 확정됨. |
| RequestRevision | `id`, `request_id`, `revision_no`, `original_instruction`, `document_version_ids`, `artifact_ids`, `created_by_user_id`, `created_at`, `sent_at` | 발신자가 보낸 내용의 불변 snapshot. `revision_no`는 Request 내 단조 증가. |
| Document | `id`, `team_id`, `owner_user_id`, `name`, `mime_type`, `current_version_id` | 사람이거나 Agent가 작성한 문서 논리 파일. MVP는 `text/markdown`. |
| DocumentVersion | `id`, `document_id`, `version_no`, `content`, `content_sha256`, `created_by_type`, `created_by_user_id`, `created_at`, `change_note` | 불변 문서 버전. `content`에 Markdown 본문 저장, 버전 간 diff 비교 지원. |
| Artifact | `id`, `team_id`, `owner_user_id`, `request_id`, `kind`, `filename`, `mime_type`, `storage_ref`, `sha256`, `size_bytes`, `created_at` | 요청 입력(server.log 등) 또는 결과 첨부(changes.patch, stream.jsonl). `kind`: `REQUEST_ATTACHMENT`, `RESULT_ATTACHMENT`, `PATCH`, `TEST_OUTPUT`. |

### 2.4 실행과 결과

| 엔티티 | 필드 | 설명 |
| --- | --- | --- |
| Execution | `id`, `request_id`, `request_revision_id`, `executor_user_id`, `agent_id`, `project_id`, `additional_instruction`, `status`, `claude_session_id`, `previous_execution_id`, `started_at`, `finished_at`, `failure_reason` | B가 시작한 Agent 실행. `status`: `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED`. 취소 지원(`CANCELLED`). 추가 작업 요청 시 직전 `claude_session_id`를 물려받아 `--resume` 이어가기. |
| Result | `kind`, `id`, `execution_id`, `summary`, `changed_files`, `test_summary`, `result_document_version_id`, `artifact_ids`, `review_status`, `reviewed_by_user_id`, `reviewed_at`, `sent_at` | Agent 실행 결과. `kind`: `FINAL`(승인 대상), `PARTIAL`(취소된 회차의 부분 결과, 승인 불가 — 2026-09-11 CLO-11). `review_status`: `PENDING`, `APPROVED`. 최신 회차의 **`FINAL`** 결과만 승인 가능(과거 회차·부분 결과 승인은 409). |
| TimelineEvent | `id`, `request_id`, `request_revision_id`, `execution_id`, `actor_type`, `actor_user_id`, `agent_id`, `event_type`, `occurred_at`, `payload` | Request 감사 이력. §4 이벤트 목록 참조. |

## 3. Request 상태머신

### 3.1 재전송 결정: 같은 Request의 새 revision

`RETURNED` 뒤 A가 보완하여 다시 보내는 것은 **같은 Request에 새 `RequestRevision`을 추가한 뒤 `SENT`로 전이**하는 것으로 결정한다. §22의 한 Timeline 안에서 반려→문서 v2 생성→재전송이 이어지고 §23이 동일 Document의 version 관리를 요구하므로, 새 Request를 만들면 업무의 인과관계·반려 사유·문서 이력이 분리된다.

새 Request는 업무 목표 또는 수신자가 실질적으로 바뀌어 기존 반려 건과 독립적으로 추적해야 할 때 A가 명시적으로 생성한다. `RETURNED` 상태에서 기존 revision을 수정하는 것은 금지하며, 새 revision만 만들 수 있다.

### 3.2 상태 전이 표

`서버`는 권한·현재 상태·필수 필드를 검증하고 TimelineEvent 및 대상 알림을 기록한다. 여기서 `Desktop Agent`는 B가 이미 수락하고 실행을 명시적으로 요청한 Execution의 상태만 보고할 수 있다.

| 현재 상태 | 다음 상태 | 트리거 주체 / 동작 | 부수 효과 · 알림 |
| --- | --- | --- | --- |
| 없음 | `DRAFT` | 사람(A, Web): Request와 revision 1 생성 | `request.created`; 수신자에게 알리지 않음 |
| `DRAFT` | `SENT` | 사람(A, Web): 전송 | 현재 revision의 `sent_at` 기록, `request.sent`, B 디바이스 알림 생성 |
| `SENT` | `DELIVERED` | 서버/사람(B): B 디바이스 전달 확인 또는 Web 열람 | `request.delivered` / `request.viewed` (전달 확인 및 열람 시 상태 자동 보정) |
| `DELIVERED` | `REVIEWING` | 사람(B, Web): 검토 시작 | `request.review_started` (팀 뿌리기 시 첫 수락/반려/거절로 claim 확정) |
| `REVIEWING` | `ACCEPTED` | 사람(B, Web): 수락 | `accepted_at` 기록, `request.accepted`, A에게 수락 알림 (팀 뿌리기면 claim) |
| `REVIEWING` | `RETURNED` | 사람(B, Web): 보완 요청과 사유 제출 | `return_reason` 기록, `request.returned`, A Desktop 알림 생성 (팀 뿌리기면 claim) |
| `REVIEWING` | `REJECTED` | 사람(B, Web): 거절 | `request.rejected`, A Desktop 알림 생성; 종료 상태 (팀 뿌리기면 claim) |
| `RETURNED` | `SENT` | 사람(A, Web): 새 RequestRevision 생성 후 재전송 | 새 revision·첨부 snapshot 생성, `request.resent`, B Desktop 알림 생성 |
| `ACCEPTED` | `READY_TO_RUN` | 사람(B, Web): Agent, Project, 추가 명령을 선택하고 실행 준비 | Execution을 `QUEUED`로 생성, `execution.queued`; 실행 명령 이벤트 생성 |
| `READY_TO_RUN` | `READY_TO_RUN` | 사람(B, Web): 실행 파라미터 재설정 | 실행 준비 상태 유지 |
| `READY_TO_RUN` | `RUNNING` | Desktop Agent(B): Claude Code 실행 시작 보고 | Execution=`RUNNING`, Agent=`BUSY`, `execution.started`, A/B에 진행 상태 노출 |
| `READY_TO_RUN` | `FAILED` | Desktop Agent(B) 또는 서버: 실행 시작 불가 | Execution=`FAILED`, 사유 기록, Agent 상태 갱신, `execution.failed`, B 알림 |
| `RUNNING` | `RESULT_REVIEW` | Desktop Agent(B): 결과 업로드 및 성공 완료 보고 | Execution=`SUCCEEDED`, Result=`PENDING` 생성, Agent 상태 갱신, `execution.finished`; B에게 검토 알림 |
| `RUNNING` | `FAILED` | Desktop Agent(B): Claude Code 실행 실패 보고 | Execution=`FAILED`, 사유 기록, Agent 상태 갱신, `execution.failed`; B 알림 |
| `RUNNING` | `READY_TO_RUN` | 사람(B, Web): **실행 취소** (2026-09-09 W6 반영) | `POST /v1/executions/{id}/cancel` → Execution=`CANCELLED`, Request=`READY_TO_RUN` 복귀, 데몬에 `execution.command.cancel_requested` 발행(SIGTERM→SIGKILL); B 실행 준비 폼 재노출. 데몬이 뒤이어 보고하는 **부분 결과**(`PARTIAL`)는 이 상태를 바꾸지 않는다(§3.2, 2026-09-11 CLO-11) |
| `FAILED` | `READY_TO_RUN` | 사람(B, Web): 재실행 (2026-09-04 PoC 반영, D4) | 새 Execution(`QUEUED`) 생성(`previous_execution_id` 기록), `execution.queued`, 실행 명령 재발행; B 알림 |
| `RESULT_REVIEW` | `READY_TO_RUN` | 사람(B, Web): 기획서 §18 **추가 작업 요청** (2026-09-11 CLO-8 반영) | 새 Execution(`QUEUED`) 생성(`previous_execution_id`·`claude_session_id` 승계), `execution.follow_up_requested`·`request.ready_to_run`·`execution.queued`, 실행 명령 발행(payload 에 `followUpInstruction`·`resumeSessionId`) |
| `RESULT_REVIEW` | `COMPLETED` | 사람(B, Web): 결과 승인·전달 | 최신 Result=`APPROVED`, `sent_at` 기록, `result.approved`, `result.sent`, A 알림 생성 |

`REJECTED`, `COMPLETED`는 MVP의 최종 종료 상태다. `FAILED` 후 B가 재실행하는 경우 **(2026-09-04 PoC 반영, D4 확정)**: 새 `Execution`을 생성(`previous_execution_id` 기록)하고 Request 상태를 **`READY_TO_RUN`으로 복귀**시킨다. 기존 실패한 Execution은 이력으로 보존되며, 수신자 B는 추가 지시사항을 수정하거나 동일한 파라미터로 즉시 재시도할 수 있다.

**추가 작업 요청(§18, 2026-09-11 CLO-8 인수)**: `RESULT_REVIEW → READY_TO_RUN` 은 `RECIPIENT` 만 할 수 있고, 첫 실행과 똑같이 **데몬의 실제 시작 보고**에서만 `RUNNING` 으로 넘어간다. 새 Execution 은 직전 Execution 의 `claude_session_id` 를 `resumeSessionId` 로 물려받아 데몬이 `claude --resume` 으로 같은 세션을 이어가고, 프롬프트에는 `followUpInstruction`(이번 회차 지시)만 싣는다. 결과는 회차마다 별도 `Result` 로 쌓이며(`GET /v1/requests/{id}` 의 `results[]`), **승인은 최신 실행의 결과만** 가능하다(과거 결과 승인은 `409`). 데몬이 세션을 이어가지 못하면(만료·삭제) 새 세션에 원본 맥락을 다시 실어 재실행하고 그 사실을 진행 상태(`warning`)로 보고한다.

**취소된 실행의 부분 결과(2026-09-11 CLO-11)**: 취소는 서버가 먼저 확정한다. `POST /v1/executions/{id}/cancel` 이 Execution 을 `CANCELLED` 로 바꾸고 Request 를 `READY_TO_RUN` 으로 되돌린 뒤 데몬에 `execution.command.cancel_requested` 를 발행한다. 데몬은 자식 claude 를 끝내고, **그 시점까지 수집한 3계층 결과**(계층1 `structuredPatch`, 계층2 `git diff`, 계층3 `result.md`)를 `/v1/uploads` 로 올린 다음 `POST /v1/desktop/executions/{id}/result` 에 `{status:'CANCELLED', summary, changedFiles, artifactIds}` 로 보고한다.

- 서버는 **이미 `CANCELLED` 인 Execution** 에만 이 보고를 받아 `Result` 를 `kind=PARTIAL` 로 upsert 한다. 그 외 상태면 `409`("취소 API 완료 후 부분 결과를 보고하세요"). 취소 뒤 늦게 도착한 보고, 재실행이 이미 진행 중일 때 도착한 중복 보고 모두 같은 Result 를 갱신할 뿐 Execution·Request 상태는 **바꾸지 않는다**.
- `artifactIds` 는 그 요청에 **본인이 올린** 산출물만 허용한다(그 외 `403`).
- 부분 결과는 승인 대상이 아니다. `POST /v1/results/{id}/approve-and-send` 는 `kind=PARTIAL` 이면 `409` 이고, 요청 상세의 `latestResult` 는 최신 실행의 결과가 `PARTIAL` 이면 `null` 이다(`results[]` 에는 남는다). 웹은 취소된 회차를 "취소됨 · 부분 결과"(변경 파일·diff 표시, 승인 버튼 없음)로, 수집된 것이 없으면 "취소됨 (수집된 변경 없음)"으로 보여 준다.
- 수집된 변경·patch·`result.md` 가 하나도 없으면 데몬은 아무것도 보고하지 않는다. 업로드나 보고가 실패해도 취소 자체는 이미 끝났으므로 데몬은 로그만 남긴다.
- 타임라인에 `result.partial_reported` 를 남긴다.

## 4. TimelineEvent 이벤트 타입 (`packages/shared` 기준 전수)

| 분류 | 이벤트 타입 |
| --- | --- |
| Request lifecycle | `request.created`, `request.sent`, `request.delivered`, `request.viewed`, `request.review_started`, `request.accepted`, `request.returned`, `request.rejected`, `request.resent`, `request.ready_to_run`, `request.completed`, `request.failed`, `request.claimed` |
| Revision·콘텐츠 | `request.revision_created`, `document.created`, `document.version_created`, `artifact.attached`, `artifact.detached` |
| 실행 및 제어 | `execution.queued`, `execution.command_requested`, `execution.started`, `execution.progress_reported`, `execution.finished`, `execution.failed`, `execution.follow_up_requested`, `execution.cancelled`, `execution.command.cancel_requested` |
| 결과 | `result.created`, `result.partial_reported`, `result.review_started`, `result.approved`, `result.sent` |
| 디바이스·Agent·알림 | `agent.registered`, `agent.status_changed`, `device.paired`, `notification.created`, `notification.delivered` |
| 조직·팀 (05) | `team.created`, `team.updated`, `team.deleted`, `team.link_created`, `team.link_revoked`, `team.member_added`, `team.member_removed` |

`execution.progress_reported`의 payload는 예를 들어 `phase`와 짧은 메시지(`"테스트 실행 중"`)만 담는다. Claude Code의 원시 전체 로그 보관은 MVP 범위에서 **확인 필요**이며, TimelineEvent를 로그 저장소로 사용하지 않는다.

## 5. REST API 초안

### 5.1 인증 경계

- **Web session**: 로그인한 사람의 User identity와 Team membership을 서버가 검증한다. A는 자신이 보낸 Request, B는 자신이 받은 Request에만 접근한다.
- **Desktop Agent credential**: 설치된 Desktop Agent의 credential과 소유 User를 검증한다. Desktop Agent는 자기 소유 Agent/Project/Execution만 등록·상태 보고·결과 업로드할 수 있다.
- **공통**: 수신자 B의 수락과 `READY_TO_RUN` 전이 이전에는 실행 명령을 만들지 않는다. 파일 다운로드와 문서 version 조회도 해당 Request의 sender/recipient 및 Team으로 제한한다.

### 5.2 Web API (실제 NestJS 컨트롤러 및 Swagger 기준)

| 메서드 | 경로 | 호출 주체 | 인증 경계 / 용도 |
| --- | --- | --- | --- |
| `POST` | `/v1/auth/login` | Web | `{ email, password }` 로그인, JWT 토큰 발급 및 `baton_token` 쿠키 설정 |
| `GET` | `/v1/me` | Web | Web session; 현재 User, OrgMembership, TeamMembership 조회 |
| `GET` | `/v1/recipients` | Web | `?senderTeamId=`; 05 규칙 기반 보낼 수 있는 팀·사용자 목록 조회 |
| `GET` | `/v1/requests` | Web | 본인이 sender/recipient이거나 소속 팀에 뿌려진 Request 목록 (`?box=inbox\|sent`) |
| `POST` | `/v1/requests` | Web(A) | Request 초안 생성 (`senderTeamId`, `recipientTeamId`, `recipientUserId?`) |
| `GET` | `/v1/requests/{requestId}` | Web | sender/recipient; revision, executions, results, timeline, attachments 종합 조회 |
| `PATCH` | `/v1/requests/{requestId}/draft` | Web(A) | sender + `DRAFT`; 전송 전 title, document, artifact 구성 편집 |
| `POST` | `/v1/requests/{requestId}/send` | Web(A) | sender + `DRAFT`; `SENT` 전이 및 대상 디바이스 SSE push |
| `POST` | `/v1/requests/{requestId}/revisions` | Web(A) | sender + `RETURNED`; 보완된 새 불변 revision 생성 |
| `POST` | `/v1/requests/{requestId}/resend` | Web(A) | sender + `RETURNED`; 새 revision으로 `SENT` 재전송 |
| `POST` | `/v1/requests/{requestId}/review/start` | Web(B) | recipient + `SENT/DELIVERED`; `REVIEWING` 전이 |
| `POST` | `/v1/requests/{requestId}/accept` | Web(B) | recipient + `REVIEWING`; `ACCEPTED` 전이 (팀 뿌리기 시 claim) |
| `POST` | `/v1/requests/{requestId}/return` | Web(B) | recipient + `REVIEWING`; `reason` 필수, `RETURNED` 전이 (팀 뿌리기 시 claim) |
| `POST` | `/v1/requests/{requestId}/reject` | Web(B) | recipient + `REVIEWING`; `REJECTED` 전이 (팀 뿌리기 시 claim) |
| `POST` | `/v1/requests/{requestId}/executions` | Web(B) | recipient + `ACCEPTED` 또는 `RESULT_REVIEW`; Execution 생성 및 `READY_TO_RUN` 전이 (추가 작업 시 `followUpInstruction` 전달) |
| `POST` | `/v1/executions/{executionId}/cancel` | Web(B) | recipient + `QUEUED/RUNNING`; 실행 취소, `CANCELLED` 처리 및 Request `READY_TO_RUN` 복귀 (W6 반영) |
| `GET` | `/v1/executions/{executionId}` | Web | 관련 Request의 sender/recipient; 실행 상태·결과 요약 조회 |
| `POST` | `/v1/results/{resultId}/approve-and-send` | Web(B) | recipient + `RESULT_REVIEW`; 최신 회차 승인·A 전달·`COMPLETED` 전이 (과거 회차 승인은 409) |
| `GET` | `/v1/requests/{requestId}/timeline` | Web | sender 또는 recipient; append-only TimelineEvent 조회 |
| `POST` | `/v1/requests/{requestId}/documents` | Web(A/B) | sender는 입력, recipient는 결과 검토용 문서 생성; Markdown 지원 |
| `GET` | `/v1/documents/{documentId}/versions` | Web | 관련 Request의 sender/recipient; 전체 version 목록 조회 |
| `POST` | `/v1/documents/{documentId}/versions` | Web(A) | 기존 문서에 보완된 새 버전 추가 |
| `GET` | `/v1/documents/versions/{versionId}` | Web | 특정 문서 버전 메타데이터 및 내용 조회 |
| `GET` | `/v1/documents/versions/{versionId}/download` | Web/데몬 | 특정 문서 버전 원문 다운로드 (device token 허용) |
| `POST` | `/v1/uploads` | Web/데몬 | Artifact 업로드 세션/메타데이터 생성 (발신 팀 또는 요청 접근자) |
| `POST` | `/v1/uploads/{artifactId}/complete` | Web/데몬 | 업로드 완료 및 sha256 검증 확정 |
| `GET` | `/v1/artifacts/{artifactId}` | Web/데몬 | 관련 Request 접근자; metadata 및 다운로드 URL 확인 |
| `PUT` / `GET` | `/v1/storage/local/{key}` | Web/데몬 | 로컬 스토리지 업로드 / 원문 다운로드 (바이트 스트림) |
| `GET` | `/v1/events` | Web | Web 브라우저용 실시간 SSE 알림 스트림 |
| `POST` | `/v1/me/pairing-codes` | Web(B) | 웹에서 본인 전용 1회용 8자리 pairing code 발급 (10분 유효) |
| `GET` | `/v1/me/devices` | Web | 본인 페어링 디바이스 목록 및 온라인 상태 조회 (2분 기준) |
| `DELETE` | `/v1/me/devices/{deviceId}` | Web | 페어링 디바이스 연결 해제 및 토큰 폐기 |
| `GET` | `/v1/agents` | Web | 본인 소유 Agent 목록 (ONLINE 우선, 2분 무응답 시 OFFLINE) |
| `DELETE` | `/v1/agents/{agentId}` | Web | Agent 비활성화 (`DISABLED`, CLO-13) |
| `GET` | `/v1/projects` | Web | 본인 소유 Project 목록 |
| 조직/팀 | `/v1/org/**` | ADMIN/LEAD | 조직·팀·팀원·팀링크 관리 엔드포인트는 `05-organization-teams.md` §4 참조 |

### 5.3 Desktop Agent API (실제 NestJS 컨트롤러 및 Swagger 기준)

| 메서드 | 경로 | 호출 주체 | 인증 경계 / 용도 |
| --- | --- | --- | --- |
| `POST` | `/v1/devices/pair` | Desktop Agent | 웹 발급 1회용 pairing code로 디바이스 등록 및 device token 발급 (플랫폼·호스트 정보 포함, 05/04 확정) |
| `POST` | `/v1/desktop/heartbeat` | Desktop Agent | 60초 주기 heartbeat 전송, lastSeenAt 갱신 및 상태 유지 (04 §11.4) |
| `GET` | `/v1/desktop/events/stream` | Desktop Agent | SSE 하향 이벤트 푸시 구독 (명령, 취소, 알림, 중복연결 교체) |
| `GET` | `/v1/desktop/events/replay` | Desktop Agent | 재연결 시 최근 24시간 미수신 이벤트 재생 (최대 500건, CLO-12) |
| `POST` | `/v1/desktop/agents` | Desktop Agent | 디바이스당 CLAUDE_CODE Agent 1개 등록 및 동기화 (CLO-13) |
| `PATCH` | `/v1/desktop/agents/{agentId}/presence` | Desktop Agent | 자기 Agent의 상태(`ONLINE`/`OFFLINE`/`BUSY`/`DISABLED`) 보고 |
| `POST` | `/v1/desktop/projects` | Desktop Agent | 자기 소유 로컬 Project 등록 (`displayName`, `localPathHint`) |
| `POST` | `/v1/desktop/executions/{executionId}/status` | Desktop Agent | B 소유 Agent의 Execution 진행 상태 보고 (`RUNNING`, `PROGRESS`, 단계 문구 `phase`, `message`, `sessionId`) |
| `POST` | `/v1/desktop/executions/{executionId}/result` | Desktop Agent | B 소유 Agent의 Execution 결과 보고 (`SUCCEEDED`, `FAILED`, summary, diff/patch, result.md, failureReason). `CANCELLED`는 **이미 취소된** Execution의 부분 결과 보고이며 상태를 바꾸지 않는다(§3.2, CLO-11) |

> `POST /v1/desktop/installations/register`는 MVP 1.0 초안 엔드포인트이며, `05-organization-teams.md`에 따라 웹 발급 코드 기반 `POST /v1/devices/pair`로 대체되었습니다.

#### 5.3.1 이벤트 신뢰성과 영속화 (2026-09-04 PoC 반영: F5)

- **Transactional Outbox**: 서버 재시작이나 네트워크 단절 시 이벤트 유실을 방지하기 위해 `POST /v1/requests/{requestId}/executions` 처리 시 `Execution` 생성과 `outbox_events` 테이블 삽입을 **단일 DB 트랜잭션**으로 원자적 커밋한다.
- **Durable Event Dispatch**: SSE 이벤트 전송기는 `outbox_events` 테이블에서 미전송 이벤트를 읽어 발행하며, Desktop Agent 재연결 시 `Last-Event-ID`를 기반으로 최근 24시간 미수신 명령(최대 500건)을 재생한다.
- **Device Token 영속화**: 페어링된 디바이스 토큰과 세션 정보는 DB(`device_tokens`, `devices`)에 영속 저장하여 서버 재시작 후에도 재인증 없이 연결을 복구한다.

### 5.4 서버→Desktop Agent 실행 명령 이벤트 이름

전송 방식은 D1 결정(SSE 하향 푸시 + HTTPS REST 상향 보고)을 따른다. 서버는 B가 `POST /v1/requests/{requestId}/executions`를 성공시킨 뒤에만 다음 이벤트를 B 소유 Desktop Agent에 발행한다.

| 이벤트 이름 | 최소 payload | 의미 |
| --- | --- | --- |
| `execution.command.requested` | `execution_id`, `request_id`, `request_revision_id`, `agent_id`, `project_id`, `original_instruction`, `additional_instruction`, `attachments`, `policy`, `title`, `senderName`, `webUrl`, `followUpInstruction?`, `resumeSessionId?` | 수락된 Request의 Claude Code 실행을 요청. Desktop Agent는 원본 요청·첨부·추가 명령의 권한 있는 snapshot과 구조화된 policy를 수신해 실행한다. 추가 작업 시 `followUpInstruction`과 `resumeSessionId`를 포함. (2026-09-04 F4 및 2026-09-11 CLO-8 반영) |
| `execution.command.cancel_requested` | `execution_id`, `request_id`, `reason?` | 수신자 B가 웹에서 실행 취소를 눌렀을 때 발행 (2026-09-09 W6c 구현 완료). Desktop Agent는 자식 Claude 프로세스에 SIGTERM → (5초) → SIGKILL을 전달하고 Execution을 취소함. |

#### 5.4.1 구조화된 policy 필드 스키마 (2026-09-04 PoC 반영: F4)

자연어 지시("운영 환경은 변경하지 마")를 모델이 "로컬 파일도 고치지 마"로 오해하는 문제를 방지하기 위해, 실행 명령 payload에 아래의 명시적인 구조화 policy 필드를 포함한다.

| 필드 | 타입 | 허용 값 | 기본값 | 설명 |
|---|---|---|---|---|
| `repository_edit` | `string` | `"allow"`, `"deny"` | `"allow"` | 대상 로컬 프로젝트 워크스페이스 내 파일 생성·수정 허용 여부 |
| `deployment_apply` | `string` | `"deny"`, `"allow"` | `"deny"` | 쿠버네티스/클라우드 등 외부 클러스터에 실제 배포/적용(`kubectl apply`, `helm` 등) 금지 |
| `network_outbound` | `string` | `"deny"`, `"allow"` | `"deny"` | 외부 인터넷 아웃바운드 통신 허용 여부 (OS 샌드박스로 강제) |
| `outside_write` | `string` | `"deny"`, `"allow"` | `"deny"` | 대상 프로젝트 루트 외부 경로 파일 쓰기 차단 (PreToolUse hook 및 샌드박스로 강제) |
| `shell_execution` | `string` | `"allow"`, `"deny"`, `"read_only"` | `"allow"` | 셸 명령 실행 허용 수준 |

## 6. MVP에서 제외하거나 보류하는 항목

- Claude Code 외 Agent provider 및 Agent Adapter 다중 구현(Codex, Gemini CLI, OpenCode).
- 3명 이상 다자간 Request, 그룹 배정, 여러 recipient, 외부 협업자 모델.
- 자동 승인, 신뢰 관계 기반 policy, Rule Engine.
- 세분화된 Project capability 정책(예: Shell/Network/AWS/Kubernetes Read/Write)과 policy enforcement의 구체 방식. 단, B 수락 전 실행 금지와 Agent 소유자 제한, 5.4.1의 기본 구조화 policy는 MVP 필수다. (2026-09-04 PoC 반영)
- 실행 취소, 재시도/재실행의 완전한 상태 전이, 결과 `CHANGES_REQUESTED` 반복 workflow. (단, FAILED 후 단순 재실행 D4는 포함).
- Document diff UI, 장기 보관·삭제·보존 정책, 대용량 파일/바이러스 검사, 저장소·다운로드 URL 구현 세부.
- Claude Code 원시 실행 로그 전문, 비용/토큰 사용량, 실시간 terminal streaming.
- Team admin, 초대, 회원가입/로그인 provider, Desktop installation credential rotation 같은 계정 운영 세부.
- Desktop Agent 형태: D5 결정에 따라 macOS는 Swift 메뉴바 셸(`apps/desktop-macos`)과 Node 데몬(`apps/desktop-agent`)의 조합으로 제공한다. 복잡한 Electron 창 UI는 제외하되, 메뉴바 팝오버 및 macOS 네이티브 `UNUserNotificationCenter` 알림 클릭 콜백(웹 열기 연계)을 포함한다. (2026-09-04 PoC 반영: D5)

## 7. MVP 이후 확장 지점

- `Agent.provider` enum과 provider-specific adapter capability를 분리해 다중 Agent를 추가한다. 현재 `CLAUDE_CODE` 고정 검증을 capability negotiation으로 교체한다.
- `TeamMembership` role 및 Request recipient 모델을 확장해 다자간 review/assignment를 지원한다.
- `Execution`에 retry 관계(`retry_of_execution_id`)와 Result revision을 추가해 재실행·변경 요청 loop를 명시적으로 모델링한다.
- Project의 정책 snapshot을 Execution에 기록하여 capability policy, 자동 승인, 위험 작업 승인 흐름을 추가한다.
- 명령 전달 transport를 결정한 뒤 `execution.command.requested`의 delivery ID·acknowledgement·at-least-once 처리 규칙을 별도 정의한다.
