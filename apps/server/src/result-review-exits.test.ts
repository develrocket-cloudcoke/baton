import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestState, TimelineEventType, TransitionActor, canTransition } from '@baton/shared';
import { DiscardResultSchema, ReturnRequestSchema } from '@baton/shared';
import { RequestsService } from './requests/requests.service';
import { StorageService } from './storage/storage.service';
import { redactResultForSender } from './requests/sender-projection';

// CLO-141: 결과 검토(RESULT_REVIEW)가 막다른 길이었다. 전달하거나 될 때까지 다시 돌리는
// 두 길밖에 없어서, 일단 수락해 실행하고 나면 되돌려 보낼 방법이 없었다(2026-09-21 실사용).

const conflict = (e: any) => e.getStatus?.() === 409;
const forbidden = (e: any) => e.getStatus?.() === 403;

test('결과 검토에서 반려·거절·폐기로 나갈 수 있고, 나갈 수 있는 사람은 수신자뿐이다', () => {
  for (const to of [
    RequestState.RETURNED,
    RequestState.REJECTED,
    RequestState.ACCEPTED,
    // 기존 두 출구도 그대로 살아 있어야 한다.
    RequestState.READY_TO_RUN,
    RequestState.COMPLETED,
  ]) {
    assert.equal(
      canTransition(RequestState.RESULT_REVIEW, to, TransitionActor.RECIPIENT),
      true,
      `RESULT_REVIEW -> ${to}`,
    );
    for (const actor of [
      TransitionActor.SENDER,
      TransitionActor.DESKTOP_AGENT,
      TransitionActor.SERVER,
    ])
      assert.equal(
        canTransition(RequestState.RESULT_REVIEW, to, actor),
        false,
        `RESULT_REVIEW -> ${to} (${actor})`,
      );
  }
  // 종결 상태는 여전히 종결이다. 반려로 살아나는 경로는 RETURNED → SENT 하나뿐이다.
  assert.equal(
    canTransition(RequestState.REJECTED, RequestState.SENT, TransitionActor.SENDER),
    false,
  );
  assert.equal(
    canTransition(RequestState.RETURNED, RequestState.SENT, TransitionActor.SENDER),
    true,
  );
  assert.equal(
    canTransition(RequestState.COMPLETED, RequestState.RETURNED, TransitionActor.RECIPIENT),
    false,
  );
});

test('결과 공개는 기본이 꺼짐이고, 폐기 사유는 선택이다', () => {
  // 체크하지 않은 반려가 결과를 열면 안 된다. 기본값이 곧 안전한 쪽이어야 한다.
  assert.equal(ReturnRequestSchema.parse({ reason: '범위가 다릅니다' }).discloseResult, false);
  assert.equal(
    ReturnRequestSchema.parse({ reason: '범위가 다릅니다', discloseResult: true }).discloseResult,
    true,
  );
  assert.equal(ReturnRequestSchema.safeParse({ reason: '' }).success, false);
  assert.deepEqual(DiscardResultSchema.parse(undefined), {});
  assert.equal(DiscardResultSchema.parse({ reason: '방향이 틀렸다' }).reason, '방향이 틀렸다');
});

const resultRow = (over: Record<string, unknown> = {}) => ({
  id: 'result-1',
  executionId: 'execution-1',
  kind: 'FINAL',
  summary: 'REDIS_HOST 오타를 고쳤습니다',
  changedFiles: ['k8s/deployment.yaml'],
  testSummary: 'verify.sh 3 passed',
  resultDocumentVersionId: 'docver-1',
  artifactIds: ['artifact-md', 'artifact-patch', 'artifact-stream'],
  reviewStatus: 'PENDING',
  disclosedArtifactId: null,
  ...over,
});

test('발신자에게는 승인 전 결과가 가려지고, 공개된 result.md 한 건만 남는다', () => {
  const hidden: any = redactResultForSender(resultRow());
  // 이건 새 제약이 아니라 지금까지 빠져 있던 것이다 — 웹 UI 만 가리고 API 는 전문을 내보냈다.
  assert.equal(hidden.summary, '');
  assert.deepEqual(hidden.changedFiles, []);
  assert.equal(hidden.testSummary, null);
  assert.equal(hidden.resultDocumentVersionId, null);
  assert.deepEqual(hidden.artifactIds, []);
  assert.equal(hidden.resultRedacted, true);
  // 결과가 있다는 사실과 검토 상태는 남는다. 요청자 화면이 "검토 중"을 그려야 한다.
  assert.equal(hidden.id, 'result-1');
  assert.equal(hidden.reviewStatus, 'PENDING');

  // 반려하며 연 경우: result.md 한 건만. patch·stream 은 따라오지 않는다.
  const disclosed: any = redactResultForSender(
    resultRow({ reviewStatus: 'CHANGES_REQUESTED', disclosedArtifactId: 'artifact-md' }),
  );
  assert.deepEqual(disclosed.artifactIds, ['artifact-md']);
  assert.equal(disclosed.summary, '');
  assert.deepEqual(disclosed.changedFiles, []);

  // 승인해 전달한 결과는 요청자의 것이다. 그대로 나간다.
  const approved: any = redactResultForSender(resultRow({ reviewStatus: 'APPROVED' }));
  assert.equal(approved.summary, 'REDIS_HOST 오타를 고쳤습니다');
  assert.deepEqual(approved.artifactIds, ['artifact-md', 'artifact-patch', 'artifact-stream']);
  assert.equal(approved.resultRedacted, undefined);
});

/** 요청 하나와 결과 하나를 가진 최소 DB. 실제 DB 를 건드리지 않는다. */
function fixture(over: Record<string, unknown> = {}) {
  const request: any = {
    id: 'request-1',
    senderUserId: 'sender',
    recipientUserId: 'recipient',
    recipientTeamId: 'team-recipient',
    senderTeamId: 'team-sender',
    currentRevisionId: 'revision-1',
    claimedAt: new Date(0),
    state: 'RESULT_REVIEW',
    revisions: [{ id: 'revision-1' }],
    ...over,
  };
  const result: any = resultRow();
  const execution: any = { id: 'execution-1', requestId: 'request-1', result };
  const artifacts: any[] = [
    {
      id: 'artifact-md',
      kind: 'RESULT_ATTACHMENT',
      createdAt: new Date(1),
      requestId: 'request-1',
      teamId: 'team-sender',
      storageRef: 'k/md',
    },
    {
      id: 'artifact-patch',
      kind: 'PATCH',
      createdAt: new Date(2),
      requestId: 'request-1',
      teamId: 'team-sender',
      storageRef: 'k/patch',
    },
  ];
  const events: any[] = [];
  const tx: any = {
    request: {
      findUnique: async () => request,
      findUniqueOrThrow: async () => request,
      updateMany: async ({ where, data }: any) => {
        if (where.state && where.state !== request.state) return { count: 0 };
        if (where.recipientUserId && where.recipientUserId !== request.recipientUserId)
          return { count: 0 };
        Object.assign(request, data);
        return { count: 1 };
      },
      update: async ({ data }: any) => Object.assign(request, data),
    },
    execution: { findFirst: async () => execution },
    artifact: {
      findFirst: async ({ where }: any) =>
        artifacts.find((a) => where.id.in.includes(a.id) && a.kind === where.kind) ?? null,
      findUnique: async ({ where }: any) => {
        const found = artifacts.find((a) => a.id === where.id);
        return found ? { ...found, request } : null;
      },
    },
    result: {
      update: async ({ data }: any) => Object.assign(result, data),
      findMany: async () => [result],
    },
    timelineEvent: {
      create: async ({ data }: any) => {
        events.push(data);
        return data;
      },
    },
    teamMembership: { findUnique: async () => null, findFirst: async () => null },
    orgMembership: { findFirst: async () => null },
    team: { findUniqueOrThrow: async () => ({ id: 'team-recipient', orgId: 'org' }) },
  };
  const db: any = { ...tx, $transaction: (fn: any) => fn(tx) };
  return { db, request, result, events, artifacts, service: new RequestsService(db) };
}

test('결과 폐기는 요청을 살린 채 ACCEPTED 로 되돌리고 남은 파일 변경을 기록한다', async () => {
  const f = fixture();
  const changed = await f.service.discardResult('recipient', 'request-1', '방향이 틀렸다');
  assert.equal(changed.state, 'ACCEPTED');
  assert.ok(f.request.acceptedAt, '다시 실행 설정부터 하므로 수락 시각을 새로 찍는다');
  // 결과는 채택되지 않았다. 승인 대상에서 빠진다.
  assert.equal(f.result.reviewStatus, 'DISCARDED');
  assert.equal(f.result.reviewedByUserId, 'recipient');
  // 폐기해도 실행자 컴퓨터의 변경은 남는다. 무엇이 남았는지가 이 기록의 핵심이다.
  const discarded = f.events.find((e) => e.eventType === TimelineEventType.RESULT_DISCARDED);
  assert.ok(discarded, 'result.discarded 이벤트를 남겨야 한다');
  assert.deepEqual(discarded.payload.changedFiles, ['k8s/deployment.yaml']);
  assert.equal(discarded.payload.reason, '방향이 틀렸다');
  assert.equal(discarded.payload.resultId, 'result-1');
  // 폐기는 공개가 아니다.
  assert.ok(!f.result.disclosedArtifactId);
});

test('폐기는 수신자만, 결과 검토 상태에서만 할 수 있다', async () => {
  await assert.rejects(fixture().service.discardResult('sender', 'request-1'), forbidden);
  await assert.rejects(
    fixture({ state: 'RUNNING' }).service.discardResult('recipient', 'request-1'),
    conflict,
  );
  await assert.rejects(
    fixture({ state: 'COMPLETED' }).service.discardResult('recipient', 'request-1'),
    conflict,
  );
});

test('결과 검토 반려는 체크했을 때만 result.md 한 건을 열고, 체크 안 하면 아무것도 열지 않는다', async () => {
  const off = fixture();
  await off.service.transition(
    'recipient',
    'request-1',
    RequestState.RETURNED,
    TimelineEventType.REQUEST_RETURNED,
    '범위가 다릅니다',
    'same',
    false,
  );
  assert.equal(off.request.state, 'RETURNED');
  assert.equal(off.request.returnReason, '범위가 다릅니다');
  // 반려는 "요청자에게 보완을 요구했다" 다. 선언만 돼 있던 값에 여기서 의미가 생긴다.
  assert.equal(off.result.reviewStatus, 'CHANGES_REQUESTED');
  assert.ok(!off.result.disclosedArtifactId);
  assert.equal(
    off.events.some((e) => e.eventType === TimelineEventType.RESULT_DISCLOSED_TO_SENDER),
    false,
  );

  const on = fixture();
  await on.service.transition(
    'recipient',
    'request-1',
    RequestState.RETURNED,
    TimelineEventType.REQUEST_RETURNED,
    '결과를 보고 판단하세요',
    'same',
    true,
  );
  // 연 것은 RESULT_ATTACHMENT(result.md) 하나뿐이다. patch 는 열지 않는다.
  assert.equal(on.result.disclosedArtifactId, 'artifact-md');
  assert.ok(on.result.disclosedAt);
  assert.equal(on.result.disclosedByUserId, 'recipient');
  const disclosure = on.events.find(
    (e) => e.eventType === TimelineEventType.RESULT_DISCLOSED_TO_SENDER,
  );
  assert.equal(disclosure.payload.artifactId, 'artifact-md');
  // 수락 전 반려와 구분할 수 있어야 한다.
  const returned = on.events.find((e) => e.eventType === TimelineEventType.REQUEST_RETURNED);
  assert.equal(returned.payload.fromResultReview, true);
  assert.equal(returned.payload.resultId, 'result-1');
});

test('결과 검토 거절은 결과를 버린 것으로 닫고 공개하지 않는다', async () => {
  const f = fixture();
  await f.service.transition(
    'recipient',
    'request-1',
    RequestState.REJECTED,
    TimelineEventType.REQUEST_REJECTED,
    '우리 팀 일이 아닙니다',
    'same',
    // 거절에는 공개 선택지가 없다. true 가 와도 열리면 안 된다.
    true,
  );
  assert.equal(f.request.state, 'REJECTED');
  assert.equal(f.result.reviewStatus, 'DISCARDED');
  assert.ok(!f.result.disclosedArtifactId);
});

test('수락 전 반려는 결과를 건드리지 않는다', async () => {
  const f = fixture({ state: 'REVIEWING' });
  await f.service.transition(
    'recipient',
    'request-1',
    RequestState.RETURNED,
    TimelineEventType.REQUEST_RETURNED,
    '내용이 부족합니다',
    'same',
    true,
  );
  assert.equal(f.result.reviewStatus, 'PENDING');
  const returned = f.events.find((e) => e.eventType === TimelineEventType.REQUEST_RETURNED);
  assert.equal(returned.payload.fromResultReview, undefined);
});

/** 아티팩트 접근만 확인하는 최소 DB. 요청자(sender)와 수신자를 구분한다. */
function storageFixture(result: Record<string, unknown>) {
  const request: any = {
    id: 'request-1',
    senderUserId: 'sender',
    recipientUserId: 'recipient',
    recipientTeamId: 'team-recipient',
    senderTeamId: 'team-sender',
    claimedAt: new Date(0),
    state: 'RESULT_REVIEW',
  };
  const artifacts: Record<string, any> = {
    'artifact-md': {
      id: 'artifact-md',
      kind: 'RESULT_ATTACHMENT',
      teamId: 'team-sender',
      storageRef: 'k/md',
      request,
    },
    'artifact-patch': {
      id: 'artifact-patch',
      kind: 'PATCH',
      teamId: 'team-sender',
      storageRef: 'k/patch',
      request,
    },
    'artifact-input': {
      id: 'artifact-input',
      kind: 'REQUEST_ATTACHMENT',
      teamId: 'team-sender',
      storageRef: 'k/in',
      request,
    },
  };
  const db: any = {
    artifact: { findUnique: async ({ where }: any) => artifacts[where.id] ?? null },
    // 발신 팀 멤버십은 있다고 둔다 — "팀 멤버라서 통과"로 우회되지 않는지 보려는 것이다.
    teamMembership: {
      findUnique: async () => ({ teamId: 'team-sender', userId: 'sender' }),
      findFirst: async () => null,
    },
    orgMembership: { findFirst: async () => null },
    team: {
      findUniqueOrThrow: async () => ({ id: 'team-recipient', orgId: 'org' }),
      findMany: async () => [{ orgId: 'org' }],
    },
    result: { findMany: async () => [result] },
  };
  const store = { issueGet: async () => 'https://download.example/x' } as any;
  return new StorageService(db, store, store);
}

test('요청자는 승인 전 결과 산출물을 내려받을 수 없다 — 연 result.md 한 건만 예외다', async () => {
  const pending = storageFixture({
    reviewStatus: 'PENDING',
    artifactIds: ['artifact-md', 'artifact-patch'],
    disclosedArtifactId: null,
  });
  // 지금까지는 요청 접근 권한만 봐서 이 셋이 전부 통과했다(2026-09-21 확인).
  await assert.rejects(pending.artifact('sender', 'artifact-md'), forbidden);
  await assert.rejects(pending.artifact('sender', 'artifact-patch'), forbidden);
  // 요청 첨부는 원래 요청자가 올린 것이다. 막으면 안 된다.
  assert.ok((await pending.artifact('sender', 'artifact-input')).downloadUrl);
  // 수신자는 자기 실행 결과를 본다.
  assert.ok((await pending.artifact('recipient', 'artifact-patch')).downloadUrl);

  const disclosed = storageFixture({
    reviewStatus: 'CHANGES_REQUESTED',
    artifactIds: ['artifact-md', 'artifact-patch'],
    disclosedArtifactId: 'artifact-md',
  });
  assert.ok((await disclosed.artifact('sender', 'artifact-md')).downloadUrl);
  // 열어 준 것은 result.md 하나다. patch 는 그대로 막힌다.
  await assert.rejects(disclosed.artifact('sender', 'artifact-patch'), forbidden);

  const approved = storageFixture({
    reviewStatus: 'APPROVED',
    artifactIds: ['artifact-md', 'artifact-patch'],
    disclosedArtifactId: null,
  });
  assert.ok((await approved.artifact('sender', 'artifact-md')).downloadUrl);
  assert.ok((await approved.artifact('sender', 'artifact-patch')).downloadUrl);
});
