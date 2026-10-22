import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { NotificationsController } from '../src/notifications/notifications.controller';
import { firstValueFrom, filter, take, timeout } from 'rxjs';

let app: any;
let db: PrismaService;
let orgId: string, backend: string, infra: string, qa: string, foreign: string;
let a: string, b: string, c: string, aId: string, bId: string, cId: string;
let agentId: string, projectId: string;
const deviceToken = 'w5b-device-token';
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const post = (path: string, token: string, body = {}) =>
  request(app.getHttpServer()).post(`/v1/${path}`).set(auth(token)).send(body);
const get = (path: string, token: string) =>
  request(app.getHttpServer()).get(`/v1/${path}`).set(auth(token));
const draft = (extra = {}) => ({
  senderTeamId: backend,
  recipientTeamId: infra,
  recipientUserId: null,
  title: '팀 요청',
  originalInstruction: '실행 후 테스트',
  ...extra,
});
async function broadcast() {
  const created = await post('requests', a, draft()).expect(201);
  const id = created.body.id;
  await get(`requests/${id}`, b).expect(403);
  await post(`requests/${id}/send`, a).expect(201);
  await post(`requests/${id}/review/start`, b).expect(201);
  return id;
}
async function notification(token: string, eventName: string, id: string) {
  return firstValueFrom(
    app
      .get(NotificationsController)
      .events(`Bearer ${token}`, '')
      .pipe(
        filter((event: any) => event.type === eventName && event.data.requestId === id),
        take(1),
        timeout(3000),
      ),
  ) as Promise<any>;
}
test.before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  db = app.get(PrismaService);
  const passwordHash = (await db.user.findUniqueOrThrow({ where: { email: 'a@baton.local' } }))
    .passwordHash;
  const users = await Promise.all(
    ['a', 'b', 'c'].map((name) =>
      db.user.create({
        data: { email: `w5b-${name}@baton.local`, displayName: name.toUpperCase(), passwordHash },
      }),
    ),
  );
  [aId, bId, cId] = users.map((u) => u.id);
  orgId = (
    await db.organization.create({
      data: {
        name: 'W5b',
        slug: 'w5b',
        createdByUserId: aId,
        memberships: { create: users.map((u) => ({ userId: u.id })) },
      },
    })
  ).id;
  [backend, infra, qa] = await Promise.all(
    ['w5b-backend', 'w5b-infra', 'w5b-qa'].map(
      async (name) => (await db.team.create({ data: { orgId, name, createdByUserId: aId } })).id,
    ),
  );
  const other = await db.organization.create({
    data: { name: '외부', slug: 'w5b-other', createdByUserId: aId },
  });
  foreign = (
    await db.team.create({ data: { orgId: other.id, name: '외부 팀', createdByUserId: aId } })
  ).id;
  await db.teamMembership.createMany({
    data: [
      { teamId: backend, userId: aId },
      { teamId: infra, userId: bId },
      { teamId: infra, userId: cId },
      { teamId: infra, userId: aId },
    ],
  });
  await db.teamLink.create({
    data: { orgId, fromTeamId: backend, toTeamId: infra, createdByUserId: aId },
  });
  [a, b, c] = await Promise.all(
    users.map(
      async (u) =>
        (
          await post('auth/login', '', { email: u.email, password: 'baton-dev-password' }).expect(
            201,
          )
        ).body.token,
    ),
  );
  for (const userId of [aId, bId, cId]) {
    const token = userId === bId ? deviceToken : randomUUID();
    const device = await db.device.create({
      data: {
        userId,
        name: '팀 테스트',
        tokenHash: createHash('sha256').update(token).digest('hex'),
      },
    });
    if (userId === bId) {
      agentId = (
        await db.agent.create({
          data: { ownerUserId: bId, deviceId: device.id, displayName: 'B agent' },
        })
      ).id;
      projectId = (
        await db.project.create({ data: { ownerUserId: bId, agentId, displayName: 'W5b' } })
      ).id;
    }
  }
});
test.after(async () => app.close());

test('수신 목록·방향성 링크·조직·지정 팀원과 전송 시 권한을 검증한다', async () => {
  const allowed = await get(`recipients?senderTeamId=${backend}`, a).expect(200);
  assert.deepEqual(new Set(allowed.body.teams.map((t: any) => t.id)), new Set([backend, infra]));
  assert.deepEqual(
    new Set(allowed.body.teams.find((t: any) => t.id === infra).members.map((u: any) => u.id)),
    new Set([bId, cId]),
  );
  assert.equal(JSON.stringify(allowed.body).includes('passwordHash'), false);
  await get(`recipients?senderTeamId=${backend}`, b).expect(403);
  await get('recipients', a).expect(400);
  await post('requests', b, draft()).expect(403);
  await post('requests', a, draft({ recipientTeamId: qa })).expect(403);
  await post(
    'requests',
    a,
    draft({ recipientUserId: '00000000-0000-4000-8000-000000000099' }),
  ).expect(403);
  await post('requests', a, draft({ recipientTeamId: backend, recipientUserId: bId })).expect(403);
  await post('requests', a, draft({ recipientTeamId: foreign })).expect(403);
  await post('requests', b, draft({ senderTeamId: infra, recipientTeamId: backend })).expect(403);
  await post('requests', a, draft({ recipientTeamId: backend })).expect(201);
  const pending = await post('requests', a, draft()).expect(201);
  await db.teamLink.deleteMany({ where: { fromTeamId: backend, toTeamId: infra } });
  await post('requests', a, draft()).expect(403);
  await post(`requests/${pending.body.id}/send`, a).expect(403);
  assert.equal((await get(`recipients?senderTeamId=${backend}`, a)).body.teams.length, 1);
  await db.teamLink.create({
    data: { orgId, fromTeamId: backend, toTeamId: infra, createdByUserId: aId },
  });
});

test('팀 전달 알림·동시 claim 1성공/1충돌·처리자 inbox·늦은 실행을 검증한다', async () => {
  const id = await broadcast();
  for (const token of [b, c]) {
    const inbox = (await get('requests?box=inbox', token).expect(200)).body.find(
      (r: any) => r.id === id,
    );
    assert.equal(inbox.claimedBy, null);
    assert.equal(inbox.recipientTeam.name, 'w5b-infra');
    assert.equal((await notification(token, 'request.delivered', id)).data.requestId, id);
  }
  const delivered = await db.outboxEvent.findMany({
    where: { eventName: 'request.delivered', payload: { path: '$.requestId', equals: id } },
    include: { device: true },
  });
  assert.deepEqual(new Set(delivered.map((e) => e.device.userId)), new Set([bId, cId]));
  const responses = await Promise.all([
    post(`requests/${id}/accept`, b),
    post(`requests/${id}/accept`, c),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  assert.equal(responses.find((r) => r.status === 409)!.body.message, '이미 다른 팀원이 처리 중');
  const winner = responses[0].status === 201 ? bId : cId;
  const loser = winner === bId ? c : b;
  for (const token of [b, c]) {
    const inbox = (await get('requests?box=inbox', token).expect(200)).body.find(
      (r: any) => r.id === id,
    );
    assert.equal(inbox.claimedBy.id, winner);
    const detail = (await get(`requests/${id}`, token).expect(200)).body;
    assert.equal(detail.senderTeam.name, 'w5b-backend');
    assert.equal(detail.recipientTeam.name, 'w5b-infra');
  }
  assert.equal(
    await db.timelineEvent.count({ where: { requestId: id, eventType: 'request.claimed' } }),
    1,
  );
  const claimed = await db.outboxEvent.findMany({
    where: { eventName: 'request.claimed', payload: { path: '$.requestId', equals: id } },
    include: { device: true },
  });
  assert.deepEqual(
    claimed.map((e) => e.device.userId),
    [winner === bId ? cId : bId],
  );
  assert.equal((await notification(loser, 'request.claimed', id)).data.claimedBy.id, winner);
  for (const action of ['accept', 'return', 'reject', 'review/start'])
    await post(`requests/${id}/${action}`, loser, { reason: '늦음' }).expect(409);
  await post(`requests/${id}/executions`, loser, { agentId, projectId }).expect(409);
});

test('반려·거절도 claim하고 재전송은 확정된 사용자에게만 전달한다', async () => {
  for (const action of ['return', 'reject']) {
    const id = await broadcast();
    await post(`requests/${id}/${action}`, b, { reason: '보완 필요' }).expect(201);
    const saved = await db.request.findUniqueOrThrow({ where: { id } });
    assert.equal(saved.recipientUserId, bId);
    assert.ok(saved.claimedAt);
    if (action === 'return') {
      await post(`requests/${id}/revisions`, a, { originalInstruction: '보완 완료' }).expect(201);
      await post(`requests/${id}/resend`, a).expect(201);
      const events = await db.outboxEvent.findMany({
        where: { eventName: 'request.delivered', payload: { path: '$.requestId', equals: id } },
        include: { device: true },
      });
      assert.equal(events.filter((e) => e.device.userId === bId).length, 2);
      assert.equal(events.filter((e) => e.device.userId === cId).length, 1);
      await post(`requests/${id}/accept`, c).expect(409);
    }
  }
});

test('A backend → infra 전체 → B claim → 디바이스 실행 → 결과 승인 완료', async () => {
  const id = await broadcast();
  await post(`requests/${id}/accept`, b).expect(201);
  const execution = await post(`requests/${id}/executions`, b, { agentId, projectId }).expect(201);
  const executionId = execution.body.id;
  await post(`desktop/executions/${executionId}/status`, deviceToken, { status: 'RUNNING' }).expect(
    201,
  );
  const result = await post(`desktop/executions/${executionId}/result`, deviceToken, {
    status: 'SUCCEEDED',
    summary: '팀 요청 완료',
    changedFiles: [],
  }).expect(201);
  await post(`results/${result.body.id}/approve-and-send`, c).expect(409);
  await post(`results/${result.body.id}/approve-and-send`, b).expect(201);
  assert.equal((await get(`requests/${id}`, a).expect(200)).body.state, 'COMPLETED');
});

// W5d-2: 팀 간 요청의 문서·첨부 접근 (05 §11.2). 수신자는 발신 팀 소속이 아니므로 요청 접근 권한으로 판단한다.
async function attachDocumentAndFile(id: string) {
  const doc = await post(`requests/${id}/documents`, a, {
    name: 'analysis.md',
    content: '# 분석\n원인은 오타',
    changeNote: '초안',
  }).expect(201);
  const bytes = Buffer.from('FATAL redis-servcie\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ticket = await post('uploads', a, {
    teamId: backend,
    requestId: id,
    kind: 'REQUEST_ATTACHMENT',
    filename: 'server.log',
    mimeType: 'text/plain',
    sha256,
    sizeBytes: bytes.length,
  });
  assert.equal(ticket.status, 201, JSON.stringify(ticket.body));
  await request(app.getHttpServer())
    .put(ticket.body.uploadUrl)
    .set('content-type', 'text/plain')
    .send(bytes)
    .expect(200);
  await post(`uploads/${ticket.body.artifactId}/complete`, a, { sha256 }).expect(201);
  await request(app.getHttpServer())
    .patch(`/v1/requests/${id}/draft`)
    .set(auth(a))
    .send({
      documentVersionIds: [doc.body.currentVersionId],
      artifactIds: [ticket.body.artifactId],
    })
    .expect(200);
  return {
    versionId: doc.body.currentVersionId as string,
    artifactId: ticket.body.artifactId as string,
    bytes,
  };
}

test('팀 간 요청의 문서·첨부를 수신 팀원·확정 수신자·그 디바이스가 읽고, 디바이스가 결과를 올린다 (W5d-2)', async () => {
  const id = (await post('requests', a, draft()).expect(201)).body.id;
  const { versionId, artifactId, bytes } = await attachDocumentAndFile(id);
  await post(`requests/${id}/send`, a).expect(201);
  // 미확정 팀 요청: 수신 팀원 c 와 B 의 디바이스 모두 읽는다
  await get(`documents/versions/${versionId}`, c).expect(200);
  await get(`artifacts/${artifactId}`, c).expect(200);
  const download = await get(`documents/versions/${versionId}/download`, deviceToken).expect(200);
  assert.match(download.text, /원인은 오타/);
  const artifact = await get(`artifacts/${artifactId}`, deviceToken).expect(200);
  // 로컬 스토리지 다운로드는 JSON 직렬화된 Buffer 가 아니라 원문 바이트다
  const raw = await request(app.getHttpServer())
    .get(artifact.body.downloadUrl)
    .set(auth(deviceToken))
    .expect(200);
  assert.equal(Buffer.from(raw.body.length ? raw.body : raw.text).toString(), bytes.toString());
  // B 가 claim 한 뒤에도 B·B 디바이스는 물론 같은 팀 c 도 계속 읽는다 (받은 요청함에 남는다)
  await post(`requests/${id}/review/start`, b).expect(201);
  await post(`requests/${id}/accept`, b).expect(201);
  await get(`documents/versions/${versionId}`, b).expect(200);
  await get(`documents/versions/${versionId}/download`, deviceToken).expect(200);
  await get(`artifacts/${artifactId}`, c).expect(200);
  // 디바이스가 실행 결과(RESULT_ATTACHMENT)를 올린다 — 발신 팀 멤버십이 없어도 요청 접근 권한으로 허용
  const resultBytes = Buffer.from('# 결과\n수정 완료');
  await post('uploads', deviceToken, {
    teamId: backend,
    requestId: id,
    kind: 'RESULT_ATTACHMENT',
    filename: 'result.md',
    mimeType: 'text/markdown',
    sha256: createHash('sha256').update(resultBytes).digest('hex'),
    sizeBytes: resultBytes.length,
  }).expect(201);
  // 사람 지정 요청(A→B)의 문서는 같은 팀이라도 지정되지 않은 c 는 읽지 못한다
  const personal = (await post('requests', a, draft({ recipientUserId: bId })).expect(201)).body.id;
  const attached = await attachDocumentAndFile(personal);
  await post(`requests/${personal}/send`, a).expect(201);
  await get(`documents/versions/${attached.versionId}`, b).expect(200);
  await get(`documents/versions/${attached.versionId}`, c).expect(403);
  await get(`artifacts/${attached.artifactId}`, c).expect(403);
});

test('CLO-18 방향별 생성·해제·GET 상태와 요청 경로 검증', async () => {
  await db.orgMembership.update({
    where: { orgId_userId: { orgId, userId: aId } },
    data: { role: 'ORG_ADMIN' },
  });
  await db.teamLink.deleteMany({
    where: {
      orgId,
      OR: [
        { fromTeamId: backend, toTeamId: infra },
        { fromTeamId: infra, toTeamId: backend },
      ],
    },
  });
  const body = { teamAId: backend, teamBId: infra };
  await post('org/team-links', a, { ...body, direction: 'invalid' }).expect(400);
  const forward = (await post('org/team-links', a, { ...body, direction: 'a-to-b' }).expect(201))
    .body;
  assert.equal(forward.length, 1);
  const status = async () => (await get('org/team-links', a).expect(200)).body;
  assert.equal((await status())[0].direction, 'a-to-b');
  assert.equal((await status())[0].reverseAllowed, false);
  await post('requests', a, draft()).expect(201);
  await post('requests', b, draft({ senderTeamId: infra, recipientTeamId: backend })).expect(403);
  const reverse = (await post('org/team-links', a, { ...body, direction: 'b-to-a' }).expect(201))
    .body;
  assert.equal(reverse.length, 1);
  assert.equal(reverse[0].fromTeamId, infra);
  assert.ok((await status()).every((row: any) => row.direction === 'both' && row.reverseAllowed));
  await post('requests', b, draft({ senderTeamId: infra, recipientTeamId: backend })).expect(201);
  const remove = (id: string, body?: object) =>
    request(app.getHttpServer()).delete(`/v1/org/team-links/${id}`).set(auth(a)).send(body);
  await remove(forward[0].id, { direction: 'b-to-a' }).expect(200);
  assert.equal((await status()).length, 1);
  await post('requests', b, draft({ senderTeamId: infra, recipientTeamId: backend })).expect(403);
  await post('org/team-links', a, body).expect(201);
  await remove(forward[0].id, { direction: 'a-to-b' }).expect(200);
  assert.equal((await status())[0].fromTeamId, infra);
  await post('requests', a, draft()).expect(403);
  const remaining = (await status())[0];
  await remove(remaining.id).expect(200);
  assert.equal((await status()).length, 0);
  const events = await db.timelineEvent.findMany({
    where: { actorUserId: aId, eventType: 'team.link_revoked' },
  });
  assert.deepEqual(
    new Set(events.map((e) => (e.payload as any).direction)),
    new Set(['both', 'a-to-b', 'b-to-a']),
  );
  await post('org/team-links', a, { ...body, direction: 'a-to-b' }).expect(201);
});

test('CLO-19 팀 재뿌리기는 알림·outbox를 재발행하고 다른 팀원의 claim을 허용한다', async () => {
  const id = await broadcast();
  await post(`requests/${id}/return`, b, { reason: '보완' }).expect(201);
  await post(`requests/${id}/resend`, a, { reassign: 'team' }).expect(409);
  await post(`requests/${id}/revisions`, a, { originalInstruction: '보완 완료' }).expect(201);
  await post(`requests/${id}/resend`, a, { reassign: 'invalid' }).expect(400);
  await post(`requests/${id}/resend`, c, { reassign: 'team' }).expect(403);
  const responses = await Promise.all([
    post(`requests/${id}/resend`, a, { reassign: 'team' }),
    post(`requests/${id}/resend`, a, { reassign: 'team' }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  const sent = responses.find((r) => r.status === 201)!.body;
  assert.equal(sent.recipientUserId, null);
  assert.equal(sent.claimedAt, null);
  assert.equal(sent.state, 'SENT');
  const delivered = await db.outboxEvent.findMany({
    where: { eventName: 'request.delivered', payload: { path: '$.requestId', equals: id } },
    include: { device: true },
  });
  for (const userId of [bId, cId])
    assert.equal(delivered.filter((e) => e.device.userId === userId).length, 2);
  const revisionEvents = delivered.filter((e) => (e.payload as any).revisionNo === 2);
  assert.equal(revisionEvents.length, 2);
  assert.ok(revisionEvents.every((e) => (e.payload as any).recipientUserId === null));
  const timeline = (await get(`requests/${id}/timeline`, a).expect(200)).body;
  assert.equal(timeline.filter((e: any) => e.eventType === 'request.rebroadcast').length, 1);
  const delivery = timeline.find(
    (e: any) =>
      e.eventType === 'request.delivered' && e.requestRevisionId === sent.currentRevisionId,
  );
  assert.deepEqual(new Set(delivery.payload.recipientUserIds), new Set([bId, cId]));
  assert.equal((await notification(c, 'request.delivered', id)).data.requestId, id);
  await post(`requests/${id}/review/start`, c).expect(201);
  const claimed = (await post(`requests/${id}/accept`, c).expect(201)).body;
  assert.equal(claimed.recipientUserId, cId);
  assert.ok(claimed.claimedAt);
  await post(`requests/${id}/accept`, b).expect(409);
});

test('CLO-19 사람 지정 재뿌리기는 400이고 same 재전송은 유지한다', async () => {
  const id = (await post('requests', a, draft({ recipientUserId: bId })).expect(201)).body.id;
  await post(`requests/${id}/send`, a).expect(201);
  await post(`requests/${id}/review/start`, b).expect(201);
  await post(`requests/${id}/return`, b, { reason: '보완' }).expect(201);
  await post(`requests/${id}/revisions`, a, { originalInstruction: '보완 완료' }).expect(201);
  await post(`requests/${id}/resend`, a, { reassign: 'team' }).expect(400);
  const sent = (await post(`requests/${id}/resend`, a, { reassign: 'same' }).expect(201)).body;
  assert.equal(sent.recipientUserId, bId);
  assert.equal(sent.claimedAt, null);
  assert.equal(
    await db.timelineEvent.count({ where: { requestId: id, eventType: 'request.rebroadcast' } }),
    0,
  );
});
