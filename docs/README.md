# Baton 문서 가이드 (Documentation Index & Reading Guide)

본 문서는 Baton 모노레포의 설계·구현·테스트·인수 문서의 전체 목록, 권장 열람 순서, 문서 간 우선순위 관계를 정리한 인덱스입니다.

---

## 1. 역할별 권장 열람 순서 (Reading Order)

### 1.1 신규 참여자 / 전체 시스템 개요 파악
1. [루트 README.md](../README.md): 프로젝트 개요, 개발 환경 기동(`./scripts/dev-up.sh`), Phase 1 로컬 테스트 절차.
2. [docs/README.md](./README.md): (본 문서) 문서 지도 및 우선순위 파악.
3. [docs/baton-service-plan.md](./baton-service-plan.md): 서비스 기획서 원본 (3단계 협업 철학, 사용자 시나리오 §33, 추가 작업 요청 §18).
4. [docs/00-mvp-plan.md](./00-mvp-plan.md): 기술 스택 및 핵심 아키텍처 결정(D1~D5), 마일스톤(W0~W4).
5. [docs/design/01-domain-and-api.md](./design/01-domain-and-api.md) 및 [docs/design/05-organization-teams.md](./design/05-organization-teams.md): 도메인 모델, 상태 머신, 조직/팀/링크 규칙.
6. [docs/design/06-multi-agent-adapters.md](./design/06-multi-agent-adapters.md) §0.1: **어느 AI 에이전트를 쓸 수 있고 무엇을 포기해야 하는지** 3종 비교표.
7. [docs/mvp-acceptance.md](./mvp-acceptance.md): 실제 환경 검증 이력 및 해결된 이슈 (§0~§14).

### 1.2 서버(Backend) 개발자
1. [docs/design/05-organization-teams.md](./design/05-organization-teams.md): 조직, 팀, 양방향 TeamLink, 팀 전체 뿌리기(claim) 규칙 (최우선 기준).
2. [docs/design/01-domain-and-api.md](./design/01-domain-and-api.md): Request 상태머신, 엔티티, Transactional Outbox.
3. [apps/server/w5b-swagger.json](../apps/server/w5b-swagger.json) & [apps/server/README.md](../apps/server/README.md): Swagger API 명세, SSE replay, CLO-12/13 Agent 라이프사이클.
4. [docs/design/06-multi-agent-adapters.md](./design/06-multi-agent-adapters.md) §5.4: **실행 위험 승인 계약**(강제 불가 항목 계산, `acknowledgedRisks`, 409 본문). 실행 게이트를 건드리기 전에 반드시 읽는다.
5. [docs/mvp-acceptance.md](./mvp-acceptance.md) (§9~§14): 실서버 통합 검증 버그 수정 내역.

### 1.3 데스크톱(Desktop Agent & Shell) 개발자
1. [docs/design/04-shell-daemon-ipc.md](./design/04-shell-daemon-ipc.md): Swift 셸 ↔ Node 데몬 stdin/stdout JSON Lines IPC 계약 (v=1, 최우선 기준).
2. [docs/design/02-desktop-agent-and-adapter.md](./design/02-desktop-agent-and-adapter.md): Claude Code 헤드리스 실행(`-p --output-format stream-json --verbose`), 3계층 결과 수집, 정책 강제.
3. [apps/desktop-macos/README.md](../apps/desktop-macos/README.md): Swift 메뉴바 앱 빌드(`build.sh`), 권한, 개발 플래그(`BATON_TOKEN_STORE=file`).
4. [docs/design/06-multi-agent-adapters.md](./design/06-multi-agent-adapters.md): **Provider Adapter 계약**(§2.2 인터페이스), Claude Code·Codex·Antigravity 3종 실측(§3.3), capability 선언 근거(§4.4). 새 Provider 를 붙일 때의 최우선 기준.
5. [docs/mvp-acceptance.md](./mvp-acceptance.md) (§8, §10, §11, §14): 셸 UI 실측, 다중 프로젝트 라우팅, 중복 데몬 종료(exit 17), `--resume` 추가 작업 검증, 3종 Adapter 구현 현황.

### 1.4 웹(Frontend) 개발자
1. [apps/web/docs/integration-notes.md](../apps/web/docs/integration-notes.md): Web Real/Mock 모드 연동 계약, 어댑터 매핑, 캡처 스크린샷 목록.
2. [docs/design/05-organization-teams.md](./design/05-organization-teams.md): 관리자 화면(`/admin/*`), 내 디바이스(`/me/devices`), 수신 대상 선택.
3. [docs/design/01-domain-and-api.md](./design/01-domain-and-api.md): Request 상세 및 상태 전이, TimelineEvent 매핑.
4. [docs/design/06-multi-agent-adapters.md](./design/06-multi-agent-adapters.md) §4.3·§5.4: capability 기반 조건부 UI 와 위험 승인 화면의 계약. 서버측 계약 전문은 [apps/server/CLO-108-report.md](../apps/server/CLO-108-report.md).
5. [docs/test-plan.md](./test-plan.md): 사용자 관점 8대 시나리오.

### 1.5 QA / 인수 검증자
1. [docs/test-plan.md](./test-plan.md): Phase 1 로컬 및 Phase 2 분산 검증 계획, 시나리오 1~8.
2. [docs/mvp-acceptance.md](./mvp-acceptance.md): 실제 검증 절차, 자동화 드라이버(`scripts/acceptance/*.py`), 증거 스크린샷/로그.

---

## 2. 문서 목록 및 최신 갱신 시점 (Document Catalog)

| 파일 경로 | 문서 명칭 | 핵심 역할 및 내용 | 최신 갱신 |
|---|---|---|---|
| [`README.md`](../README.md) | Baton 루트 안내 | 개발 환경 기동(`dev-up.sh`), Phase 1 로컬 테스트 절차, CLI 사용법 | 2026-09-11 |
| [`docs/README.md`](./README.md) | 문서 인덱스 (본 문서) | 전체 문서 목록, 권장 읽기 순서, 문서 간 우선순위 기준표 | 2026-09-11 |
| [`docs/baton-service-plan.md`](./baton-service-plan.md) | 서비스 기획서 | Baton 서비스 철학, 3단계 협업 흐름, §18 추가 작업 요청, §33 시나리오 | 2026-09-04 |
| [`docs/00-mvp-plan.md`](./00-mvp-plan.md) | MVP 실행 계획 | 핵심 결정 D1~D5 (D1: SSE+REST, D5: Swift 셸+Node 데몬), 작업 분해 W0~W4 | 2026-09-04 |
| [`docs/01-feasibility-report.md`](./01-feasibility-report.md) | PoC 실측 보고서 | F1~F6 기술 검증 결과 (Settings canary, 자격증명 격리, Outbox 등) | 2026-09-04 |
| [`docs/research/03-stack-and-landscape.md`](./research/03-stack-and-landscape.md) | 기술 스택 조사 | 프론트엔드/백엔드/데스크톱 대안 비교 및 결정 근거 | 2026-09-04 |
| [`docs/design/01-domain-and-api.md`](./design/01-domain-and-api.md) | 도메인 모델 & API | 엔티티 정의, Request 상태머신, TimelineEvent, REST API 목록 | 2026-09-11 |
| [`docs/design/02-desktop-agent-and-adapter.md`](./design/02-desktop-agent-and-adapter.md) | Desktop & Adapter | Claude Code 헤드리스 실행 플래그, 3계층 수집, 정책 주입 설계 | 2026-09-11 |
| [`docs/design/04-shell-daemon-ipc.md`](./design/04-shell-daemon-ipc.md) | 셸 ↔ 데몬 IPC 계약 | Swift 셸과 Node 데몬 간 stdin/stdout JSON Lines 통신 규약 (v=1) | 2026-09-11 |
| [`docs/design/05-organization-teams.md`](./design/05-organization-teams.md) | 조직·팀·통신 허용 | Organization, TeamLink 양방향, 팀 뿌리기/claim, 8자리 1회용 pairing | 2026-09-07 |
| [`docs/design/06-multi-agent-adapters.md`](./design/06-multi-agent-adapters.md) | **다중 에이전트 Adapter** | Provider 3종(Claude Code·Codex·Antigravity) 실측 비교(§0.1), Adapter 인터페이스, capability 협상, **실행 위험 승인 모델(§5.4)** | 2026-09-11 |
| [`docs/test-plan.md`](./test-plan.md) | 테스트 계획서 | 시나리오 1~8 (Happy Path, 반려, 거절, 실패재실행, 보안, 조직, 하드닝, 추가작업) | 2026-09-11 |
| [`docs/mvp-acceptance.md`](./mvp-acceptance.md) | MVP 인수 검증 기록 | 실서버·실데몬·실제 Claude Code 통합 인수 실측 기록 (§0~§14) | 2026-09-11 |
| [`docs/deploy-plan.md`](./deploy-plan.md) | Phase 2 배포 계획 | AWS 클라우드(ALB + ECS + RDS + S3) 분산 배포 인프라 설계 | 2026-09-04 |
| [`apps/server/README.md`](../apps/server/README.md) | 서버 개발 가이드 | 환경변수, Swagger 재생성, 디바이스/Agent 라이프사이클(CLO-12/13) | 2026-09-11 |
| [`apps/desktop-macos/README.md`](../apps/desktop-macos/README.md) | macOS 메뉴바 앱 | Swift Package 구조, 빌드 스크립트, 키체인 및 개발 플래그 | 2026-09-11 |
| [`apps/web/docs/integration-notes.md`](../apps/web/docs/integration-notes.md) | 웹 연동 가이드 | Real/Mock 모드 연동 계약, E2E 검증 결과, 캡처 스크린샷 목록 | 2026-09-11 |
| [`apps/server/CLO-108-report.md`](../apps/server/CLO-108-report.md) | 위험 승인 서버 계약 | 강제 불가 항목 배열, `acknowledgedRisks` 요청/409 본문, Execution·Timeline 기록 필드 | 2026-09-11 |
| [`apps/desktop-agent/CLO-109-report.md`](../apps/desktop-agent/CLO-109-report.md) | Antigravity Adapter 보고서 | `agy 1.2.0` 실측, capability 선언 근거, 모의·실 CLI 검증 결과 | 2026-09-11 |
| [`apps/web/CLO-108-report.md`](../apps/web/CLO-108-report.md) | 위험 승인 웹 구현 보고서 | 승인 모달, Tier 뱃지, 타임라인 표시와 캡처 스크린샷 | 2026-09-11 |

---

## 3. 문서 간 우선순위 및 기준 관계 (Hierarchy & Precedence Table)

Baton 프로젝트는 점진적 검증(MVP 1차 → 2차 조직·팀 → 3차 하드닝 → 4차 추가 작업 요청)을 거치며 사양이 확장되었습니다. 문서 간 기술 내용이 상충할 경우 아래 우선순위 표에 따라 상위 문서를 기준(Source of Truth)으로 삼습니다.

| 기술 영역 / 주제 | 최우선 기준 문서 (Primary Truth) | 하위/초안 문서 | 우선 적용 내용 및 사유 |
|---|---|---|---|
| **조직·팀·통신 허용 규칙** | [`docs/design/05-organization-teams.md`](./design/05-organization-teams.md) | `01-domain-and-api.md` §2.1 | 01의 "동일 팀 멤버 간 협업" 제한을 해제하고, `Organization`, `TeamLink`(양방향), `senderTeamId`/`recipientTeamId` 모델 적용. |
| **요청 수신 및 Claim** | [`docs/design/05-organization-teams.md`](./design/05-organization-teams.md) | `01-domain-and-api.md` §2.3, §3.2 | `recipientUserId`가 `null`인 팀 전체 뿌리기 지원. 팀원 누구나 첫 수락/반려/거절 시 원자적 `claim` 수행 (`request.claimed`). |
| **디바이스 인증 (Pairing)** | [`docs/design/05-organization-teams.md`](./design/05-organization-teams.md) §3.4, [`04-shell-daemon-ipc.md`](./design/04-shell-daemon-ipc.md) §10.3 | `01-domain-and-api.md` §5.3, `02-desktop-agent-and-adapter.md` §0 | 전역 PAIRING_CODE를 제거하고, 웹 `/me/devices`에서 사용자별 1회용 8자리 코드(`POST /v1/devices/pair`) 발급 방식으로 확정. |
| **서버 ↔ Desktop 전송 계층** | [`docs/00-mvp-plan.md`](./00-mvp-plan.md) (D1), [`01-domain-and-api.md`](./design/01-domain-and-api.md) §5.3, [`apps/server/w5b-swagger.json`](../apps/server/w5b-swagger.json) | `02-desktop-agent-and-adapter.md` §0, §1 | 02 초안의 "WebSocket 단일 연결" 아이디어 대신, **SSE 하향 푸시(`GET /v1/desktop/events/stream`) + HTTPS REST 상향 보고**로 최종 구현. |
| **Desktop 셸 ↔ 데몬 구조** | [`docs/design/04-shell-daemon-ipc.md`](./design/04-shell-daemon-ipc.md) (v=1), [`00-mvp-plan.md`](./00-mvp-plan.md) (D5) | `02-desktop-agent-and-adapter.md` §8 | CLI 상주 데몬 대신 Swift 메뉴바 셸이 Node.js 데몬을 자식 프로세스로 spawn하고 stdin/stdout JSON Lines IPC로 통신. |
| **다중 프로젝트 & 실행 취소** | [`docs/design/04-shell-daemon-ipc.md`](./design/04-shell-daemon-ipc.md) §11, [`docs/mvp-acceptance.md`](./mvp-acceptance.md) §10 | `01-domain-and-api.md`, `02-desktop-agent-and-adapter.md` | `settings.projects` JSON 목록으로 복수 프로젝트 관리. 웹에서 `실행 취소` 시 `execution.command.cancel_requested`로 SIGTERM→SIGKILL. |
| **추가 작업 요청 (Follow-up)** | 기획서 [`docs/baton-service-plan.md`](./baton-service-plan.md) §18, [`docs/mvp-acceptance.md`](./mvp-acceptance.md) §11, `01` §3.2 | 초기 전이표 | `RESULT_REVIEW → READY_TO_RUN` 허용. `claude --resume <sessionId>`로 세션을 승계하며 최신 결과만 승인 가능. |
| **최신 REST API 엔드포인트** | [`apps/server/w5b-swagger.json`](../apps/server/w5b-swagger.json), [`apps/server/README.md`](../apps/server/README.md) | `01-domain-and-api.md` §5 | 실제 NestJS 서버 컨트롤러에서 데코레이터로 추출된 OpenAPI 3.0 명세가 실제 엔드포인트와 DTO의 물리적 기준. |
| **AI 에이전트 선택 · Provider별 능력** | [`docs/design/06-multi-agent-adapters.md`](./design/06-multi-agent-adapters.md) §0.1·§3.3·§4.4 | `02-desktop-agent-and-adapter.md`, 기획서 §29·§39 | 02는 Claude Code 단일 가정이고 기획서 §29는 구조 스케치다. **어떤 Provider가 무엇을 강제할 수 있고 없는지는 실제로 CLI를 돌려 확인한 06이 기준**이며, 각 Adapter의 `getCapabilities()` 선언값이 물리적 근거다. |
| **실행 정책 강제 및 위험 승인** | [`docs/design/06-multi-agent-adapters.md`](./design/06-multi-agent-adapters.md) §5.4, [`apps/server/CLO-108-report.md`](../apps/server/CLO-108-report.md) | 기획서 §27 | 기획서 §27의 "자격증명 비유출"은 Tier A(Claude Code)에서만 **보장**이고, Tier B·C에서는 **고지된 위험 인수**로 대체된다(2026-09-11 결정, 선택지 B). 강제 불가 항목 계산은 `packages/shared/src/execution-risk.ts` 한 곳이 유일한 구현이다. |
| **인수 검증 결과 및 버그 내역** | [`docs/mvp-acceptance.md`](./mvp-acceptance.md) | [`docs/test-plan.md`](./test-plan.md) | test-plan은 사전 테스트 계획이며, 실제 동작 결과·소요 비용·수정된 버그 40여 건의 내역은 mvp-acceptance.md가 기준. |
