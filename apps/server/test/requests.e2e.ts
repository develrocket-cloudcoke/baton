import assert from 'node:assert/strict';
import test from 'node:test';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

const teamId = '00000000-0000-4000-8000-000000000001';
let infraId: string;
let app: any;
let prisma: PrismaService;
let a: string;
let b: string;
let c: string;
let bId: string;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

test.before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
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
  const userC = await prisma.user.create({
    data: {
      email: 'c@baton.local',
      displayName: 'C',
      passwordHash: (await prisma.user.findUniqueOrThrow({ where: { email: 'a@baton.local' } }))
        .passwordHash,
    },
  });
  await prisma.teamMembership.create({ data: { teamId, userId: userC.id } });
  c = await login('c@baton.local');
  bId = (await prisma.user.findUniqueOrThrow({ where: { email: 'b@baton.local' } })).id;
});
test.after(async () => {
  await app.close();
});

test('요청의 반려·새 revision·재전송·수락 및 권한/상태 가드를 검증한다', async () => {
  const draft = await request(app.getHttpServer())
    .post('/v1/requests')
    .set(auth(a))
    .send({
      senderTeamId: teamId,
      recipientTeamId: infraId,
      recipientUserId: bId,
      title: 'E2E 요청',
      originalInstruction: '초기 지시',
    })
    .expect(201);
  const id = draft.body.id;
  assert.equal(draft.body.state, 'DRAFT');
  await request(app.getHttpServer()).post(`/v1/requests/${id}/accept`).set(auth(b)).expect(409);
  const doc = await request(app.getHttpServer())
    .post(`/v1/requests/${id}/documents`)
    .set(auth(a))
    .send({ name: '요구사항.md', content: '# 요구사항' })
    .expect(201);
  await request(app.getHttpServer())
    .patch(`/v1/requests/${id}/draft`)
    .set(auth(a))
    .send({ documentVersionIds: [doc.body.version.id] })
    .expect(200);
  await request(app.getHttpServer()).post(`/v1/requests/${id}/send`).set(auth(a)).expect(201);
  await request(app.getHttpServer()).get(`/v1/requests/${id}`).set(auth(c)).expect(403);
  await request(app.getHttpServer())
    .post(`/v1/requests/${id}/review/start`)
    .set(auth(b))
    .expect(201);
  await request(app.getHttpServer())
    .post(`/v1/requests/${id}/return`)
    .set(auth(b))
    .send({ reason: '근거를 보완해 주세요.' })
    .expect(201);
  const revision = await request(app.getHttpServer())
    .post(`/v1/requests/${id}/revisions`)
    .set(auth(a))
    .send({ originalInstruction: '보완 지시', documentVersionIds: [doc.body.version.id] })
    .expect(201);
  assert.equal(revision.body.revisionNo, 2);
  await request(app.getHttpServer()).post(`/v1/requests/${id}/resend`).set(auth(a)).expect(201);
  await request(app.getHttpServer())
    .post(`/v1/requests/${id}/review/start`)
    .set(auth(b))
    .expect(201);
  const accepted = await request(app.getHttpServer())
    .post(`/v1/requests/${id}/accept`)
    .set(auth(b))
    .expect(201);
  assert.equal(accepted.body.state, 'ACCEPTED');
  const timeline = await request(app.getHttpServer())
    .get(`/v1/requests/${id}/timeline`)
    .set(auth(a))
    .expect(200);
  const events = timeline.body.map((event: any) => event.eventType);
  assert.deepEqual(events, [
    'request.created',
    'request.revision_created',
    'document.created',
    'document.version_created',
    'request.sent',
    'request.delivered',
    'request.viewed',
    'request.review_started',
    'request.returned',
    'request.revision_created',
    'request.resent',
    'request.delivered',
    'request.viewed',
    'request.review_started',
    'request.accepted',
  ]);
});
