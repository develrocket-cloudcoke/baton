import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

let app: any;
let prisma: PrismaService;
let admin: string;
let a: string;
let b: string;
let backend: string;
let infra: string;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = () => request(app.getHttpServer());
test.before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  prisma = app.get(PrismaService);
  const login = async (email: string) =>
    (await api().post('/v1/auth/login').send({ email, password: 'baton-dev-password' }).expect(201))
      .body.token;
  admin = await login('admin@baton.local');
  a = await login('a@baton.local');
  b = await login('b@baton.local');
  backend = (await prisma.team.findFirstOrThrow({ where: { name: 'backend' } })).id;
  infra = (await prisma.team.findFirstOrThrow({ where: { name: 'infra' } })).id;
});
test.after(async () => app?.close());

test('조직 관리자·자기 팀 리더·일반 팀원 권한과 조직 경계를 검증한다', async () => {
  const me = (await api().get('/v1/me').set(auth(a)).expect(200)).body;
  assert.equal(me.organization.slug, 'example');
  assert.equal(me.orgRole, 'MEMBER');
  assert.equal(me.teams.find((team: any) => team.id === backend).role, 'TEAM_LEAD');
  assert.equal(me.passwordHash, undefined);
  await api().get('/v1/org').expect(401);
  for (const token of [a, b]) {
    await api().post('/v1/org/teams').set(auth(token)).send({ name: 'denied' }).expect(403);
    await api()
      .patch(`/v1/org/teams/${backend}`)
      .set(auth(token))
      .send({ name: 'denied' })
      .expect(403);
    await api().delete(`/v1/org/teams/${backend}`).set(auth(token)).expect(403);
    await api()
      .post('/v1/org/users')
      .set(auth(token))
      .send({ email: 'denied@baton.local', displayName: 'X', temporaryPassword: 'password-123' })
      .expect(403);
    await api()
      .post('/v1/org/team-links')
      .set(auth(token))
      .send({ teamAId: backend, teamBId: infra })
      .expect(403);
    await api().patch('/v1/org').set(auth(token)).send({ name: 'denied' }).expect(403);
  }
  const email = `org-member-${randomUUID()}@baton.local`;
  const user = (
    await api()
      .post('/v1/org/users')
      .set(auth(admin))
      .send({ email, displayName: '새 팀원', temporaryPassword: 'password-123' })
      .expect(201)
  ).body;
  assert.equal(user.passwordHash, undefined);
  await api()
    .post('/v1/org/users')
    .set(auth(admin))
    .send({ email, displayName: '중복', temporaryPassword: 'password-123' })
    .expect(409);
  await api().post(`/v1/org/teams/${backend}/members`).set(auth(b)).send({ email }).expect(403);
  await api().post(`/v1/org/teams/${infra}/members`).set(auth(a)).send({ email }).expect(403);
  await api().post(`/v1/org/teams/${backend}/members`).set(auth(a)).send({ email }).expect(201);
  await api().post(`/v1/org/teams/${infra}/members`).set(auth(admin)).send({ email }).expect(201);
  assert.equal(await prisma.teamMembership.count({ where: { userId: user.id } }), 2);
  await api().delete(`/v1/org/teams/${backend}/members`).set(auth(b)).send({ email }).expect(403);
  await api().delete(`/v1/org/teams/${backend}/members`).set(auth(a)).send({ email }).expect(200);
  await api().delete(`/v1/org/teams/${infra}/members`).set(auth(admin)).send({ email }).expect(200);
  const outsider = await prisma.user.create({
    data: {
      email: `other-${randomUUID()}@baton.local`,
      displayName: '외부',
      passwordHash: 'unused',
    },
  });
  const other = await prisma.organization.create({
    data: { name: '다른 조직', slug: randomUUID(), createdByUserId: outsider.id },
  });
  const otherTeam = await prisma.team.create({
    data: { orgId: other.id, name: '외부 팀', createdByUserId: outsider.id },
  });
  await api()
    .post(`/v1/org/teams/${backend}/members`)
    .set(auth(admin))
    .send({ email: outsider.email })
    .expect(403);
  await api()
    .patch(`/v1/org/teams/${otherTeam.id}`)
    .set(auth(admin))
    .send({ name: '침범' })
    .expect(403);
  await api()
    .post('/v1/org/team-links')
    .set(auth(admin))
    .send({ teamAId: backend, teamBId: otherTeam.id })
    .expect(403);
  const teams = (await api().get('/v1/org/teams').set(auth(admin)).expect(200)).body;
  assert.ok(!teams.some((team: any) => team.id === otherTeam.id));
  assert.ok(!JSON.stringify(teams).includes('passwordHash'));
  assert.ok(
    await prisma.timelineEvent.count({
      where: { eventType: 'team.member_added', actorUserId: me.id, requestId: null },
    }),
  );
});

test('팀 CRUD와 양방향 링크 생성·재생성·해제가 원자적으로 처리된다', async () => {
  const name = `qa-${randomUUID()}`;
  const team = (await api().post('/v1/org/teams').set(auth(admin)).send({ name }).expect(201)).body;
  await api().post('/v1/org/teams').set(auth(admin)).send({ name }).expect(409);
  await api()
    .patch(`/v1/org/teams/${team.id}`)
    .set(auth(admin))
    .send({ name: `${name}-renamed` })
    .expect(200);
  await api()
    .post('/v1/org/team-links')
    .set(auth(admin))
    .send({ teamAId: team.id, teamBId: team.id })
    .expect(400);
  const body = { teamAId: backend, teamBId: team.id };
  const rows = (await api().post('/v1/org/team-links').set(auth(admin)).send(body).expect(201))
    .body;
  assert.equal(rows.length, 2);
  assert.deepEqual(
    new Set(rows.map((row: any) => `${row.fromTeamId}:${row.toTeamId}`)),
    new Set([`${backend}:${team.id}`, `${team.id}:${backend}`]),
  );
  await api().post('/v1/org/team-links').set(auth(admin)).send(body).expect(201);
  assert.equal(
    await prisma.teamLink.count({
      where: { OR: [{ fromTeamId: team.id }, { toTeamId: team.id }] },
    }),
    2,
  );
  await api().delete(`/v1/org/team-links/${rows[0].id}`).set(auth(a)).expect(403);
  await api().delete(`/v1/org/team-links/${rows[1].id}`).set(auth(admin)).expect(200);
  assert.equal(
    await prisma.teamLink.count({
      where: { OR: [{ fromTeamId: team.id }, { toTeamId: team.id }] },
    }),
    0,
  );
  await api().delete(`/v1/org/teams/${team.id}`).set(auth(admin)).expect(200);
});

test('pairing은 발급자 본인에게만 연결되며 만료·재사용·동시 소비와 디바이스 해제를 검증한다', async () => {
  const userA = (await api().get('/v1/me').set(auth(a)).expect(200)).body;
  const issued = (await api().post('/v1/me/pairing-codes').set(auth(a)).expect(201)).body;
  assert.match(issued.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.ok(new Date(issued.expiresAt).getTime() <= Date.now() + 600000);
  const stored = await prisma.pairingCode.findUniqueOrThrow({
    where: { codeHash: createHash('sha256').update(issued.code).digest('hex') },
  });
  assert.notEqual(stored.codeHash, issued.code);
  const paired = (
    await api()
      .post('/v1/devices/pair')
      .set(auth(b))
      .send({ code: issued.code, deviceName: 'A Mac' })
      .expect(201)
  ).body;
  assert.equal(
    (await prisma.device.findUniqueOrThrow({ where: { id: paired.deviceId } })).userId,
    userA.id,
  );
  await api()
    .post('/v1/devices/pair')
    .send({ code: issued.code, deviceName: '재사용' })
    .expect(403);
  const expired = (await api().post('/v1/me/pairing-codes').set(auth(a)).expect(201)).body;
  await prisma.pairingCode.update({
    where: { codeHash: createHash('sha256').update(expired.code).digest('hex') },
    data: { expiresAt: new Date(0) },
  });
  await api().post('/v1/devices/pair').send({ code: expired.code, deviceName: '만료' }).expect(403);
  const concurrent = (await api().post('/v1/me/pairing-codes').set(auth(a)).expect(201)).body;
  const results = await Promise.all(
    [1, 2].map(() =>
      api().post('/v1/devices/pair').send({ code: concurrent.code, deviceName: '동시' }),
    ),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 403]);
  const devices = (await api().get('/v1/me/devices').set(auth(a)).expect(200)).body;
  assert.ok(devices.some((device: any) => device.id === paired.deviceId));
  assert.ok(!JSON.stringify(devices).includes('tokenHash'));
  await api().delete(`/v1/me/devices/${paired.deviceId}`).set(auth(b)).expect(404);
  await api()
    .post('/v1/desktop/agents')
    .set(auth(paired.deviceToken))
    .send({ displayName: 'A agent' })
    .expect(201);
  await api().delete(`/v1/me/devices/${paired.deviceId}`).set(auth(a)).expect(200);
  await api().post('/v1/desktop/agents').set(auth(paired.deviceToken)).send({}).expect(401);
  assert.ok(
    !(await api().get('/v1/me/devices').set(auth(a)).expect(200)).body.some(
      (device: any) => device.id === paired.deviceId,
    ),
  );
  const event = await prisma.timelineEvent.findFirstOrThrow({
    where: { actorUserId: userA.id, eventType: 'device.paired' },
  });
  assert.equal(event.requestId, null);
});
