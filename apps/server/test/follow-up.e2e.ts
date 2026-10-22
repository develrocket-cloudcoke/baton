import { clampAgentCapabilities, effectiveAgentCapabilities } from '@baton/shared';
import assert from 'node:assert/strict';
import test from 'node:test';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
let app: any, db: PrismaService;
let a: string, b: string, bId: string, token: string, agentId: string, projectId: string;
const post = (path: string, auth: string, body: any = {}) =>
  request(app.getHttpServer())
    .post(`/v1/${path}`)
    .set('Authorization', `Bearer ${auth}`)
    .send(body);
const get = (path: string) =>
  request(app.getHttpServer()).get(`/v1/${path}`).set('Authorization', `Bearer ${b}`);
const input = () => ({
  agentId,
  projectId,
  followUpInstruction: '테스트 케이스를 하나 더 추가해줘.',
});
// CLO-110(H-2-1): CODEX 는 서버 상한 때문에 credentialPathDeny/destructiveCommandDeny 를 올릴 수 없다.
// 그래서 CODEX 로 실행하려면 기본 정책에서 항상 이 두 항목을 승인해야 한다.
const codexRisks = ['credential_path_read', 'deployment_apply'];
async function initial(
  sessionId?: string,
  selected = { agentId, projectId },
  acknowledgedRisks: string[] = [],
) {
  const backend = await db.team.findFirstOrThrow({ where: { name: 'backend' } });
  const infra = await db.team.findFirstOrThrow({ where: { name: 'infra', orgId: backend.orgId } });
  const draft = (
    await post('requests', a, {
      senderTeamId: backend.id,
      recipientTeamId: infra.id,
      recipientUserId: bId,
      title: '추가 작업',
      originalInstruction: '최초 작업',
    }).expect(201)
  ).body;
  await post(`requests/${draft.id}/send`, a).expect(201);
  await post(`requests/${draft.id}/review/start`, b).expect(201);
  await post(`requests/${draft.id}/accept`, b).expect(201);
  const ex = (
    await post(`requests/${draft.id}/executions`, b, {
      ...selected,
      additionalInstruction: '첫 실행 지시',
      acknowledgedRisks,
    }).expect(201)
  ).body;
  await post(`desktop/executions/${ex.id}/status`, token, { status: 'RUNNING', sessionId }).expect(
    201,
  );
  const result = (
    await post(`desktop/executions/${ex.id}/result`, token, {
      status: 'SUCCEEDED',
      summary: '첫 결과',
    }).expect(201)
  ).body;
  return { id: draft.id, ex, result };
}
test.before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  db = app.get(PrismaService);
  a = (
    await post('auth/login', '', { email: 'a@baton.local', password: 'baton-dev-password' }).expect(
      201,
    )
  ).body.token;
  b = (
    await post('auth/login', '', { email: 'b@baton.local', password: 'baton-dev-password' }).expect(
      201,
    )
  ).body.token;
  bId = (await db.user.findUniqueOrThrow({ where: { email: 'b@baton.local' } })).id;
  const code = (await post('me/pairing-codes', b).expect(201)).body.code;
  token = (
    await request(app.getHttpServer())
      .post('/v1/devices/pair')
      .send({ code, deviceName: 'CLO-8a' })
      .expect(201)
  ).body.deviceToken;
  agentId = (await post('desktop/agents', token).expect(201)).body.agentId;
  projectId = (await post('desktop/projects', token, { agentId }).expect(201)).body.projectId;
});
test.after(async () => app.close());

test('결과 검토 → 세션 재개 추가 작업 → 두 번째 결과 → 최신 결과 승인과 권한 검증', async () => {
  const { id, ex, result } = await initial('claude-session-first');
  assert.equal(
    (await db.execution.findUniqueOrThrow({ where: { id: ex.id } })).claudeSessionId,
    'claude-session-first',
  );
  await post(`requests/${id}/executions`, a, input()).expect(403);
  await post(`requests/${id}/executions`, b, { agentId, projectId }).expect(400);
  const responses = await Promise.all([
    post(`requests/${id}/executions`, b, input()),
    post(`requests/${id}/executions`, b, input()),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  const follow = responses.find((r) => r.status === 201)!.body;
  assert.equal(follow.previousExecutionId, ex.id);
  assert.equal(follow.status, 'QUEUED');
  const outbox = await db.outboxEvent.findFirstOrThrow({
    where: { executionId: follow.id, eventName: 'execution.command.requested' },
  });
  assert.equal((outbox.payload as any).followUpInstruction, input().followUpInstruction);
  assert.equal((outbox.payload as any).resumeSessionId, 'claude-session-first');
  let detail = (await get(`requests/${id}`).expect(200)).body;
  assert.equal(detail.state, 'READY_TO_RUN');
  assert.equal(detail.latestResult, null);
  assert.equal(detail.result, null);
  assert.deepEqual(
    detail.results.map((r: any) => r.id),
    [result.id],
  );
  await post(`results/${result.id}/approve-and-send`, b).expect(409);
  await post(`desktop/executions/${follow.id}/status`, token, { status: 'RUNNING' }).expect(201);
  await post(`desktop/executions/${follow.id}/status`, token, {
    status: 'PROGRESS',
    phase: 'started',
    sessionId: 'claude-session-second',
  }).expect(201);
  const second = (
    await post(`desktop/executions/${follow.id}/result`, token, {
      status: 'SUCCEEDED',
      summary: '테스트 추가 완료',
    }).expect(201)
  ).body;
  detail = (await get(`requests/${id}`).expect(200)).body;
  assert.deepEqual(
    detail.results.map((r: any) => r.id),
    [result.id, second.id],
  );
  assert.equal(detail.latestResult.id, second.id);
  assert.equal(detail.result.id, second.id);
  assert.equal(detail.executions.at(-1).claudeSessionId, 'claude-session-second');
  assert.equal(detail.executions[0].result.id, result.id);
  await post(`results/${result.id}/approve-and-send`, b).expect(409);
  assert.equal((await get(`requests/${id}`).expect(200)).body.state, 'RESULT_REVIEW');
  await post(`results/${second.id}/approve-and-send`, b).expect(201);
  assert.equal((await get(`requests/${id}`).expect(200)).body.state, 'COMPLETED');
  await post(`requests/${id}/executions`, b, input()).expect(409);
  assert.equal(
    await db.timelineEvent.count({
      where: { requestId: id, eventType: 'execution.follow_up_requested' },
    }),
    1,
  );
});

test('세션 미보고 시 resumeSessionId=null, 기존 additionalInstruction 입력도 허용', async () => {
  const { id, ex } = await initial();
  const follow = (
    await post(`requests/${id}/executions`, b, {
      agentId,
      projectId,
      additionalInstruction: '호환 입력',
    }).expect(201)
  ).body;
  assert.equal(follow.previousExecutionId, ex.id);
  const outbox = await db.outboxEvent.findFirstOrThrow({ where: { executionId: follow.id } });
  assert.equal((outbox.payload as any).resumeSessionId, null);
  assert.equal((outbox.payload as any).followUpInstruction, '호환 입력');
  await post(`executions/${follow.id}/cancel`, b).expect(201);
});

test('추가 작업과 결과 승인 경합은 하나만 성공하며 상태와 outbox가 일치한다', async () => {
  const { id, result } = await initial();
  const responses = await Promise.all([
    post(`requests/${id}/executions`, b, input()),
    post(`results/${result.id}/approve-and-send`, b),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  const detail = (await get(`requests/${id}`).expect(200)).body;
  if (responses[0].status === 201) {
    assert.equal(detail.state, 'READY_TO_RUN');
    assert.equal(detail.results[0].reviewStatus, 'PENDING');
    await post(`executions/${responses[0].body.id}/cancel`, b).expect(201);
  } else {
    assert.equal(detail.state, 'COMPLETED');
    assert.equal(detail.executions.length, 1);
  }
});

test('CLO-17 provider별 등록·재사용·capability 갱신·미보고 기본값 및 검증', async () => {
  const legacy = (await get('agents').expect(200)).body.find((agent: any) => agent.id === agentId);
  assert.equal(legacy.provider, 'CLAUDE_CODE');
  assert.equal(legacy.capabilities.supportsResume, true);
  const capabilities = {
    ...effectiveAgentCapabilities('CLAUDE_CODE', null),
    supportsResume: false,
  };
  const registered = await Promise.all(
    [1, 2].map(() =>
      post('desktop/agents', token, { provider: 'CODEX', capabilities }).expect(201),
    ),
  );
  assert.equal(registered[0].body.agentId, registered[1].body.agentId);
  const codexId = registered[0].body.agentId;
  assert.notEqual(codexId, agentId);
  const agyId = (await post('desktop/agents', token, { provider: 'AGY' }).expect(201)).body.agentId;
  await post('desktop/agents', token, { provider: 'GEMINI' }).expect(400);
  await post('desktop/agents', token, { capabilities: { supportsResume: true } }).expect(400);
  await post('desktop/agents', token, { capabilities: null }).expect(400);
  await post('desktop/heartbeat', token, { capabilities }).expect(400);
  await post('desktop/heartbeat', token, {
    agentId: codexId,
    capabilities: { supportsResume: 'yes' },
  }).expect(400);
  const changed = { ...capabilities, supportsStructuredProgress: false };
  await post('desktop/heartbeat', token, { agentId: codexId, capabilities: changed }).expect(201);
  await post('desktop/heartbeat', token, { agentId: codexId }).expect(201);
  await post('desktop/agents', token, { provider: 'CODEX' }).expect(201);
  const agents = (await get('agents').expect(200)).body;
  // CODEX 가 Claude Code 수준의 강제 능력을 선언해도 서버 상한으로 깎인 값이 저장·노출된다(CLO-110 H-2-1).
  assert.deepEqual(
    agents.find((agent: any) => agent.id === codexId).capabilities,
    clampAgentCapabilities('CODEX', changed).capabilities,
  );
  assert.equal(agents.find((agent: any) => agent.id === agyId).capabilities.supportsResume, false);
  assert.equal(
    agents.find((agent: any) => agent.id === agyId).capabilities.securityTier,
    'tier_c_unrestricted',
  );
  assert.ok(
    agents
      .filter((agent: any) => [agentId, codexId, agyId].includes(agent.id))
      .every((agent: any) => agent.status !== 'DISABLED'),
  );
  const another = (
    await post('desktop/installations/register', b, { name: '격리 디바이스' }).expect(201)
  ).body;
  await post('desktop/heartbeat', another.deviceToken, { agentId: codexId, capabilities }).expect(
    403,
  );
});

test('CLO-17 resume 미지원은 추가 작업 409·무변경, capability 갱신 후 재개 및 상세 노출', async () => {
  const capabilities = {
    ...effectiveAgentCapabilities('CLAUDE_CODE', null),
    supportsResume: false,
  };
  const codexId = (
    await post('desktop/agents', token, { provider: 'CODEX', capabilities }).expect(201)
  ).body.agentId;
  const codexProjectId = (await post('desktop/projects', token, { agentId: codexId }).expect(201))
    .body.projectId;
  const selected = { agentId: codexId, projectId: codexProjectId };
  const { id, ex } = await initial('codex-session', selected, codexRisks);
  const before = await db.outboxEvent.count({ where: { execution: { requestId: id } } });
  const denied = await post(`requests/${id}/executions`, b, {
    ...selected,
    followUpInstruction: '추가 작업',
  }).expect(409);
  assert.match(denied.body.message, /supportsResume/);
  assert.equal(await db.execution.count({ where: { requestId: id } }), 1);
  assert.equal(await db.outboxEvent.count({ where: { execution: { requestId: id } } }), before);
  const detail = (await get(`requests/${id}`).expect(200)).body;
  assert.equal(detail.state, 'RESULT_REVIEW');
  assert.equal(detail.executions[0].agent.provider, 'CODEX');
  assert.equal(detail.executions[0].agent.capabilities.supportsResume, false);
  await post('desktop/heartbeat', token, {
    agentId: codexId,
    capabilities: { ...capabilities, supportsResume: true },
  }).expect(201);
  // 다른 provider의 세션 ID를 그대로 넘기지 않는다.
  await post(`requests/${id}/executions`, b, input()).expect(409);
  const resumed = (
    await post(`requests/${id}/executions`, b, {
      ...selected,
      followUpInstruction: '추가 작업',
      acknowledgedRisks: codexRisks,
    }).expect(201)
  ).body;
  assert.equal(resumed.previousExecutionId, ex.id);
  const event = await db.outboxEvent.findFirstOrThrow({ where: { executionId: resumed.id } });
  assert.equal((event.payload as any).resumeSessionId, 'codex-session');
  await post('desktop/heartbeat', token, {
    agentId: codexId,
    capabilities: { ...capabilities, supportsCancel: false },
  }).expect(201);
  const cancel = await post(`executions/${resumed.id}/cancel`, b).expect(409);
  assert.match(cancel.body.message, /supportsCancel/);
  assert.equal(
    (await db.execution.findUniqueOrThrow({ where: { id: resumed.id } })).status,
    'QUEUED',
  );
  await post('desktop/heartbeat', token, { agentId: codexId, capabilities }).expect(201);
  await post(`executions/${resumed.id}/cancel`, b).expect(201);
});

test('CLO-17 정책 강제 수단이 없는 Agent 실행은 승인 없이는 상태·outbox 변경 없이 차단한다', async () => {
  const { id } = await initial();
  const capabilities = effectiveAgentCapabilities('CLAUDE_CODE', null);
  // CLO-108 이후에도 "승인 없는 요청은 막힌다"는 기본은 그대로다. 다만 차단 사유가 항목 목록으로 나온다.
  const expectedKey = {
    networkDeny: 'network_outbound',
    destructiveCommandDeny: 'deployment_apply',
    credentialPathDeny: 'credential_path_read',
  } as const;
  try {
    for (const flag of ['networkDeny', 'destructiveCommandDeny', 'credentialPathDeny'] as const) {
      await post('desktop/heartbeat', token, {
        agentId,
        capabilities: {
          ...capabilities,
          supportedPolicyEnforcements: {
            ...capabilities.supportedPolicyEnforcements,
            [flag]: false,
          },
        },
      }).expect(201);
      const denied = await post(`requests/${id}/executions`, b, input()).expect(409);
      assert.match(denied.body.message, /supportedPolicyEnforcements/);
      assert.equal(denied.body.code, 'execution.unenforceable_protections');
      assert.deepEqual(denied.body.requiredAcknowledgements, [expectedKey[flag]]);
      assert.equal((await get(`requests/${id}`).expect(200)).body.state, 'RESULT_REVIEW');
    }
    await post('desktop/heartbeat', token, {
      agentId,
      capabilities: {
        ...capabilities,
        supportedPolicyEnforcements: {
          ...capabilities.supportedPolicyEnforcements,
          toolDeny: false,
        },
      },
    }).expect(201);
    for (const policy of [{ repository_edit: 'deny' }, { shell_execution: 'read_only' }])
      await post(`requests/${id}/executions`, b, { ...input(), policy }).expect(409);
    await post('desktop/heartbeat', token, {
      agentId,
      capabilities: { ...capabilities, securityTier: 'tier_c_unrestricted' },
    }).expect(201);
    await post(`requests/${id}/executions`, b, input()).expect(409);
    assert.equal(await db.execution.count({ where: { requestId: id } }), 1);
  } finally {
    await post('desktop/heartbeat', token, { agentId, capabilities }).expect(201);
  }
});
