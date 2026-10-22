import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { getDesktopInbox, desktopInboxWhere } from './inbox';
import { DesktopService } from './desktop.service';
import { requestInboxWhere, requestOutboxWhere } from '../requests/requests.service';

const me = 'me';
function row(id: string, state: string, extra: Record<string, unknown> = {}) {
  return {
    id, title: id, state, senderUserId: 'sender', recipientUserId: me, claimedAt: null,
    updatedAt: new Date('2026-09-30T00:00:00Z'),
    senderTeam: { name: '발신 팀' },
    recipientTeam: { name: '수신 팀', memberships: [{ userId: me }], org: { memberships: [{ userId: me }] } },
    executions: [{ executorUserId: me }], ...extra,
  };
}

// Prisma 없이 작성한 테스트에서도 실제 조회 조건의 AND/OR와 팀·조직 membership을 함께 적용한다.
function matches(value: any, condition: any): boolean {
  if (condition === undefined) return true;
  if (condition === null || typeof condition !== 'object') return value === condition;
  return Object.entries(condition).every(([key, expected]: [string, any]) => {
    if (key === 'AND') return expected.every((item: any) => matches(value, item));
    if (key === 'OR') return expected.some((item: any) => matches(value, item));
    if (key === 'not') return !matches(value, expected);
    if (key === 'in') return expected.includes(value);
    if (key === 'some') return Array.isArray(value) && value.some((item) => matches(item, expected));
    return matches(value?.[key], expected);
  });
}
function query(rows: ReturnType<typeof row>[]) {
  return getDesktopInbox({ request: { findMany: async ({ where, select }: any) => {
    assert.deepEqual(select.executions.orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
    assert.equal(select.executions.take, 1, '결과 검토·실패는 최신 실행자를 확인한다');
    return rows.filter((item) => matches(item, where));
  } } } as any, me);
}

test('내 차례는 웹 받은함·보낸함의 권한 조건을 그대로 사용한다', () => {
  const branches = desktopInboxWhere(me).OR as any[];
  assert.deepEqual(branches[0].AND[0], requestInboxWhere(me));
  assert.deepEqual(branches[1].AND[0], requestOutboxWhere(me));
});

test('상태별 내 차례 이유와 상대 팀을 반환하고 종결·실행 중 상태를 제외한다', async () => {
  const states = ['SENT', 'DELIVERED', 'REVIEWING', 'ACCEPTED', 'READY_TO_RUN', 'RESULT_REVIEW', 'FAILED'];
  const expected = ['확인 필요', '확인 필요', '확인 필요', '실행 준비', '실행 준비', '결과 검토', '실행 실패'];
  const response = await query([
    ...states.map((state) => row(state, state)),
    row('returned', 'RETURNED', { senderUserId: me, recipientUserId: 'other' }),
    ...['WITHDRAWN', 'REJECTED', 'COMPLETED', 'RUNNING', 'DRAFT', 'RETURNED'].map((state) => row(`exclude-${state}`, state)),
  ]);
  assert.equal(response.count, 8);
  for (const [index, state] of states.entries()) {
    const item = response.items.find((item) => item.id === state)!;
    assert.equal(item.reason, expected[index]);
    assert.equal(item.role, 'recipient');
    assert.equal(item.teamName, '발신 팀');
  }
  const sent = response.items.find((item) => item.id === 'returned')!;
  assert.equal(sent.reason, '보완 요청');
  assert.equal(sent.role, 'sender');
  assert.equal(sent.teamName, '수신 팀');
});

test('미배정 내 팀 요청은 포함하고 다른 팀·조직 밖·남이 맡은 요청·타인 실행 결과는 제외한다', async () => {
  const response = await query([
    row('broadcast', 'SENT', { recipientUserId: null }),
    row('other-team', 'SENT', { recipientUserId: null, recipientTeam: { name: '다른 팀', memberships: [], org: { memberships: [{ userId: me }] } } }),
    row('outside-org', 'SENT', { recipientUserId: null, recipientTeam: { name: '이전 팀', memberships: [{ userId: me }], org: { memberships: [] } } }),
    row('claimed', 'SENT', { recipientUserId: 'other', claimedAt: new Date() }),
    row('assigned-other', 'ACCEPTED', { recipientUserId: 'other' }),
    row('self-broadcast', 'SENT', { senderUserId: me, recipientUserId: null }),
    row('review-other', 'RESULT_REVIEW', { executions: [{ executorUserId: 'other' }] }),
    row('failed-other', 'FAILED', { executions: [{ executorUserId: 'other' }] }),
    row('no-execution', 'FAILED', { executions: [] }),
  ]);
  assert.deepEqual(response.items.map((item) => item.id), ['broadcast']);
});

test('전체 count와 최신 20개를 분리한다', async () => {
  const response = await query(Array.from({ length: 25 }, (_, index) => row(String(index), 'SENT', {
    updatedAt: new Date(Date.UTC(2026, 8, 30, 0, index)),
  })));
  assert.equal(response.count, 25);
  assert.equal(response.items.length, 20);
  assert.equal(response.items[0].id, '24');
  assert.equal(response.items[19].id, '5');
});

test('폐기된 기기는 기존 기기 인증에서 401, 요청 조회는 수행하지 않는다', async () => {
  const service = new DesktopService({
    device: { findFirst: async ({ where }: any) => {
      assert.equal(where.revokedAt, null);
      assert.equal(typeof where.tokenHash, 'string');
      return null;
    } },
    request: { findMany: async () => assert.fail('인증 전에 요청을 조회하면 안 된다') },
  } as any);
  await assert.rejects(service.inbox('Bearer revoked-token'), (error: any) => error.getStatus() === 401);
  await assert.rejects(service.inbox(), (error: any) => error.getStatus() === 401);
});
