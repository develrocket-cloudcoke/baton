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

// CLO-110(보안 검토 후속): capability 는 데몬의 자기 선언이다. 서버 상한(H-2-1), 승인 목록의 결정성(M-2),
// 승인 기록의 capability 스냅샷(M-6-1), 발신자 응답에서 수신자 비공개 지시 제거(H-1-3)를 한 파일에서 본다.
let app: any, db: PrismaService;
let a: string, b: string, bId: string, token: string;
const post = (path: string, auth: string, body: any = {}) =>
  request(app.getHttpServer())
    .post(`/v1/${path}`)
    .set('Authorization', `Bearer ${auth}`)
    .send(body);
const get = (path: string, auth: string) =>
  request(app.getHttpServer()).get(`/v1/${path}`).set('Authorization', `Bearer ${auth}`);

// 설계 06 §4.4 의 Codex 실측 선언값 — 이 값이 그대로 서버 상한이다.
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
// 상한을 전부 넘겨 선언한 값. 깎지 않으면 승인 항목이 통째로 사라진다(보안 검토 §1 probe C).
const overDeclaredCodex: AgentCapabilities = {
  ...codexCapabilities,
  supportsLayer1Patch: true,
  securityTier: 'tier_a_hardened',
  supportedPolicyEnforcements: {
    toolDeny: true,
    networkDeny: true,
    destructiveCommandDeny: true,
    credentialPathDeny: true,
  },
};
const defaultPolicy = {
  repository_edit: 'allow',
  deployment_apply: 'deny',
  network_outbound: 'deny',
  outside_write: 'deny',
  shell_execution: 'allow',
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
      .send({ code, deviceName: 'CLO-110' })
      .expect(201)
  ).body.deviceToken;
});
test.after(async () => app.close());

test('CLO-110 H-2-1 등록·heartbeat 의 과대 선언은 provider 상한으로 깎여 저장된다', async () => {
  const { agentId } = await registerAgent('CODEX', overDeclaredCodex);
  const stored = (await db.agent.findUniqueOrThrow({ where: { id: agentId } })).capabilities as any;
  // 상한을 넘긴 네 필드는 전부 깎였고, 정직하게 선언한 networkDeny 는 그대로다.
  assert.equal(stored.securityTier, 'tier_b_sandboxed');
  assert.equal(stored.supportsLayer1Patch, false);
  assert.deepEqual(stored.supportedPolicyEnforcements, {
    toolDeny: false,
    networkDeny: true,
    destructiveCommandDeny: false,
    credentialPathDeny: false,
  });
  // heartbeat 경로도 같다 — 런타임 capability 갱신으로 상한을 넘길 수 없다.
  await post('desktop/heartbeat', token, { agentId, capabilities: overDeclaredCodex }).expect(201);
  assert.equal(
    ((await db.agent.findUniqueOrThrow({ where: { id: agentId } })).capabilities as any)
      .supportedPolicyEnforcements.credentialPathDeny,
    false,
  );
  // 사용자에게 보이는 Agent 목록(GET /v1/agents)도 같은 effectiveAgentCapabilities 를 지나므로 깎인 값을 보여 준다.
  // 그 엔드포인트는 사용자의 모든 Device 를 FOR UPDATE 로 잠가 병렬 e2e 에서 락 경합이 나므로 여기서는 같은 함수로 확인한다.
  assert.deepEqual(effectiveAgentCapabilities('CODEX', stored), {
    ...overDeclaredCodex,
    supportsLayer1Patch: false,
    securityTier: 'tier_b_sandboxed',
    supportedPolicyEnforcements: {
      toolDeny: false,
      networkDeny: true,
      destructiveCommandDeny: false,
      credentialPathDeny: false,
    },
  });
});

test('CLO-110 H-2-1 DB 에 과대 선언이 남아 있어도 실행은 상한으로 다시 깎아 승인을 요구한다', async () => {
  const { agentId, projectId } = await registerAgent('CODEX', codexCapabilities);
  // 저장 시점 clamp 를 우회한 행(옛 데이터·직접 DB 수정)을 만들어 읽기 경로의 clamp 를 확인한다.
  await db.agent.update({ where: { id: agentId }, data: { capabilities: overDeclaredCodex } });
  const id = await acceptedRequest('CLO-110 저장된 과대 선언');
  const denied = await post(`requests/${id}/executions`, b, { agentId, projectId }).expect(409);
  assert.deepEqual(denied.body.requiredAcknowledgements, [
    'credential_path_read',
    'deployment_apply',
  ]);
  // 승인 기록의 스냅샷에 "그때 과대 선언이 있었다"가 남는다(M-6-1).
  const created = (
    await post(`requests/${id}/executions`, b, {
      agentId,
      projectId,
      acknowledgedRisks: denied.body.requiredAcknowledgements,
    }).expect(201)
  ).body;
  const snapshot = (await db.execution.findUniqueOrThrow({ where: { id: created.id } }))
    .agentCapabilitiesSnapshot as any;
  assert.equal(snapshot.agentProvider, 'CODEX');
  assert.equal(snapshot.securityTier, 'tier_b_sandboxed');
  assert.equal(snapshot.capabilities.supportedPolicyEnforcements.credentialPathDeny, false);
  assert.equal(snapshot.declaredCapabilities.supportedPolicyEnforcements.credentialPathDeny, true);
  assert.deepEqual(snapshot.overDeclaredCapabilities.sort(), [
    'securityTier',
    'supportedPolicyEnforcements.credentialPathDeny',
    'supportedPolicyEnforcements.destructiveCommandDeny',
    'supportedPolicyEnforcements.toolDeny',
    'supportsLayer1Patch',
  ]);
  await db.agent.update({ where: { id: agentId }, data: { capabilities: codexCapabilities } });
});

test('CLO-110 M-2 정책을 어떤 모양으로 보내도 승인 목록은 같다', async () => {
  const { agentId, projectId } = await registerAgent('CODEX', codexCapabilities);
  const id = await acceptedRequest('CLO-110 목록 결정성');
  const listFor = async (policy: any) =>
    (
      await post(`requests/${id}/executions`, b, {
        agentId,
        projectId,
        ...(policy ? { policy } : {}),
      }).expect(409)
    ).body.unenforceableProtections;
  const full = await listFor(defaultPolicy);
  for (const policy of [null, {}, { repository_edit: 'allow' }, { deployment_apply: 'deny' }])
    assert.deepEqual(await listFor(policy), full, `policy=${JSON.stringify(policy)}`);
  // 웹·CLI 가 정규화하지 않은 정책으로 미리 계산해도 서버와 같은 목록을 본다 — M-2 의 핵심이다.
  assert.deepEqual(unenforceableProtections(codexCapabilities, {} as any), full);
  assert.deepEqual(unenforceableProtections(codexCapabilities, undefined as any), full);
});

test('CLO-110 M-6-1 승인 항목이 0 건인 실행에도 capability 스냅샷이 남는다', async () => {
  const claude = await registerAgent(
    'CLAUDE_CODE',
    effectiveAgentCapabilities('CLAUDE_CODE', null),
  );
  const id = await acceptedRequest('CLO-110 스냅샷 0건');
  const created = (
    await post(`requests/${id}/executions`, b, {
      agentId: claude.agentId,
      projectId: claude.projectId,
    }).expect(201)
  ).body;
  const stored = await db.execution.findUniqueOrThrow({ where: { id: created.id } });
  // 승인 기록 세 필드는 여전히 null 이다. 그 이유를 스냅샷이 설명한다.
  assert.equal(stored.acknowledgedRisks, null);
  assert.equal(stored.riskAcknowledgedAt, null);
  const snapshot = stored.agentCapabilitiesSnapshot as any;
  assert.equal(snapshot.agentProvider, 'CLAUDE_CODE');
  assert.equal(snapshot.securityTier, 'tier_a_hardened');
  assert.deepEqual(snapshot.unenforceableProtectionKeys, []);
  assert.deepEqual(snapshot.overDeclaredCapabilities, []);
  assert.equal(snapshot.capabilities.supportedPolicyEnforcements.credentialPathDeny, true);
  assert.equal(snapshot.policy.deployment_apply, 'deny');
  assert.ok(typeof snapshot.capturedAt === 'string' && snapshot.capturedAt.length > 0);
});

test('CLO-110 H-1-3 발신자 응답에는 수신자의 추가 지시가 없고 수신자에게는 그대로 보인다', async () => {
  const claude = await registerAgent(
    'CLAUDE_CODE',
    effectiveAgentCapabilities('CLAUDE_CODE', null),
  );
  const id = await acceptedRequest('CLO-110 비공개 지시');
  const secret = '사내 배포키는 ~/.config/deploy.env 에 있으니 그걸로 확인해줘';
  const created = (
    await post(`requests/${id}/executions`, b, {
      agentId: claude.agentId,
      projectId: claude.projectId,
      additionalInstruction: secret,
    }).expect(201)
  ).body;

  // 수신자(실행 소유자)는 그대로 본다.
  const mine = (await get(`requests/${id}`, b).expect(200)).body;
  assert.equal(mine.executions.at(-1).additionalInstruction, secret);
  assert.equal(mine.executions.at(-1).additionalInstructionRedacted, undefined);
  assert.ok(mine.executions.at(-1).agentCapabilitiesSnapshot);
  assert.equal(mine.executions.at(-1).agent.provider, 'CLAUDE_CODE');
  assert.equal(
    (await get(`executions/${created.id}`, b).expect(200)).body.additionalInstruction,
    secret,
  );
  const bTimeline = (await get(`requests/${id}/timeline`, b).expect(200)).body;
  assert.ok(bTimeline.some((event: any) => event.payload?.additionalInstruction === secret));
  const bCmdReq = bTimeline.find((event: any) => event.eventType === 'execution.command_requested');
  assert.ok(bCmdReq, '수신자 타임라인에는 execution.command_requested 가 포함되어야 함');
  assert.equal(bCmdReq.audience, 'recipient');

  // 발신자는 같은 요청을 읽을 수 있지만 추가 지시, 에이전트 상세, 승인 내역, 수신자 전용 타임라인 이벤트를 볼 수 없다 (H-1 전면 적용).
  const theirs = (await get(`requests/${id}`, a).expect(200)).body;
  const execution = theirs.executions.at(-1);
  assert.equal(execution.id, created.id);
  assert.equal(execution.additionalInstruction, '');
  assert.equal(execution.additionalInstructionRedacted, true);
  assert.equal(execution.agentCapabilitiesSnapshot, null);
  assert.equal(execution.acknowledgedRisks, null);
  assert.equal(execution.claudeSessionId, null);
  assert.equal(execution.projectId, '');
  assert.equal(execution.agent.provider, null);
  assert.equal(execution.agent.capabilities, null);
  assert.equal(execution.agent.deviceId, null);

  const single = (await get(`executions/${created.id}`, a).expect(200)).body;
  assert.equal(single.additionalInstruction, '');
  assert.equal(single.additionalInstructionRedacted, true);
  assert.equal(single.agentCapabilitiesSnapshot, null);
  assert.equal(single.agent.provider, null);

  for (const events of [
    theirs.timelineEvents,
    (await get(`requests/${id}/timeline`, a).expect(200)).body,
  ]) {
    // 수신자 전용 이벤트(execution.command_requested, execution.risk_acknowledged)는 발신자 타임라인에서 제외된다.
    const requested = events.find(
      (event: any) => event.eventType === 'execution.command_requested',
    );
    assert.equal(
      requested,
      undefined,
      '발신자 타임라인에서 execution.command_requested 는 제외되어야 함',
    );
    const riskAck = events.find((event: any) => event.eventType === 'execution.risk_acknowledged');
    assert.equal(
      riskAck,
      undefined,
      '발신자 타임라인에서 execution.risk_acknowledged 는 제외되어야 함',
    );
    assert.ok(
      events.every((ev: any) => ev.audience === 'both'),
      '발신자에게 전달되는 모든 이벤트의 audience는 both여야 함',
    );
    assert.equal(JSON.stringify(events).includes(secret), false);
  }
  assert.equal(JSON.stringify(theirs).includes(secret), false);
});

test('CLO-110 H-1: capability_mismatch 이벤트 및 failureReason의 수신자 능력 정보가 발신자에게 은닉된다', async () => {
  const claude = await registerAgent(
    'CLAUDE_CODE',
    effectiveAgentCapabilities('CLAUDE_CODE', null),
  );
  // 앞선 조회 테스트가 남긴 실행을 종료해 프로젝트당 동시 실행 제약과 격리한다.
  const pending = await db.execution.findMany({
    where: { projectId: claude.projectId, status: { in: ['QUEUED', 'RUNNING'] } },
  });
  for (const execution of pending) await post(`executions/${execution.id}/cancel`, b).expect(201);
  const id = await acceptedRequest('CLO-110 실패 사유 은닉');
  const created = (
    await post(`requests/${id}/executions`, b, {
      agentId: claude.agentId,
      projectId: claude.projectId,
      additionalInstruction: '정상 지시',
    }).expect(201)
  ).body;

  // 데몬에서 capability_mismatch 로 실패 보고
  const mismatchJson = JSON.stringify({
    code: 'execution.capability_mismatch',
    localRequiredKeys: ['credential_path_read', 'outside_write'],
    serverApprovedKeys: [],
    inheritedRiskKeys: [],
  });

  await post(`desktop/executions/${created.id}/status`, token, {
    status: 'RUNNING',
  }).expect(201);

  await post(`desktop/executions/${created.id}/result`, token, {
    status: 'FAILED',
    failureReason: mismatchJson,
  }).expect(201);

  // 수신자는 원문과 capability_mismatch 이벤트를 그대로 본다.
  const mine = (await get(`requests/${id}`, b).expect(200)).body;
  const mineExec = mine.executions.at(-1);
  assert.equal(mineExec.failureReason, mismatchJson);

  const bTimeline = (await get(`requests/${id}/timeline`, b).expect(200)).body;
  const bMismatch = bTimeline.find((ev: any) => ev.eventType === 'execution.capability_mismatch');
  assert.ok(bMismatch, '수신자는 execution.capability_mismatch 이벤트를 볼 수 있어야 함');
  assert.equal(bMismatch.audience, 'recipient');

  // 발신자에게는 capability_mismatch 이벤트가 제외되고, failureReason 은 정제된다.
  const theirs = (await get(`requests/${id}`, a).expect(200)).body;
  const theirExec = theirs.executions.at(-1);
  assert.equal(theirExec.failureReason, '에이전트 보안 정책 불일치로 실행 실패');
  assert.equal(JSON.stringify(theirExec).includes('localRequiredKeys'), false);

  const aTimeline = (await get(`requests/${id}/timeline`, a).expect(200)).body;
  const aMismatch = aTimeline.find((ev: any) => ev.eventType === 'execution.capability_mismatch');
  assert.equal(aMismatch, undefined, '발신자에게는 execution.capability_mismatch 가 제외되어야 함');

  const aFailed = aTimeline.find((ev: any) => ev.eventType === 'execution.failed');
  assert.ok(aFailed, '발신자에게 execution.failed 자체는 전달됨');
  assert.equal(aFailed.payload?.reason, '에이전트 보안 정책 불일치로 실행 실패');
  assert.equal(JSON.stringify(aTimeline).includes('localRequiredKeys'), false);
});
