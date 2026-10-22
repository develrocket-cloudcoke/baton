import assert from 'node:assert/strict';
import { webUrlBase } from '../src/desktop/outbox-events';
import test from 'node:test';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

const teamId = '00000000-0000-4000-8000-000000000001';
const agentId = '00000000-0000-4000-8000-000000000002';
const projectId = '00000000-0000-4000-8000-000000000003';
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
let infraId: string;
let app: any;
let prisma: PrismaService;
let a: string;
let b: string;
let bId: string;

async function acceptedRequest() {
  const draft = await request(app.getHttpServer())
    .post('/v1/requests')
    .set(auth(a))
    .send({
      senderTeamId: teamId,
      recipientTeamId: infraId,
      recipientUserId: bId,
      title: '실행 E2E',
      originalInstruction: '작업을 수행하세요.',
    })
    .expect(201);
  await request(app.getHttpServer())
    .post(`/v1/requests/${draft.body.id}/send`)
    .set(auth(a))
    .expect(201);
  await request(app.getHttpServer())
    .post(`/v1/requests/${draft.body.id}/review/start`)
    .set(auth(b))
    .expect(201);
  await request(app.getHttpServer())
    .post(`/v1/requests/${draft.body.id}/accept`)
    .set(auth(b))
    .expect(201);
  return draft.body.id;
}

test.before(async () => {
  app = await NestFactory.create(AppModule);
  await app.listen(0, '127.0.0.1');
  prisma = app.get(PrismaService);
  infraId = (await prisma.team.findFirstOrThrow({ where: { name: 'infra' } })).id;
  const login = async (email: string) =>
    (
      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ email, password: 'baton-dev-password' })
        .expect(201)
    ).body.token;
  a = await login('a@baton.local');
  b = await login('b@baton.local');
  bId = (await prisma.user.findUniqueOrThrow({ where: { email: 'b@baton.local' } })).id;
});
test.after(async () => app.close());

test('실행 명령·진행·결과 승인과 실패 재실행을 검증한다', async () => {
  const requestId = await acceptedRequest();
  const created = await request(app.getHttpServer())
    .post(`/v1/requests/${requestId}/executions`)
    .set(auth(b))
    .send({ agentId, projectId, additionalInstruction: '테스트도 실행' })
    .expect(201);
  const executionId = created.body.id;
  const command = await prisma.outboxEvent.findFirstOrThrow({ where: { executionId } });
  assert.equal(command.eventName, 'execution.command.requested');
  assert.deepEqual(command.payload, {
    eventName: 'execution.command.requested',
    eventId: executionId,
    executionId,
    requestId,
    requestRevisionId: (await prisma.execution.findUniqueOrThrow({ where: { id: executionId } }))
      .requestRevisionId,
    agentId,
    projectId,
    teamId,
    // 데스크톱 알림·프롬프트용 표시 정보 (W4 에서 추가)
    title: '실행 E2E',
    senderName: 'A',
    webUrl: `${webUrlBase()}/requests/${requestId}`,
    originalInstruction: '작업을 수행하세요.',
    additionalInstruction: '테스트도 실행',
    attachments: [],
    policy: {
      repository_edit: 'allow',
      deployment_apply: 'deny',
      network_outbound: 'deny',
      outside_write: 'deny',
      shell_execution: 'allow',
    },
    // CLO-108: 데몬 러너 게이트가 쓰는 승인 키 배열. Claude Code 는 강제 불가 항목이 없어 빈 배열이다.
    acknowledgedRisks: [],
    inheritedRiskKeys: [],
  });
  await request(app.getHttpServer())
    .post(`/v1/requests/${requestId}/executions`)
    .set(auth(b))
    .send({ agentId, projectId })
    .expect(409);
  await request(app.getHttpServer())
    .post(`/v1/desktop/executions/${executionId}/status`)
    .set({ Authorization: 'Bearer seed-device-token' })
    .send({ status: 'RUNNING' })
    .expect(201);
  await request(app.getHttpServer())
    .post(`/v1/desktop/executions/${executionId}/status`)
    .set({ Authorization: 'Bearer seed-device-token' })
    .send({ status: 'PROGRESS', phase: 'test', message: '테스트 실행 중' })
    .expect(201);
  const result = await request(app.getHttpServer())
    .post(`/v1/desktop/executions/${executionId}/result`)
    .set({ Authorization: 'Bearer seed-device-token' })
    .send({ status: 'SUCCEEDED', summary: '완료', changedFiles: ['src/a.ts'] })
    .expect(201);
  await request(app.getHttpServer())
    .post(`/v1/results/${result.body.id}/approve-and-send`)
    .set(auth(b))
    .expect(201);
  assert.equal(
    (await prisma.request.findUniqueOrThrow({ where: { id: requestId } })).state,
    'COMPLETED',
  );

  const retryRequestId = await acceptedRequest();
  const first = await request(app.getHttpServer())
    .post(`/v1/requests/${retryRequestId}/executions`)
    .set(auth(b))
    .send({ agentId, projectId })
    .expect(201);
  await request(app.getHttpServer())
    .post(`/v1/desktop/executions/${first.body.id}/status`)
    .set({ Authorization: 'Bearer seed-device-token' })
    .send({ status: 'RUNNING' })
    .expect(201);
  await request(app.getHttpServer())
    .post(`/v1/desktop/executions/${first.body.id}/result`)
    .set({ Authorization: 'Bearer seed-device-token' })
    .send({ status: 'FAILED', failureReason: '명령 실패' })
    .expect(201);
  assert.equal(
    (await prisma.execution.findUniqueOrThrow({ where: { id: first.body.id } })).status,
    'FAILED',
  );
  assert.equal(
    (await prisma.request.findUniqueOrThrow({ where: { id: retryRequestId } })).state,
    'FAILED',
  );
  assert.equal(
    await prisma.timelineEvent.count({
      where: { executionId: first.body.id, eventType: 'execution.failed' },
    }),
    1,
  );
  const retry = await request(app.getHttpServer())
    .post(`/v1/requests/${retryRequestId}/executions`)
    .set(auth(b))
    .send({ agentId, projectId })
    .expect(201);
  assert.equal(retry.body.previousExecutionId, first.body.id);
});
