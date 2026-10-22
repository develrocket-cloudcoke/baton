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
async function initial() {
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
      agentId,
      projectId,
      additionalInstruction: '첫 실행 지시',
    }).expect(201)
  ).body;
  await post(`desktop/executions/${ex.id}/status`, token, { status: 'RUNNING' }).expect(201);
  return { id: draft.id, ex };
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
      .send({ code, deviceName: 'CLO-11' })
      .expect(201)
  ).body.deviceToken;
  agentId = (await post('desktop/agents', token).expect(201)).body.agentId;
  projectId = (await post('desktop/projects', token, { agentId }).expect(201)).body.projectId;
});
test.after(async () => app.close());

test('취소 부분 결과·patch 저장 → 늦은 재보고 → 재실행 최종 결과 승인', async () => {
  const { id, ex } = await initial();
  await post(`desktop/executions/${ex.id}/result`, token, {
    status: 'CANCELLED',
    summary: '취소 전 보고',
  }).expect(409);
  await post(`executions/${ex.id}/cancel`, b).expect(201);
  const req = await db.request.findUniqueOrThrow({ where: { id } });
  const artifact = await db.artifact.create({
    data: {
      teamId: req.senderTeamId,
      requestId: id,
      ownerUserId: bId,
      kind: 'PATCH',
      filename: 'partial.patch',
      mimeType: 'text/x-diff',
      storageRef: 'partial-test.patch',
      sha256: 'a'.repeat(64),
      sizeBytes: 120,
    },
  });
  await post(`desktop/executions/${ex.id}/result`, token, {
    status: 'CANCELLED',
    artifactIds: ['00000000-0000-4000-8000-000000000099'],
  }).expect(403);
  const body = {
    status: 'CANCELLED',
    summary: '테스트 완료 전 취소',
    changedFiles: ['src/partial.ts'],
    artifactIds: [artifact.id],
  };
  const partial = (await post(`desktop/executions/${ex.id}/result`, token, body).expect(201)).body;
  assert.equal(partial.kind, 'PARTIAL');
  assert.deepEqual(partial.artifactIds, [artifact.id]);
  let detail = (await get(`requests/${id}`).expect(200)).body;
  assert.equal(detail.state, 'READY_TO_RUN');
  assert.equal(detail.latestResult, null);
  assert.equal(detail.executions[0].status, 'CANCELLED');
  assert.equal(detail.results[0].kind, 'PARTIAL');
  // 감사 타임라인에도 부분 결과 도착이 한 줄 남는다 (승인 이벤트와 구분된다)
  assert.equal(
    detail.timelineEvents.filter((e: any) => e.eventType === 'result.partial_reported').length,
    1,
  );
  await post(`results/${partial.id}/approve-and-send`, b).expect(409);
  const retry = (await post(`requests/${id}/executions`, b, { agentId, projectId }).expect(201))
    .body;
  await post(`desktop/executions/${retry.id}/status`, token, { status: 'RUNNING' }).expect(201);
  const repeated = (await post(`desktop/executions/${ex.id}/result`, token, body).expect(201)).body;
  assert.equal(repeated.id, partial.id);
  assert.equal((await get(`requests/${id}`).expect(200)).body.state, 'RUNNING');
  const final = (
    await post(`desktop/executions/${retry.id}/result`, token, {
      status: 'SUCCEEDED',
      summary: '최종 완료',
    }).expect(201)
  ).body;
  assert.equal(final.kind, 'FINAL');
  await post(`results/${partial.id}/approve-and-send`, b).expect(409);
  await post(`results/${final.id}/approve-and-send`, b).expect(201);
  await post(`desktop/executions/${ex.id}/result`, token, body).expect(201);
  detail = (await get(`requests/${id}`).expect(200)).body;
  assert.equal(detail.state, 'COMPLETED');
  assert.equal(detail.latestResult.id, final.id);
  assert.deepEqual(
    detail.results.map((r: any) => r.kind),
    ['PARTIAL', 'FINAL'],
  );
  assert.equal(await db.result.count({ where: { executionId: ex.id } }), 1);
  await post(`desktop/executions/${retry.id}/result`, token, body).expect(409);
});
