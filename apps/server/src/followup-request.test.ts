import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestState, TransitionActor, canTransition } from '@baton/shared';
import { RequestsService } from './requests/requests.service';

for (const state of [RequestState.COMPLETED, RequestState.FAILED]) {
  test(`${state} → SENT는 요청자만 가능하다`, () => {
    for (const actor of Object.values(TransitionActor)) {
      assert.equal(canTransition(state, RequestState.SENT, actor), actor === TransitionActor.SENDER);
    }
  });
}

function fixture(state = 'COMPLETED', active = false, claimed = false) {
  const row = { id: 'r', senderUserId: 'sender', senderTeamId: 'a', recipientTeamId: 'b',
    recipientUserId: 'recipient', claimedAt: claimed ? new Date() : null,
    state, currentRevisionId: 'v1', currentRevisionNo: 1, title: '요청' };
  const events: any[] = [];
  const updates: any[] = [];
  const revisions: any[] = [];
  const tx = {
    request: { updateMany: async () => ({ count: 1 }), update: async (v: any) => { updates.push(v.data); } },
    execution: { findFirst: async () => active ? { id: 'running' } : null },
    requestRevision: { create: async ({ data }: any) => { revisions.push(data); return { id: 'v2', ...data }; } },
    timelineEvent: { create: async ({ data }: any) => { events.push(data); } },
    team: { findUniqueOrThrow: async () => ({ id: 'b', orgId: 'o', name: '팀' }) },
    teamMembership: { findMany: async () => [] },
    device: { findMany: async () => [] }, user: { findUnique: async () => null },
  };
  const service = new RequestsService({ $transaction: async (fn: any) => fn(tx) } as any);
  (service as any).owned = async () => row;
  (service as any).validateRoute = async () => undefined;
  return { service, events, updates, revisions };
}

test('새 revision 생성과 SENT 전환·감사 기록, 팀 요청의 claim 해제', async () => {
  const f = fixture('COMPLETED', false, true);
  const revision = await f.service.revision('sender', 'r', { originalInstruction: '추가 지시' });
  assert.equal(revision.revisionNo, 2);
  assert.equal(f.revisions[0].originalInstruction, '추가 지시');
  assert.equal(f.updates[0].recipientUserId, null);
  assert.equal(f.updates[0].acceptedAt, null);
  assert.equal(f.events[0].eventType, 'request.followup_sent');
});

test('개인 지정은 유지하고 타인과 진행 중 실행은 거부한다', async () => {
  const personal = fixture('FAILED');
  await personal.service.revision('sender', 'r', { originalInstruction: '다시 요청' });
  assert.equal(personal.updates[0].recipientUserId, 'recipient');
  const other = fixture();
  await assert.rejects(other.service.revision('teammate', 'r', { originalInstruction: '대리 요청' }), (e: any) => e.getStatus() === 403);
  const active = fixture('FAILED', true);
  await assert.rejects(active.service.revision('sender', 'r', { originalInstruction: '경합' }), (e: any) => e.getStatus() === 409);
  assert.equal(active.revisions.length, 0);
});
