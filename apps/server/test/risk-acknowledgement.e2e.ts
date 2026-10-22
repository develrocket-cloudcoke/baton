import {
  effectiveAgentCapabilities,
  unenforceableProtections,
  type AgentCapabilities,
} from '@baton/shared';
import assert from 'node:assert/strict';
import test from 'node:test';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

// CLO-108: 강제할 수 없는 보호를 조용히 막지 않고, 무엇을 못 막는지 보여 준 뒤 항목별 승인으로 실행한다.
// 설계 06 §5.4 의 선택지 B 결정(2026-09-11)이 세 provider 모두에서 같은 규칙으로 동작하는지 본다.
let app: any, db: PrismaService;
let a: string, b: string, bId: string, token: string;
const post = (path: string, auth: string, body: any = {}) =>
  request(app.getHttpServer())
    .post(`/v1/${path}`)
    .set('Authorization', `Bearer ${auth}`)
    .send(body);
const get = (path: string) =>
  request(app.getHttpServer()).get(`/v1/${path}`).set('Authorization', `Bearer ${b}`);

// 설계 06 §4.4 의 Codex 실측 선언값. workspace-write 는 쓰기 경계일 뿐 읽기 경계가 아니다.
const codexCapabilities: AgentCapabilities = {
  supportsResume: true,
  supportsStructuredProgress: true,
  supportsCancel: true,
  supportsLayer1Patch: false,
  securityTier: 'tier_b_sandboxed',
  supportedPolicyEnforcements: {
    toolDeny: false,
    networkDeny: true,
    destructiveCommandDeny: false,
    credentialPathDeny: false,
  },
};
// Antigravity 는 아직 강제 수단이 하나도 확인되지 않았다(Tier C).
const agyCapabilities: AgentCapabilities = {
  supportsResume: false,
  supportsStructuredProgress: false,
  supportsCancel: true,
  supportsLayer1Patch: false,
  securityTier: 'tier_c_unrestricted',
  supportedPolicyEnforcements: {
    toolDeny: false,
    networkDeny: false,
    destructiveCommandDeny: false,
    credentialPathDeny: false,
  },
};

async function acceptedRequest(title: string) {
  const backend = await db.team.findFirstOrThrow({ where: { name: 'backend' } });
  const infra = await db.team.findFirstOrThrow({ where: { name: 'infra', orgId: backend.orgId } });
  const draft = (
    await post('requests', a, {
      senderTeamId: backend.id,
      recipientTeamId: infra.id,
      recipientUserId: bId,
      title,
      originalInstruction: '작업을 수행하세요.',
    }).expect(201)
  ).body;
  await post(`requests/${draft.id}/send`, a).expect(201);
  await post(`requests/${draft.id}/review/start`, b).expect(201);
  await post(`requests/${draft.id}/accept`, b).expect(201);
  return draft.id;
}
const registerAgent = async (provider: string, capabilities: AgentCapabilities) => {
  const agentId = (await post('desktop/agents', token, { provider, capabilities }).expect(201)).body
    .agentId;
  // 이미 등록된 provider 면 같은 Agent 가 재사용되므로 capability 를 heartbeat 로 맞춰 둔다.
  await post('desktop/heartbeat', token, { agentId, capabilities }).expect(201);
  const projectId = (await post('desktop/projects', token, { agentId }).expect(201)).body.projectId;
  return { agentId, projectId };
};

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
      .send({ code, deviceName: 'CLO-108' })
      .expect(201)
  ).body.deviceToken;
});
test.after(async () => app.close());

test('CLO-108 승인 없는 CODEX 실행은 409와 강제 불가 항목 목록을 돌려주고 아무것도 만들지 않는다', async () => {
  const { agentId, projectId } = await registerAgent('CODEX', codexCapabilities);
  const id = await acceptedRequest('CLO-108 목록');
  const denied = await post(`requests/${id}/executions`, b, { agentId, projectId }).expect(409);
  assert.equal(denied.body.code, 'execution.unenforceable_protections');
  // 기본 정책(deployment_apply=deny, network_outbound=deny) 기준: 네트워크는 막을 수 있고 나머지 둘은 못 막는다.
  assert.deepEqual(denied.body.requiredAcknowledgements, [
    'credential_path_read',
    'deployment_apply',
  ]);
  const credential = denied.body.unenforceableProtections[0];
  assert.equal(credential.severity, 'critical');
  assert.equal(credential.source, 'baseline');
  assert.equal(credential.policyField, null);
  assert.equal(credential.missingCapability, 'supportedPolicyEnforcements.credentialPathDeny');
  // 자격증명 항목은 무엇이 노출되는지 구체적으로 적혀 있어야 한다(06 §3.3 실측).
  for (const phrase of ['~/.aws/credentials', '~/.ssh/id_rsa', 'workspace-write'])
    assert.ok(credential.description.includes(phrase), `설명에 ${phrase} 가 없습니다.`);
  assert.ok(credential.risk.includes('회수할 수 없습니다'));
  assert.equal(denied.body.unenforceableProtections[1].source, 'policy');
  assert.equal(denied.body.unenforceableProtections[1].policyField, 'deployment_apply');
  // 기본은 여전히 막힌다: 상태·Execution·outbox 어느 것도 만들어지지 않는다.
  assert.equal(await db.execution.count({ where: { requestId: id } }), 0);
  assert.equal(await db.outboxEvent.count({ where: { execution: { requestId: id } } }), 0);
  assert.equal((await get(`requests/${id}`).expect(200)).body.state, 'ACCEPTED');
  // 웹은 같은 목록을 shared 함수로 미리 계산해 화면에 열거할 수 있다.
  assert.deepEqual(
    unenforceableProtections(codexCapabilities, {
      repository_edit: 'allow',
      deployment_apply: 'deny',
      network_outbound: 'deny',
      outside_write: 'deny',
      shell_execution: 'allow',
    }),
    denied.body.unenforceableProtections,
  );
});

test('CLO-108 부분 승인·다른 키·중복·모르는 키는 통과하지 못한다', async () => {
  const { agentId, projectId } = await registerAgent('CODEX', codexCapabilities);
  const id = await acceptedRequest('CLO-108 부분 승인');
  const body = (acknowledgedRisks: string[]) => ({ agentId, projectId, acknowledgedRisks });
  // 하나만 승인 — 뭉뚱그린 동의로 나머지가 덮이지 않는다.
  const partial = await post(`requests/${id}/executions`, b, body(['credential_path_read'])).expect(
    409,
  );
  assert.deepEqual(partial.body.requiredAcknowledgements, [
    'credential_path_read',
    'deployment_apply',
  ]);
  assert.deepEqual(partial.body.acknowledgedRisks, ['credential_path_read']);
  // 목록에 없는 항목을 대신 승인
  await post(`requests/${id}/executions`, b, body(['credential_path_read', 'network_outbound']))
    .expect(409)
    .expect((res) => assert.equal(res.body.code, 'execution.unenforceable_protections'));
  // 같은 키를 두 번 적어 개수만 맞추기
  await post(
    `requests/${id}/executions`,
    b,
    body(['credential_path_read', 'credential_path_read']),
  ).expect(409);
  // 스키마에 없는 키는 400 (409 이전에 걸린다)
  await post(`requests/${id}/executions`, b, body(['credential_path_read', 'bogus'])).expect(400);
  assert.equal(await db.execution.count({ where: { requestId: id } }), 0);
  assert.equal((await get(`requests/${id}`).expect(200)).body.state, 'ACCEPTED');
});

test('CLO-108 정확한 승인은 통과하고 Execution·Timeline·상세에 승인 기록이 남는다', async () => {
  const { agentId, projectId } = await registerAgent('CODEX', codexCapabilities);
  const id = await acceptedRequest('CLO-108 승인 실행');
  const created = (
    await post(`requests/${id}/executions`, b, {
      agentId,
      projectId,
      additionalInstruction: '테스트도 실행',
      acknowledgedRisks: ['deployment_apply', 'credential_path_read'], // 순서는 달라도 된다
    }).expect(201)
  ).body;
  const stored = await db.execution.findUniqueOrThrow({ where: { id: created.id } });
  assert.equal(stored.riskAcknowledgedByUserId, bId);
  assert.ok(stored.riskAcknowledgedAt instanceof Date);
  assert.deepEqual(
    (stored.acknowledgedRisks as any[]).map((item) => item.key),
    ['credential_path_read', 'deployment_apply'],
  );
  // 누가 언제 어떤 항목을 승인했는지 Timeline 에 남는다.
  const event = await db.timelineEvent.findFirstOrThrow({
    where: { executionId: created.id, eventType: 'execution.risk_acknowledged' },
  });
  assert.equal(event.actorType, 'HUMAN');
  assert.equal(event.actorUserId, bId);
  assert.deepEqual((event.payload as any).acknowledgedRisks, [
    'credential_path_read',
    'deployment_apply',
  ]);
  assert.equal((event.payload as any).agentProvider, 'CODEX');
  assert.equal((event.payload as any).securityTier, 'tier_b_sandboxed');
  assert.equal((event.payload as any).protections[0].title, '자격증명 파일 읽기 차단');
  // 상세 응답과 결과 화면이 "이 실행은 위험 승인 하에 돌았다"를 읽을 수 있다.
  const detail = (await get(`requests/${id}`).expect(200)).body;
  const execution = detail.executions.at(-1);
  assert.equal(execution.id, created.id);
  assert.equal(execution.riskAcknowledgedByUserId, bId);
  assert.deepEqual(
    execution.acknowledgedRisks.map((item: any) => item.key),
    ['credential_path_read', 'deployment_apply'],
  );
  assert.ok(
    detail.timelineEvents.some((item: any) => item.eventType === 'execution.risk_acknowledged'),
  );
  const single = (
    await request(app.getHttpServer())
      .get(`/v1/executions/${created.id}`)
      .set('Authorization', `Bearer ${b}`)
      .expect(200)
  ).body;
  assert.equal(single.acknowledgedRisks.length, 2);
  // 실행 명령은 정상적으로 나간다.
  const outbox = await db.outboxEvent.findFirstOrThrow({ where: { executionId: created.id } });
  assert.equal(outbox.eventName, 'execution.command.requested');
  assert.equal((outbox.payload as any).policy.deployment_apply, 'deny');
});

test('CLO-108 정책을 더 조이면 항목이 늘고, 늘어난 항목까지 승인해야 통과한다', async () => {
  const { agentId, projectId } = await registerAgent('CODEX', codexCapabilities);
  const id = await acceptedRequest('CLO-108 정책 강화');
  // toolDeny=false 인 Agent 에 셸 제한과 편집 금지를 요구하면 항목이 둘 늘어난다.
  const policy = { repository_edit: 'deny', shell_execution: 'read_only' };
  const denied = await post(`requests/${id}/executions`, b, {
    agentId,
    projectId,
    policy,
    acknowledgedRisks: ['credential_path_read', 'deployment_apply'],
  }).expect(409);
  assert.deepEqual(denied.body.requiredAcknowledgements, [
    'credential_path_read',
    'deployment_apply',
    'repository_edit',
    'shell_execution',
  ]);
  assert.ok(
    denied.body.unenforceableProtections
      .find((item: any) => item.key === 'shell_execution')
      .description.includes('shell_execution=read_only'),
  );
  const created = (
    await post(`requests/${id}/executions`, b, {
      agentId,
      projectId,
      policy,
      acknowledgedRisks: denied.body.requiredAcknowledgements,
    }).expect(201)
  ).body;
  assert.equal(
    (
      (await db.execution.findUniqueOrThrow({ where: { id: created.id } }))
        .acknowledgedRisks as any[]
    ).length,
    4,
  );
});

test('CLO-108 Tier C(AGY)도 항목을 모두 승인하면 실행되고, Claude Code는 승인 없이 그대로 통과한다', async () => {
  const agy = await registerAgent('AGY', agyCapabilities);
  const agyRequest = await acceptedRequest('CLO-108 AGY');
  const denied = await post(`requests/${agyRequest}/executions`, b, {
    agentId: agy.agentId,
    projectId: agy.projectId,
  }).expect(409);
  assert.deepEqual(denied.body.requiredAcknowledgements, [
    'credential_path_read',
    'network_outbound',
    'deployment_apply',
    'outside_write',
  ]);
  assert.equal(
    denied.body.unenforceableProtections.find((item: any) => item.key === 'outside_write')
      .missingCapability,
    'securityTier',
  );
  await post(`requests/${agyRequest}/executions`, b, {
    agentId: agy.agentId,
    projectId: agy.projectId,
    acknowledgedRisks: denied.body.requiredAcknowledgements,
  }).expect(201);

  // Claude Code 는 3중 방어선을 모두 강제하므로 강제 불가 항목이 없다 — 기존처럼 승인 없이 통과한다.
  const claude = await registerAgent(
    'CLAUDE_CODE',
    effectiveAgentCapabilities('CLAUDE_CODE', null),
  );
  const claudeRequest = await acceptedRequest('CLO-108 Claude Code');
  const created = (
    await post(`requests/${claudeRequest}/executions`, b, {
      agentId: claude.agentId,
      projectId: claude.projectId,
    }).expect(201)
  ).body;
  const stored = await db.execution.findUniqueOrThrow({ where: { id: created.id } });
  assert.equal(stored.acknowledgedRisks, null);
  assert.equal(stored.riskAcknowledgedAt, null);
  assert.equal(
    await db.timelineEvent.count({
      where: { executionId: created.id, eventType: 'execution.risk_acknowledged' },
    }),
    0,
  );
  // 승인할 항목이 없는데 승인을 보내면 그것도 409다 — 서버 목록과 정확히 일치해야 한다.
  const extra = await post(`requests/${claudeRequest}/executions`, b, {
    agentId: claude.agentId,
    projectId: claude.projectId,
    acknowledgedRisks: ['credential_path_read'],
  }).expect(409);
  assert.deepEqual(extra.body.unenforceableProtections, []);
  assert.deepEqual(extra.body.requiredAcknowledgements, []);
});
