import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ApprovalsService, expireExecutionApprovals } from './approvals/approvals.service';
import { auditTriggers } from './audit-protection';
import { CreateApprovalSchema } from '@baton/shared';

// DB 연결 없이 실행 잠금의 직렬화와 트랜잭션 경계를 재현한다.
function fixture() {
  const execution: any = { id: 'execution', requestId: 'request', agentId: 'agent', executorUserId: 'executor', status: 'RUNNING', agent: { deviceId: 'device' }, request: { recipientUserId: 'executor', senderUserId: 'sender' }, agentCapabilitiesSnapshot: { policy: { approval_mode: 'ask' } } };
  const rows: any[] = [];
  const events: any[] = [];
  const tx: any = {
    $queryRaw: async () => [],
    execution: { findUnique: async () => execution, findUniqueOrThrow: async () => execution },
    executionApproval: {
      create: async ({ data }: any) => { const row = { id: `approval-${rows.length}`, status: 'PENDING', createdAt: new Date(), decidedAt: null, decidedByUserId: null, ...data }; rows.push(row); return { ...row }; },
      findUnique: async ({ where }: any) => { const row = rows.find(r => r.id === where.id); return row ? { ...row } : null; },
      findUniqueOrThrow: async ({ where }: any) => ({ ...rows.find(r => r.id === where.id) }),
      findMany: async ({ where }: any) => rows.filter(r => r.executionId === where.executionId && (where.status === undefined || r.status === where.status)).map(r => ({ ...r })),
      updateMany: async ({ where, data }: any) => { const row = rows.find(r => r.id === where.id && r.status === where.status); if (!row) return { count: 0 }; Object.assign(row, data); return { count: 1 }; },
    },
    timelineEvent: { create: async ({ data }: any) => { events.push(data); return data; } },
  };
  let tail = Promise.resolve();
  const db: any = { ...tx, $transaction: (fn: any) => { const result = tail.then(() => fn(tx)); tail = result.catch(() => {}); return result; } };
  return { service: new ApprovalsService(db), execution, rows, events, tx };
}
const body = { toolName: 'Bash', detail: '<script>alert(1)</script>', reason: '정책 차단' };
const forbidden = (e: any) => e.getStatus?.() === 403;
const conflict = (e: any) => e.getStatus?.() === 409;

test('승인 생성은 RUNNING/ask/소유 디바이스만, 원문은 평문 길이 제한 및 감사 기록', async () => {
  const f = fixture();
  await assert.rejects(f.service.create('other', 'execution', body), forbidden);
  f.execution.status = 'QUEUED';
  await assert.rejects(f.service.create('device', 'execution', body), forbidden);
  f.execution.status = 'RUNNING'; f.execution.agentCapabilitiesSnapshot.policy.approval_mode = 'deny';
  await assert.rejects(f.service.create('device', 'execution', body), forbidden);
  f.execution.agentCapabilitiesSnapshot.policy.approval_mode = 'ask';
  const result = await f.service.create('device', 'execution', { ...body, detail: body.detail + 'x'.repeat(3000) });
  assert.ok(result.expiresAt.getTime() > Date.now());
  assert.ok(f.rows[0].detail.length <= 2000);
  assert.ok(f.rows[0].detail.startsWith('<script>'));
  assert.ok(f.rows[0].detail.endsWith('[내용 잘림]'));
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].eventType, 'execution.approval_requested');
  assert.equal(f.events[0].payload.detail, f.rows[0].detail);
  assert.equal(CreateApprovalSchema.safeParse({ ...body, detail: 'x'.repeat(100001) }).success, false);
});

test('요청자와 다른 사용자/디바이스는 결정·조회 불가, 확정 실행자만 결정', async () => {
  const f = fixture(); const { approvalId } = await f.service.create('device', 'execution', body);
  for (const user of ['sender', 'admin', 'other']) await assert.rejects(f.service.decide(user, approvalId, { decision: 'ALLOWED' }), forbidden);
  await assert.rejects(f.service.get('other-device', approvalId), forbidden);
  f.execution.request.recipientUserId = 'other';
  await assert.rejects(f.service.decide('executor', approvalId, { decision: 'ALLOWED' }), forbidden);
  f.execution.request.recipientUserId = 'executor';
  assert.deepEqual(await f.service.decide('executor', approvalId, { decision: 'DENIED' }), { status: 'DENIED' });
  assert.equal((await f.service.get('device', approvalId)).status, 'DENIED');
  assert.equal(f.events[1].payload.decidedByUserId, 'executor');
});

test('동시 결정은 하나만 성공하고 결정 감사 이벤트도 한 번', async () => {
  const f = fixture(); const { approvalId } = await f.service.create('device', 'execution', body);
  const results = await Promise.allSettled(['ALLOWED', 'DENIED'].map(decision => f.service.decide('executor', approvalId, { decision })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal(f.events.filter(e => e.eventType === 'execution.approval_decided').length, 1);
  await assert.rejects(f.service.decide('executor', approvalId, { decision: 'ALLOWED' }), conflict);
});

test('마감과 실행 종료는 EXPIRED로 확정하며 409 뒤에도 저장된다', async () => {
  for (const cause of ['deadline', 'cancel']) {
    const f = fixture(); const { approvalId } = await f.service.create('device', 'execution', body);
    if (cause === 'deadline') f.rows[0].expiresAt = new Date(0);
    else f.execution.status = 'CANCELLED';
    await assert.rejects(f.service.decide('executor', approvalId, { decision: 'ALLOWED' }), conflict);
    assert.equal(f.rows[0].status, 'EXPIRED');
    assert.equal((await f.service.get('device', approvalId)).status, 'EXPIRED');
    assert.equal(f.events.length, 2);
  }
});

test('GET 만료와 종료 정리는 멱등이며 이미 결정된 행을 덮어쓰지 않는다', async () => {
  const f = fixture(); const a = await f.service.create('device', 'execution', body);
  f.rows[0].expiresAt = new Date(0);
  assert.equal((await f.service.get('device', a.approvalId)).status, 'EXPIRED');
  const b = await f.service.create('device', 'execution', body);
  await f.service.decide('executor', b.approvalId, { decision: 'ALLOWED' });
  await f.service.create('device', 'execution', body);
  await expireExecutionApprovals(f.tx, 'execution');
  await expireExecutionApprovals(f.tx, 'execution');
  assert.deepEqual(f.rows.map(r => r.status), ['EXPIRED', 'ALLOWED', 'EXPIRED']);
  assert.equal(f.events.filter(e => e.eventType === 'execution.approval_decided').length, 3);
});

test('승인 감사 DDL에 삭제 차단과 원문/마감/확정 결정 불변 조건이 포함된다', () => {
  const sql = auditTriggers.find(t => t.name === 'ExecutionApproval_immutable')!.sql;
  for (const field of ['id','executionId','toolName','detail','reason','expiresAt','createdAt']) assert.ok(sql.includes(`OLD.${field} <=> NEW.${field}`));
  assert.ok(sql.includes("OLD.status <> 'PENDING'"));
  assert.ok(auditTriggers.some(t => t.name === 'ExecutionApproval_no_delete'));
});

test('웹 목록은 확정 수신자인 실행자만 조회하고 마감·종료는 한 번만 만료시킨다', async () => {
  const f = fixture();
  const a = await f.service.create('device', 'execution', body);
  for (const user of ['sender', 'admin', 'other'])
    await assert.rejects(f.service.list(user, 'execution'), forbidden);
  f.execution.request.recipientUserId = 'other';
  await assert.rejects(f.service.list('executor', 'execution'), forbidden);
  f.execution.request.recipientUserId = 'executor';
  const pending = await f.service.list('executor', 'execution');
  assert.equal(pending[0].id, a.approvalId);
  assert.equal(pending[0].detail, body.detail);
  assert.equal(pending[0].status, 'PENDING');
  f.rows[0].expiresAt = new Date(0);
  assert.equal((await f.service.list('executor', 'execution'))[0].status, 'EXPIRED');
  await f.service.list('executor', 'execution');
  assert.equal(f.events.length, 2);
  await f.service.create('device', 'execution', body);
  f.execution.status = 'CANCELLED';
  assert.deepEqual(
    (await f.service.list('executor', 'execution')).map((a) => a.status),
    ['EXPIRED', 'EXPIRED'],
  );
});

test('웹 결정 계약은 데몬의 생성 ID·상태·마감 계약을 유지한다', async () => {
  for (const decision of ['ALLOWED', 'DENIED'] as const) {
    const f = fixture();
    const created = JSON.parse(JSON.stringify(await f.service.create('device', 'execution', body)));
    const listed = JSON.parse(JSON.stringify(await f.service.list('executor', 'execution')));
    assert.equal(listed[0].id, created.approvalId);
    assert.equal(listed[0].expiresAt, created.expiresAt);
    assert.equal((await f.service.get('device', created.approvalId)).status, 'PENDING');
    assert.deepEqual(await f.service.decide('executor', listed[0].id, { decision }), {
      status: decision,
    });
    const polled = JSON.parse(JSON.stringify(await f.service.get('device', created.approvalId)));
    assert.deepEqual(polled, { status: decision, expiresAt: created.expiresAt });
    assert.equal(f.events[1].payload.executionId, 'execution');
  }
});

test('HTTP 승인 계약: 데몬 생성 → 웹 조회·결정 → 데몬 폴링, 타인 조회와 재결정 차단', async () => {
  const { Module, UnauthorizedException } = await import('@nestjs/common');
  const { NestFactory } = await import('@nestjs/core');
  const { default: request } = await import('supertest');
  const { ApprovalsController } = await import('./approvals/approvals.controller');
  const { AuthService } = await import('./auth/auth.service');
  const { DesktopService } = await import('./desktop/desktop.service');
  const f = fixture();
  @Module({
    controllers: [ApprovalsController],
    providers: [
      { provide: ApprovalsService, useValue: f.service },
      {
        provide: AuthService,
        useValue: {
          current: async (header: string) => {
            if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();
            return { sub: header.slice(7) };
          },
        },
      },
      {
        provide: DesktopService,
        useValue: {
          device: async (header: string) => {
            if (header !== 'Bearer device') throw new UnauthorizedException();
            return { id: 'device' };
          },
        },
      },
    ],
  })
  class UnitApprovalModule {}
  const app = await NestFactory.create(UnitApprovalModule, { logger: false });
  try {
    // 127.0.0.1 로 명시해 연다. 호스트 없이 두면 supertest 가 '::' 로 listen(0) 하는데,
    // macOS 는 다른 프로세스(병렬로 도는 다른 테스트 파일의 가짜 인증 서버)가 같은 포트를
    // 127.0.0.1 로 또 열 수 있게 허용하고 요청이 그쪽으로 간다 — 20회 중 1회꼴로 콜백이
    // 가짜 서버의 404·400 을 받던 간헐 실패의 원인(2026-09-23 실측).
    await app.listen(0, '127.0.0.1');
    const api = request(app.getHttpServer());
    const created = await api
      .post('/v1/desktop/executions/execution/approvals')
      .set('Authorization', 'Bearer device')
      .send(body)
      .expect(201);
    const route = '/v1/executions/execution/approvals';
    await api.get(route).expect(401);
    await api.get(route).set('Authorization', 'Bearer sender').expect(403);
    const listed = await api.get(route).set('Authorization', 'Bearer executor').expect(200);
    assert.equal(listed.body[0].id, created.body.approvalId);
    assert.equal(listed.body[0].expiresAt, created.body.expiresAt);
    const decisionRoute = `/v1/approvals/${created.body.approvalId}/decision`;
    await api
      .post(decisionRoute)
      .set('Authorization', 'Bearer executor')
      .send({ decision: 'ALLOW' })
      .expect(400);
    await api
      .post(decisionRoute)
      .set('Authorization', 'Bearer executor')
      .send({ decision: 'ALLOWED' })
      .expect(201);
    const polled = await api
      .get(`/v1/desktop/approvals/${created.body.approvalId}`)
      .set('Authorization', 'Bearer device')
      .expect(200);
    assert.deepEqual(polled.body, { status: 'ALLOWED', expiresAt: created.body.expiresAt });
    await api
      .post(decisionRoute)
      .set('Authorization', 'Bearer executor')
      .send({ decision: 'DENIED' })
      .expect(409);
  } finally {
    await app.close();
  }
});
