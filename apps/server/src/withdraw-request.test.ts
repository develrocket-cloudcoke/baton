import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestState, TransitionActor, canTransition, WithdrawRequestSchema } from '@baton/shared';
import { RequestsService } from './requests/requests.service';

test('철회는 수락 전 네 상태에서 요청자만 가능하고 종결이다', () => {
  for (const state of Object.values(RequestState)) for (const actor of Object.values(TransitionActor)) {
    assert.equal(canTransition(state, RequestState.WITHDRAWN, actor),
      ['SENT', 'DELIVERED', 'REVIEWING', 'RETURNED'].includes(state) && actor === TransitionActor.SENDER);
    assert.equal(canTransition(RequestState.WITHDRAWN, state, actor), false);
  }
  assert.equal(WithdrawRequestSchema.safeParse({ reason: '가'.repeat(501) }).success, false);
  assert.equal(WithdrawRequestSchema.safeParse({}).success, true);
});

function fixture(history = false, acceptedAt: Date | null = null, count = 1) {
  const events: any[] = [];
  const row = { id: 'r', senderUserId: 'sender', state: 'RETURNED', currentRevisionId: 'v',
    acceptedAt, recipientUserId: 'recipient', claimedAt: null, recipientTeamId: 'team', title: '요청' };
  const tx = {
    request: { updateMany: async () => ({ count }), findUniqueOrThrow: async () => ({ ...row, state: 'WITHDRAWN' }) },
    execution: { findFirst: async () => history ? { id: 'e' } : null },
    timelineEvent: { create: async ({ data }: any) => { events.push(data); } },
    team: { findUniqueOrThrow: async () => ({ id: 'team' }) },
    device: { findMany: async () => [] },
  };
  const service = new RequestsService({ $transaction: async (f: any) => f(tx) } as any);
  (service as any).owned = async () => row;
  return { service, events };
}

test('본인만 철회하고 실행 이력·수락 이력·경합은 거부한다', async () => {
  await assert.rejects(fixture().service.withdraw('admin', 'r'), (e: any) => e.getStatus() === 403);
  for (const f of [fixture(true), fixture(false, new Date()), fixture(false, null, 0)]) {
    await assert.rejects(f.service.withdraw('sender', 'r'), (e: any) => e.getStatus() === 409);
    assert.equal(f.events.length, 0);
  }
  const f = fixture();
  assert.equal((await f.service.withdraw('sender', 'r', '중복')).state, 'WITHDRAWN');
  assert.equal(f.events[0].eventType, 'request.withdrawn');
  assert.equal(f.events[0].payload.reason, '중복');
});
