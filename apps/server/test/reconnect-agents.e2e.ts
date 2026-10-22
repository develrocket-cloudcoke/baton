import assert from 'node:assert/strict';
import test from 'node:test';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { DesktopController } from '../src/desktop/desktop.controller';
import { firstValueFrom, takeWhile, toArray } from 'rxjs';
let app: any,
  db: PrismaService,
  a: string,
  b: string,
  token: string,
  deviceId: string,
  agentId: string;
const post = (path: string, auth: string, body = {}) =>
  request(app.getHttpServer())
    .post(`/v1/${path}`)
    .set('Authorization', `Bearer ${auth}`)
    .send(body);
async function replay(cursor?: string) {
  return firstValueFrom(
    app
      .get(DesktopController)
      .events(`Bearer ${token}`, cursor)
      .pipe(
        takeWhile((event: any) => event.type !== 'connection.ready'),
        toArray(),
      ),
  ) as Promise<any[]>;
}
test.before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  db = app.get(PrismaService);
  a = (await post('auth/login', '', { email: 'a@baton.local', password: 'baton-dev-password' }))
    .body.token;
  b = (await post('auth/login', '', { email: 'b@baton.local', password: 'baton-dev-password' }))
    .body.token;
  const code = (await post('me/pairing-codes', a)).body.code;
  const device = (
    await request(app.getHttpServer())
      .post('/v1/devices/pair')
      .send({ code, deviceName: 'CLO-12-13' })
      .expect(201)
  ).body;
  token = device.deviceToken;
  deviceId = device.deviceId;
});
test.after(async () => app.close());
test('동시 등록 재사용·기존 중복 정리·보고 Agent heartbeat·소유자 비활성화', async () => {
  const registered = await Promise.all([
    post('desktop/agents', token),
    post('desktop/agents', token),
  ]);
  assert.deepEqual(
    registered.map((r) => r.status),
    [201, 201],
  );
  assert.equal(registered[0].body.agentId, registered[1].body.agentId);
  agentId = registered[0].body.agentId;
  const canonical = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
  const ghost = await db.agent.create({
    data: { deviceId, ownerUserId: canonical.ownerUserId, displayName: 'ghost', status: 'ONLINE' },
  });
  await request(app.getHttpServer())
    .get('/v1/agents')
    .set('Authorization', `Bearer ${a}`)
    .expect(200);
  assert.equal((await db.agent.findUniqueOrThrow({ where: { id: ghost.id } })).status, 'DISABLED');
  const stale = new Date(0);
  await db.agent.update({ where: { id: agentId }, data: { lastSeenAt: stale, status: 'OFFLINE' } });
  await post('desktop/heartbeat', token).expect(201);
  assert.equal(
    (await db.agent.findUniqueOrThrow({ where: { id: agentId } })).lastSeenAt!.getTime(),
    0,
  );
  await post('desktop/heartbeat', token, { agentId }).expect(201);
  assert.equal((await db.agent.findUniqueOrThrow({ where: { id: agentId } })).status, 'ONLINE');
  await post('desktop/heartbeat', token, { agentId: ghost.id }).expect(403);
  await request(app.getHttpServer())
    .delete(`/v1/agents/${agentId}`)
    .set('Authorization', `Bearer ${b}`)
    .expect(403);
  await request(app.getHttpServer())
    .delete(`/v1/agents/${ghost.id}`)
    .set('Authorization', `Bearer ${a}`)
    .expect(200);
  await request(app.getHttpServer())
    .delete(`/v1/agents/${agentId}`)
    .set('Authorization', `Bearer ${a}`)
    .expect(200);
  await post('desktop/heartbeat', token, { agentId }).expect(403);
  await request(app.getHttpServer())
    .patch(`/v1/desktop/agents/${agentId}/presence`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'ONLINE' })
    .expect(403);
  agentId = (await post('desktop/agents', token).expect(201)).body.agentId;
  assert.notEqual(agentId, canonical.id);
});
test('replay는 최근24시간·최대500건 및 디바이스 소유 cursor만 사용한다', async () => {
  const now = Date.now();
  await db.outboxEvent.createMany({
    data: Array.from({ length: 510 }, (_, i) => ({
      deviceId,
      eventName: 'request.delivered',
      payload: { n: i },
      createdAt: new Date(now - 10000 + i),
    })),
  });
  const old = await db.outboxEvent.create({
    data: {
      deviceId,
      eventName: 'request.delivered',
      payload: {},
      createdAt: new Date(now - 25 * 3600000),
    },
  });
  const rows = await replay();
  assert.equal(rows.length, 500);
  assert.equal(rows[0].data.n, 10);
  assert.equal(rows.at(-1).data.n, 509);
  assert.ok(!rows.some((r) => r.id === old.id));
  assert.equal((await replay(rows.at(-1).id)).length, 0);
  const foreignDevice = await db.device.findFirstOrThrow({ where: { id: { not: deviceId } } });
  const foreign = await db.outboxEvent.create({
    data: {
      deviceId: foreignDevice.id,
      eventName: 'request.delivered',
      payload: {},
      createdAt: new Date(now + 10000),
    },
  });
  assert.equal((await replay(foreign.id)).length, 500);
});
test('SUCCEEDED·FAILED·CANCELLED 명령은 제외하고 활성 실행 명령만 재생한다', async () => {
  const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
  const team = await db.team.findFirstOrThrow({
    where: { memberships: { some: { userId: agent.ownerUserId } } },
  });
  const project = await db.project.create({
    data: { agentId, ownerUserId: agent.ownerUserId, displayName: 'replay' },
  });
  const req = await db.request.create({
    data: {
      senderTeamId: team.id,
      recipientTeamId: team.id,
      senderUserId: agent.ownerUserId,
      recipientUserId: agent.ownerUserId,
      title: 'replay',
    },
  });
  const rev = await db.requestRevision.create({
    data: {
      requestId: req.id,
      revisionNo: 1,
      originalInstruction: '',
      documentVersionIds: [],
      artifactIds: [],
      createdByUserId: agent.ownerUserId,
    },
  });
  const ids: Record<string, string> = {};
  for (const status of ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const) {
    const ex = await db.execution.create({
      data: {
        requestId: req.id,
        requestRevisionId: rev.id,
        executorUserId: agent.ownerUserId,
        agentId,
        projectId: project.id,
        additionalInstruction: '',
        effectiveInstructionRef: '',
        status,
      },
    });
    ids[status] = (
      await db.outboxEvent.create({
        data: {
          deviceId,
          executionId: ex.id,
          eventName: 'execution.command.requested',
          payload: { status },
        },
      })
    ).id;
  }
  const rows = await replay();
  for (const [status, id] of Object.entries(ids))
    assert.equal(
      rows.some((r) => r.id === id),
      ['QUEUED', 'RUNNING'].includes(status),
    );
  await request(app.getHttpServer())
    .delete(`/v1/agents/${agentId}`)
    .set('Authorization', `Bearer ${a}`)
    .expect(409);
  assert.notEqual(
    (await db.agent.findUniqueOrThrow({ where: { id: agentId } })).status,
    'DISABLED',
  );
});
