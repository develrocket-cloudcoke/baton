# Baton 서버

환경 변수는 이 디렉터리의 `.env.example`을 참고한다. **WEB_URL은 브라우저로 접속하는 origin과 반드시 같게** 설정한다. 예를 들어 `http://127.0.0.1:3000`에서 로그인한다면 WEB_URL도 그 값이어야 한다. localhost와 127.0.0.1의 로그인 저장소는 공유되지 않는다. 알림 webUrl은 WEB_URL만 사용하며 WEB_ORIGIN은 CORS 설정용이다. WEB_URL 미설정 시 로컬 개발 기본값은 `http://localhost:3000`이다.

## 디바이스 계약

- `POST /v1/devices/pair`: code/deviceName과 선택적 platform/osVersion/appVersion/hostname, 응답 `{deviceId,deviceToken,userId}`. 재-pairing 시 `Authorization: Bearer <기존 디바이스 토큰>`을 보내면 같은 Device ID를 유지하고 토큰을 회전한다. 기존 토큰과 코드 소유자가 다르거나 코드가 무효하면 원자적으로 실패하여 기존 연결을 유지한다. 토큰을 제시하지 않는 호출은 새 디바이스 등록이다. 이름·hostname은 고유한 신원 증명이 아니므로 다른 디바이스 토큰을 임의로 폐기하는 데 사용하지 않는다.
- `POST /v1/desktop/heartbeat`: 디바이스 토큰 인증, body `{platform?,osVersion?,appVersion?,hostname?}`, 30초 간격 권장. Device와 agentId로 명시한 Agent의 lastSeenAt을 갱신하며 OFFLINE은 ONLINE으로 복구하고 BUSY/DISABLED는 유지한다.
- `/v1/agents`, `/v1/me/devices`: lastSeenAt과 상태 반환. 2분 무응답 Agent는 조회 시 DB에도 OFFLINE 저장한다. Device 상태는 lastSeenAt으로 계산한다.
- `GET /v1/desktop/events/stream`: 디바이스별 연결 하나, 새 연결에 `connection.ready {deviceId}`. 기존 연결은 `connection.replaced {reason}` 후 종료된다. 재-pairing/해제도 기존 연결을 종료한다. 교체된 데몬은 자동 재접속을 중단해야 두 데몬의 재접속 경쟁이 발생하지 않는다. 현재 단일 서버 프로세스 기준이며 수평 확장 시 공유 연결 소유권이 필요하다.
- `POST /v1/executions/:id/cancel`: 확정된 수신자만 QUEUED/RUNNING을 CANCELLED로 변경, Request는 READY_TO_RUN으로 복귀한다. 디바이스에 `execution.command.cancel_requested {eventName,executionId,requestId}` 발행, 재실행은 새 Execution을 만든다. 늦은 시작/결과 보고는 409이다. 서버 취소는 디바이스 프로세스 종료 확인을 기다리지 않으므로 데몬은 해당 이벤트로 실제 자식 프로세스를 중단해야 한다.

## Swagger 재생성

`w5b-swagger.json`은 생성 파일이다. API 데코레이터를 수정한 뒤 저장소 루트에서 아래 명령으로 다시 생성한다. tsx는 decorator metadata를 제공하지 않으므로 tsc 산출물을 사용한다.

```sh
pnpm --filter @baton/shared --filter @baton/server build
node apps/server/scripts/swagger.cjs
```

실행 중인 서버의 `/docs`와 `/docs-json`도 같은 데코레이터를 사용한다. 05 문서 §11의 request.delivered/request.claimed 공개 사용자·recipientUserId 계약, 문서·첨부 접근 범위, pairing과 실행 순서를 설명에 반영한다.

## CLO-12 재접속 replay

커서 유무와 관계없이 최근 24시간의 최대 500건만 조회하여 시간·ID 오름차순으로 재생한다. 하루 이상의 단절이나 대량 이벤트가 초기 연결을 무한히 지연시키지 않도록 잡은 MVP 상한이다. 상한 밖의 미실행 작업은 웹에서 확인하고 취소·재실행한다. 다른 디바이스의 last-event-id는 커서로 사용하지 않는다. `execution.command.*`는 연결된 Execution이 QUEUED/RUNNING일 때만 재생한다(Prisma의 성공 종료 상태는 SUCCEEDED이며 Request의 COMPLETED와 다름). 실시간 이벤트 발행은 이 replay 상한과 별개다.

## CLO-13 Agent 등록·정리

디바이스당 CLAUDE_CODE Agent 하나를 재사용한다. POST `/v1/desktop/agents`는 기존 활성 Agent ID를 반환하며, SQL Device 행 잠금으로 동시 등록을 직렬화한다. 기존 중복은 등록·heartbeat·GET `/v1/agents`에서 lazy 정리한다. 실행 중 Agent 우선, 없으면 최초 생성·ID 순으로 하나를 남기고 나머지는 DISABLED로 보존한다. Project/Execution FK 이력을 삭제하거나 다른 Agent로 옮기지 않는다. 이미 실행 중인 중복 Agent의 종료 보고는 받을 수 있으나 상태를 다시 ONLINE으로 올리지 않는다.

Heartbeat는 `{agentId?,platform?,osVersion?,appVersion?,hostname?}`를 받는다. agentId가 있으면 인증 디바이스의 보존된 활성 Agent만 갱신한다(그 외 403). 생략하면 Device만 갱신하므로 데몬은 자기 agentId를 보내야 Agent presence가 만료되지 않는다. 구버전 shared 계약은 유지하고 추가 AgentHeartbeatSchema를 서버에 적용했다.

소유자는 DELETE `/v1/agents/:agentId`로 비활성화한다(다른 소유자403, 진행 중 실행409). 비활성 Agent는 heartbeat/presence/새 실행으로 복구되지 않는다. 소유자가 등록을 다시 하면 새 Agent를 생성한다. 비활성 Agent의 Project는 `/v1/projects`에서 제외한다. 웹은 DISABLED 행을 정리 완료로 표시하거나 숨길 수 있다.

## CLO-11 취소된 실행의 부분 결과

`Result.kind`(`FINAL`|`PARTIAL`)로 승인 대상과 취소 회차 스냅샷을 구분한다.

- `POST /v1/desktop/executions/:id/result`는 `{status:'CANCELLED',summary?,changedFiles?,artifactIds?}`도 받는다. **이미 `CANCELLED`인 Execution에만** 허용하며(그 외 409 "취소 API 완료 후 부분 결과를 보고하세요"), `Result`를 `PARTIAL`로 upsert할 뿐 Execution·Request 상태는 바꾸지 않는다. 취소 뒤 늦게 도착한 보고, 재실행이 진행 중인 동안 도착한 중복 보고 모두 같은 Result를 갱신하고 상태는 그대로 둔다.
- `artifactIds`는 **그 요청에 본인이 올린 산출물**만 허용한다(그 외 403). 데몬은 계층1·2 patch와 계층3 `result.md`를 `/v1/uploads`로 올린 뒤 그 id를 싣는다.
- 부분 결과는 승인 대상이 아니다. `POST /v1/results/:id/approve-and-send`는 `kind=PARTIAL`이면 409이고, 요청 상세의 `latestResult`는 최신 실행의 결과가 `PARTIAL`이면 `null`을 반환한다(`results[]`에는 남는다).
- 타임라인에 `result.partial_reported`를 남긴다.

## e2e 실행 시 주의

`pnpm --filter @baton/server test:e2e`는 첫 단계에서 `prisma migrate reset`으로 **`DATABASE_URL`이 가리키는 DB의 모든 데이터를 지우고** migration·seed를 다시 적용한다. 로컬 개발 DB(docker compose의 `baton-mysql`, `127.0.0.1:3307`) 외에는 절대 실행하지 않는다.

Prisma 7부터 AI 에이전트가 실행한 `migrate reset`을 차단하므로, 그런 환경에서는 사용자의 명시적 동의 문장을 `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` 환경변수로 **그 명령에만 일회성으로** 붙인다. `.env`·`package.json`·스크립트에 심어 두지 않는다(다음 사람이 모르고 운영 DB에 쓰게 된다).
