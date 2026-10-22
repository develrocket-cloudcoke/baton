# 10. 결과 검토의 출구 — 반려·거절·결과 폐기

> **상태: 구현됨 (2026-09-22).** 설계 판단과 그 근거를 남긴다.

관련: [01 도메인·API](01-domain-and-api.md), [06 멀티 에이전트 어댑터](06-multi-agent-adapters.md)

## 1. 문제

`packages/shared/src/request-state.ts` 의 상태 기계에서 `RESULT_REVIEW` 가 갈 수 있는
곳은 둘뿐이다.

```
RESULT_REVIEW → READY_TO_RUN   (추가 작업)
RESULT_REVIEW → COMPLETED      (승인 및 전달)
```

반려(`RETURNED`)·거절(`REJECTED`)은 수락 전(`REVIEWING`)에만 있다. 그래서 일단
수락해서 실행하고 나면 **"전달하거나, 될 때까지 다시 돌리거나" 둘 중 하나로 갇힌다.**
2026-09-21 실사용 중에 실제로 막혔다.

## 2. 열기로 한 출구 셋

| 동작 | 전이 | 사유 | 이후 |
|---|---|---|---|
| 반려 | `RESULT_REVIEW → RETURNED` | 필수 | 요청자가 보완 재전송하면 `SENT` 로 살아난다(기존 경로) |
| 거절 | `RESULT_REVIEW → REJECTED` | 필수 | 종결 |
| 결과 폐기 | `RESULT_REVIEW → ACCEPTED` | 선택 | 요청은 살아 있고 실행 설정부터 다시 |

그리고 **반려할 때 에이전트 결과(result.md)를 요청자에게 보여 줄지 실행자가 고른다.**
반려 화면의 체크박스, 기본은 꺼짐.

## 3. 🔴 전제가 틀렸다 — 결과 경계는 열려 있었다 (이번에 닫았다)

이 작업의 전제였던 *"CLO-110 H-1 로 실행자 환경의 산출물이 승인 전까지 요청자에게
나가지 않는다"* 는 **성립하지 않고 있었다.** 2026-09-21 확인:

- `apps/server/src/requests/requests.service.ts` `detail()` — `results`·`result`·
  `latestResult` 가 redact 없이 나간다. `redactExecutionForSender()` 는 Execution 의
  필드만 지우고, 그 안에 실린 `execution.result` 는 `...rest` 로 그대로 통과한다.
  요청자는 `summary`·`changedFiles`·`testSummary`·`artifactIds` 를 승인 전에 본다
- `apps/server/src/storage/storage.service.ts` `artifact()` — 요청 접근 권한만 본다.
  요청자가 **result.md·changes.patch·stream.jsonl 을 승인 전에 그대로 내려받을 수 있다**

가리고 있는 것은 웹 UI 뿐이다 — `app/requests/[id]/page.tsx` 의 `RESULT_REVIEW` 분기가
요청자에게 "대기 중" 문구만 그린다. API 응답에는 내용이 들어 있다.

**그래서 이번 일은 경계를 여는 것이 아니라, 먼저 닫고 result.md 한 개짜리 구멍을 내는 것이었다.**
닫지 않으면 "체크했을 때만 공개한다"는 기능 자체가 무의미하므로 같은 변경에 포함했다.

## 4. 판단 ① 결과 공개 — 아티팩트 한 개 허용 목록

서버가 result.md **본문을 읽어 복사하지 않는다.** `Storage` 인터페이스에 읽기 연산이
없어 S3 구현까지 새로 만들어야 하고, 아티팩트는 sha256 주소지정이라 불변이므로
스냅샷을 따로 뜰 이유도 없다.

```prisma
model Result {
  disclosedArtifactId String?    // 요청자에게 연 result.md 아티팩트 정확히 하나
  disclosedAt         DateTime?
  disclosedByUserId   String?
}
```

- **닫기**: `redactResultForSender()` 를 `sender-projection.ts` 에 추가하고 `detail()` 의
  `results`·`result`·`latestResult`·`executions[].result` 에 적용한다. 요청자는
  `reviewStatus === 'APPROVED'` 일 때만 전문을 본다
- **구멍**: 반려 시 체크하면 그 회차의 `RESULT_ATTACHMENT`(result.md) 아티팩트 id
  **하나**를 기록하고, 요청자에게 그 한 건만 통과시킨다
- `storage.service.artifact()` 에 같은 규칙을 건다. `PATCH`·`TEST_OUTPUT` 은 승인
  전까지 요청자에게 끝까지 막힌다

`changedFiles`·실행 지시·capability 는 공개 대상이 아니다. 경로가 실행자 컴퓨터의
구조를 드러낸다.

## 5. 판단 ② 폐기된 Result 표시 — `DISCARDED` 하나만 추가

`ResultReviewStatus.CHANGES_REQUESTED` 는 `packages/shared/src/entities.ts` 에 선언만
돼 있고 **코드베이스 어디에서도 쓰이지 않는다**(전수 확인). 이번에 의미를 준다.

| 출구 | `reviewStatus` | 근거 |
|---|---|---|
| 승인 | `APPROVED` | 기존 |
| 반려 | `CHANGES_REQUESTED` | 글자 그대로 "요청자에게 보완을 요구" — 작업이 이어진다 |
| 거절 | `DISCARDED` | 채택되지 않고 종결 |
| 폐기 | `DISCARDED` | 채택되지 않고 버린다 |

거절과 폐기는 `reviewStatus` 가 같고 **요청 상태와 타임라인 이벤트로 구분한다**
(`request.rejected` vs `result.discarded`). Result 행은 "이 결과가 채택됐는가" 하나만
답하게 두는 편이 읽기 쉽다.

추가 작업(follow-up)이 이전 결과를 `PENDING` 으로 남기는 것도 같은 종류의 빈칸이지만
**이번 범위에서 건드리지 않는다** — 세 출구 밖이고, 지금 실사용 중인 흐름이라
위험 대비 이득이 없다. 별건으로 남긴다.

## 6. 판단 ③ "파일 변경은 남는다" 를 알리는 법

폐기해도 **실행자 컴퓨터의 파일 변경은 그대로 남는다.** 되돌릴 수 없으므로 정확히
무엇이 남는지 말한다.

- 폐기 확인 대화상자: 변경 파일 개수와 목록 + "Baton 은 이 변경을 되돌리지 않습니다.
  필요하면 실행자가 직접 정리하세요(`git checkout` / `git stash`)"
- 폐기 후 `ACCEPTED` 화면에 상주 배너: "이전 회차에서 N개 파일이 변경된 채 남아
  있습니다" + 폐기된 회차로 가는 링크
- `result.discarded` 타임라인 payload 에 `changedFiles` 를 실어 감사 기록에 남긴다

## 7. 구현 계획

### 상태 기계 (`packages/shared/src/request-state.ts` 하나가 진실)

```ts
[RequestState.RESULT_REVIEW]: [
  { to: RequestState.READY_TO_RUN, actors: [TransitionActor.RECIPIENT] }, // 기존
  { to: RequestState.COMPLETED,    actors: [TransitionActor.RECIPIENT] }, // 기존
  { to: RequestState.RETURNED,     actors: [TransitionActor.RECIPIENT] }, // 추가
  { to: RequestState.REJECTED,     actors: [TransitionActor.RECIPIENT] }, // 추가
  { to: RequestState.ACCEPTED,     actors: [TransitionActor.RECIPIENT] }, // 추가
]
```

`requests.service.ts` 의 `transition()` 이 이미 `RETURNED`/`REJECTED` 의 사유 필수 검사와
`returnReason` 저장, 타임라인 기록을 처리한다. 따라서 **반려·거절은 기존
`POST /v1/requests/:id/return`·`/reject` 가 그대로 동작한다.** `claiming` 분기는
`RESULT_REVIEW` 시점에 `recipientUserId` 가 이미 확정이라 타지 않는다.

폐기는 전용 엔드포인트 `POST /v1/requests/:id/discard-result` 를 새로 만든다.
`/accept` 로 겸하면 타임라인이 `request.accepted` 로 찍혀 감사 기록이 거짓말을 한다.

### 타임라인 이벤트 (전이마다 남긴다)

- `RESULT_DISCARDED = 'result.discarded'` 추가
- `RESULT_DISCLOSED_TO_SENDER = 'result.disclosed_to_sender'` 추가 (`audience: 'both'`
  — 요청자도 봐야 한다)
- 반려·거절은 기존 `request.returned`·`request.rejected` 를 쓰되 payload 에
  `fromResultReview: true` 와 `resultId` 를 실어 "수락 전 반려" 와 구분한다

### 마이그레이션은 작성만 하고 적용하지 않는다

`prisma migrate dev` 는 사용자가 실사용 중인 dev DB 를 건드리고 drift 감지 시 reset 을
제안한다. **SQL 을 손으로 써서 `apps/server/prisma/migrations/` 에 넣고 `prisma generate`
만 돌린다.** 적용은 검토 후 직접 한다. 변경은 전부 가산적이다 — 컬럼 3개 추가,
`ResultReviewStatus` 에 값 1개 추가.

### 웹

- 결과 검토 화면(`components/result-review-view.tsx`)에 버튼 3개와 각 대화상자
- 반려 대화상자에 **기본 꺼짐** 결과 공개 체크박스
- 요청자의 `RETURNED` 화면(`app/requests/[id]/page.tsx`)에 공개된 result.md 표시

### 테스트

전이표 / `redactResultForSender` 경계 / 아티팩트 허용 목록 / 세 엔드포인트의 사유
필수·권한·동시성 / 공개 체크박스 on·off. 각 테스트를 **일부러 깨뜨려** 실제로 잡는지
확인한다. `pnpm test:e2e` 는 실행하지 않는다(`prisma migrate reset --force` 포함).

## 8. 남은 것

- **마이그레이션이 아직 적용되지 않았다.** `apps/server/prisma/migrations/
  20260922010000_result_review_exits/` 를 써 두기만 했다. 실사용 중인 dev DB 를
  건드리지 않으려고 `prisma generate` 만 돌렸다. 검토 후 적용해야 동작한다
- 추가 작업(follow-up)은 이전 결과를 `PENDING` 으로 남긴다. `CHANGES_REQUESTED` 가
  맞는 자리지만 세 출구 밖이고 실사용 중인 흐름이라 이번에 건드리지 않았다
- 실서버 왕복 확인은 하지 않았다(dev 서버·DB 를 건드리지 않는 조건). 테스트는
  전부 가짜 DB 위의 단위 테스트다
