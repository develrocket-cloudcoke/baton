import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionsService } from './executions/executions.service';

function fixture() {
  const events: any[] = [];
  const executions: any[] = [];
  const agent = { id: 'agent', deviceId: 'device', provider: 'CLAUDE_CODE', capabilities: null };
  const revision = {
    id: 'revision',
    documentVersionIds: [],
    artifactIds: [],
    originalInstruction: '분석',
  };
  const request = {
    id: 'request',
    state: 'ACCEPTED',
    recipientUserId: 'executor',
    senderUserId: 'sender',
    currentRevisionId: revision.id,
    revisions: [revision],
  };
  const tx: any = {
    $queryRaw: async () => [],
    user: { findUnique: async () => ({ displayName: 'sender' }) },
    request: { findUnique: async () => request, updateMany: async () => ({ count: 1 }), findMany: async () => [] },
    agent: { findFirst: async () => agent },
    project: { findFirst: async () => ({ id: 'project' }), updateMany: async () => ({ count: 1 }) },
    execution: {
      findFirst: async () => null,
      create: async ({ data }: any) => {
        const row = { id: 'execution', ...data };
        executions.push(row);
        return row;
      },
    },
    documentVersion: { findMany: async () => [] },
    artifact: { findMany: async () => [] },
    timelineEvent: {
      create: async ({ data }: any) => {
        events.push(data);
      },
      createMany: async ({ data }: any) => {
        events.push(...data);
      },
    },
    outboxEvent: { create: async ({ data }: any) => ({ id: 'outbox', ...data }) },
  };
  return {
    service: new ExecutionsService({ ...tx, $transaction: (fn: any) => fn(tx) } as any),
    events,
    executions,
  };
}
const body = {
  agentId: 'agent',
  projectId: 'project',
  additionalInstruction: '',
  policy: { git_write: 'push' },
};

test('push는 실행자의 정확한 위험 승인 없이는 실행·명령을 만들지 않는다', async () => {
  const f = fixture();
  await assert.rejects(
    f.service.create('sender', 'request', body),
    (e: any) => e.getStatus() === 403,
  );
  for (const acknowledgedRisks of [[], ['git_write'], ['git_remote_write', 'git_remote_write']]) {
    await assert.rejects(
      f.service.create('executor', 'request', { ...body, acknowledgedRisks }),
      (e: any) => {
        assert.equal(e.getStatus(), 409);
        assert.deepEqual(e.getResponse().requiredAcknowledgements, ['git_remote_write']);
        return true;
      },
    );
  }
  assert.equal(f.executions.length, 0);
  assert.equal(f.events.length, 0);
  const execution = await f.service.create('executor', 'request', {
    ...body,
    acknowledgedRisks: ['git_remote_write'],
  });
  assert.equal((execution.agentCapabilitiesSnapshot as any).policy.git_write, 'push');
  assert.equal(execution.riskAcknowledgedByUserId, 'executor');
  const command = f.events.find((e) => e.eventType === 'execution.command_requested').payload;
  assert.equal(command.policy.git_write, 'push');
  assert.deepEqual(command.acknowledgedRisks, ['git_remote_write']);
  assert.ok(f.events.some((e) => e.eventType === 'execution.risk_acknowledged'));
});

test('생략은 deny, local은 원격 승인 없이도 같은 정책을 데몬으로 전달한다', async () => {
  for (const policy of [{}, { git_write: 'local' }]) {
    const f = fixture();
    await f.service.create('executor', 'request', { ...body, policy });
    const command = f.events.find((e) => e.eventType === 'execution.command_requested').payload;
    assert.equal(command.policy.git_write, policy.git_write ?? 'deny');
    assert.deepEqual(command.acknowledgedRisks, []);
  }
});
