import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { CreateDelegationSchema, TimelineEventType } from '@baton/shared';
import { RequestsService, projectDelegatedChildren, recordChildCompleted } from './requests/requests.service';

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`;
function fixture({ member = true, state = 'RUNNING', parent = null as any, docs = [uid('1')], artifacts = [uid('2')] } = {}) {
  const row = { id: uid('10'), senderUserId: uid('11'), recipientTeamId: uid('12'), recipientTeam: { name: 'B' },
    parentRequestId: null as string | null, currentRevisionId: uid('13'), currentRevisionNo: 1, state, title: '부모', revisions: [{
      id: uid('13'), documentVersionIds: docs, artifactIds: artifacts, originalInstruction: '원본',
    }] };
  const prisma: any = {
    request: { findUnique: async ({ where }: any) => where.id === row.id ? row : parent },
    teamMembership: { findUnique: async () => member ? {} : null },
    result: { findMany: async () => [] },
  };
  return { service: new RequestsService(prisma), row };
}
const body = (overrides: any = {}) => ({ recipientTeamId: uid('20'), title: '자식', instruction: '도와주세요', documentVersionIds: [], artifactIds: [], resultIds: [], ...overrides });

test('CreateDelegationSchema validates delegation body', () => {
  assert.equal(CreateDelegationSchema.safeParse(body()).success, true);
  assert.equal(CreateDelegationSchema.safeParse(body({ recipientTeamId: 'bad' })).success, false);
});

test('재위임은 비구성원을 403으로 막는다', async () => {
  const { service, row } = fixture({ member: false });
  await assert.rejects(service.delegate(uid('30'), row.id, body()), (e: any) => e.getStatus() === 403);
});

test('진행 가능 상태가 아니면 409', async () => {
  const { service, row } = fixture({ state: 'COMPLETED' });
  await assert.rejects(service.delegate(uid('30'), row.id, body()), (e: any) => e.getStatus() === 409);
});

test('조상 팀으로의 순환 재위임은 400', async () => {
  const parent = { id: uid('9'), recipientTeamId: uid('20'), parentRequestId: null };
  const { service, row } = fixture({ parent });
  row.parentRequestId = parent.id;
  await assert.rejects(service.delegate(uid('30'), row.id, body()), (e: any) => e.getStatus() === 400);
});

test('부모 현재 revision 바깥의 첨부는 400', async () => {
  const { service, row } = fixture();
  await assert.rejects(service.delegate(uid('30'), row.id, body({ documentVersionIds: [uid('99')] })), (e: any) => e.getStatus() === 400);
});

test('완료 연결은 부모 타임라인에 child_completed를 기록한다', async () => {
  let event: any;
  await recordChildCompleted({ timelineEvent: { create: async ({ data }: any) => { event = data; } } } as any, uid('40'), uid('41'), uid('42'));
  assert.equal(event.eventType, TimelineEventType.REQUEST_CHILD_COMPLETED);
  assert.deepEqual(event.payload, { childRequestId: uid('41'), resultId: uid('42') });
});

test('원 요청 발신자에게 하위 요청의 팀과 상태만 보인다', () => {
  const projected = projectDelegatedChildren([{ id: uid('50'), title: '비공개 제목', state: 'RUNNING', recipientTeam: { id: uid('20'), name: 'C' },
    executions: [{ result: { reviewStatus: 'APPROVED', summary: '비공개 결과' } }] }], true);
  assert.deepEqual(projected, [{ recipientTeam: { id: uid('20'), name: 'C' }, state: 'RUNNING' }]);
});

test('원 요청 발신자에게 재위임 타임라인의 하위 요청 id 는 가린다', async () => {
  const { redactTimelineEventForSender } = await import('./requests/sender-projection');
  const out: any = redactTimelineEventForSender({ eventType: 'request.delegated', payload: { childRequestId: uid('41'), recipientTeamId: uid('20') } } as any);
  assert.deepEqual(out.payload, { recipientTeamId: uid('20') });
});
