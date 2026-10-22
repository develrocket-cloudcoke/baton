import {
  effectiveAgentCapabilities,
  unenforceableProtections,
  type AgentCapabilities,
} from '@baton/shared';
import { randomUUID } from 'node:crypto';
import { CodexAdapter } from '../../desktop-agent/src/adapter/codex';
import { AgyAdapter } from '../../desktop-agent/src/adapter/agy';
import { ClaudeCodeAdapter } from '../../desktop-agent/src/adapter/claude-code/adapter';
import { ExecutionPolicySchema } from '@baton/shared';
import assert from 'node:assert/strict';
import test from 'node:test';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { missingAuditTriggers } from '../src/audit-protection';

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

test('M-1 모든 실제 어댑터 게이트가 누락·과잉·중복 승인으로 실행되지 않는다', async () => {
  const adapters = [
    new CodexAdapter(),
    new AgyAdapter(),
    new ClaudeCodeAdapter({ hook: { node: '', cli: '' } }),
  ];
  for (const adapter of adapters) {
    const policy = ExecutionPolicySchema.parse({});
    const required = unenforceableProtections(adapter.getCapabilities(), policy).map((p) => p.key);
    const invalid = required.length
      ? [[], [...required, required[0]], [...required, 'unexpected']]
      : [['credential_path_read']];
    for (const acknowledgedRisks of invalid) {
      // 존재하지 않는 프로젝트/CLI까지 도달하지 않고 독립 계산에서 거부해야 한다.
      await assert.rejects(
        adapter.createRunner().run(
          {
            executionId: randomUUID(),
            requestId: randomUUID(),
            projectRoot: '/nonexistent-gate-test',
            attachments: [],
            policy,
            acknowledgedRisks,
          },
          { onProgress() {} },
        ),
        (error: Error) => {
          const report = JSON.parse(error.message);
          assert.equal(report.code, 'execution.capability_mismatch');
          assert.deepEqual(report.localRequiredKeys, required);
          assert.deepEqual(report.serverApprovedKeys, acknowledgedRisks);
          return true;
        },
      );
    }
  }
});

test('M-1 데몬 독립 검증 거부 보고는 서버 실패 상태와 불일치 전문 이벤트로 남는다', async () => {
  const selected = await registerAgent('CODEX', codexCapabilities);
  const id = await acceptedRequest('독립 게이트 불일치');
  const execution = (
    await post(`requests/${id}/executions`, b, {
      ...selected,
      acknowledgedRisks: ['credential_path_read', 'deployment_apply'],
    }).expect(201)
  ).body;
  await post(`desktop/executions/${execution.id}/status`, token, { status: 'RUNNING' }).expect(201);
  const outbox = await db.outboxEvent.findFirstOrThrow({ where: { executionId: execution.id } });
  const command = outbox.payload as any;
  let failureReason = '';
  try {
    // 전송 이후 capability가 달라진 상황: 데몬은 자신의 현재 능력을 다시 읽는다.
    const adapter = new CodexAdapter();
    const capabilities = adapter.getCapabilities();
    adapter.getCapabilities = () => ({
      ...capabilities,
      supportedPolicyEnforcements: {
        ...capabilities.supportedPolicyEnforcements,
        networkDeny: false,
      },
    });
    await adapter
      .createRunner()
      .run({ ...command, projectRoot: '/nonexistent-gate-test' }, { onProgress() {} });
    assert.fail('게이트가 실행을 허용했습니다');
  } catch (error) {
    failureReason = (error as Error).message;
  }
  const report = JSON.parse(failureReason);
  assert.ok(report.localRequiredKeys.includes('network_outbound'));
  await post(`desktop/executions/${execution.id}/result`, token, {
    status: 'FAILED',
    failureReason,
    summary: '독립 검증 거부',
    changedFiles: [],
    artifactIds: [],
  }).expect(201);
  assert.equal(
    (await db.execution.findUniqueOrThrow({ where: { id: execution.id } })).status,
    'FAILED',
  );
  const event = await db.timelineEvent.findFirstOrThrow({
    where: { executionId: execution.id, eventType: 'execution.capability_mismatch' },
  });
  assert.deepEqual(event.payload, report);
});

test('M-3 resume는 현재 정책이 완화되어도 이전 승인 합집합을 다시 승인해야 한다', async () => {
  const selected = await registerAgent('CODEX', codexCapabilities);
  const id = await acceptedRequest('resume 승인 경계');
  const first = (
    await post(`requests/${id}/executions`, b, {
      ...selected,
      acknowledgedRisks: ['credential_path_read', 'deployment_apply'],
    }).expect(201)
  ).body;
  const sessionId = randomUUID();
  await post(`desktop/executions/${first.id}/status`, token, {
    status: 'RUNNING',
    sessionId,
  }).expect(201);
  await post(`desktop/executions/${first.id}/result`, token, {
    status: 'SUCCEEDED',
    summary: '첫 결과',
  }).expect(201);
  const body = { ...selected, followUpInstruction: '계속', policy: { deployment_apply: 'allow' } };
  const denied = await post(`requests/${id}/executions`, b, {
    ...body,
    acknowledgedRisks: ['credential_path_read'],
  }).expect(409);
  assert.deepEqual(denied.body.requiredAcknowledgements, [
    'credential_path_read',
    'deployment_apply',
  ]);
  const second = (
    await post(`requests/${id}/executions`, b, {
      ...body,
      acknowledgedRisks: denied.body.requiredAcknowledgements,
    }).expect(201)
  ).body;
  const outbox = await db.outboxEvent.findFirstOrThrow({ where: { executionId: second.id } });
  assert.deepEqual((outbox.payload as any).inheritedRiskKeys, [
    'credential_path_read',
    'deployment_apply',
  ]);
  assert.equal((outbox.payload as any).resumeSessionId, sessionId);
  assert.equal(second.riskAcknowledgedByUserId, bId);
  assert.notEqual(second.id, first.id);
  await post(`executions/${second.id}/cancel`, b).expect(201);
});

test('M-6-2 SQL UPDATE·DELETE·부모 cascade 및 승인 원본 변조는 DB에서 탐지·거부된다', async (t) => {
  const missing = await missingAuditTriggers(db);
  if (missing.length) {
    t.skip(`감사 트리거 미설치: ${missing.join(', ')}`);
    return;
  }
  const selected = await registerAgent('CODEX', codexCapabilities);
  const id = await acceptedRequest('감사 무결성');
  const execution = (
    await post(`requests/${id}/executions`, b, {
      ...selected,
      acknowledgedRisks: ['credential_path_read', 'deployment_apply'],
    }).expect(201)
  ).body;
  const event = await db.timelineEvent.findFirstOrThrow({
    where: { executionId: execution.id, eventType: 'execution.risk_acknowledged' },
  });
  await assert.rejects(
    db.$executeRaw`UPDATE TimelineEvent SET payload = JSON_OBJECT() WHERE id = ${event.id}`,
    /audit.append_only/,
  );
  await assert.rejects(
    db.$executeRaw`DELETE FROM TimelineEvent WHERE id = ${event.id}`,
    /audit.append_only/,
  );
  await assert.rejects(
    db.$executeRaw`DELETE FROM Request WHERE id = ${id}`,
    /foreign key constraint/i,
  );
  await assert.rejects(
    db.$executeRaw`UPDATE Execution SET acknowledgedRisks = JSON_ARRAY() WHERE id = ${execution.id}`,
    /audit.append_only/,
  );
  await assert.rejects(
    db.$executeRaw`UPDATE Execution SET riskAcknowledgedByUserId = 'forged' WHERE id = ${execution.id}`,
    /audit.append_only/,
  );
  assert.deepEqual(
    (await db.timelineEvent.findUniqueOrThrow({ where: { id: event.id } })).payload,
    event.payload,
  );
  await post(`executions/${execution.id}/cancel`, b).expect(201);
});
