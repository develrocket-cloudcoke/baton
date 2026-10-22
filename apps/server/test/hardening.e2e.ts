import assert from 'node:assert/strict';
import test from 'node:test';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { webUrlBase } from '../src/desktop/outbox-events';
let app: any, db: PrismaService;
let a: string, b: string, bId: string, device: any, agentId: string, projectId: string;
const auth = (token: string): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {};
const post = (path: string, token: string, body: any = {}) =>
  request(app.getHttpServer()).post(`/v1/${path}`).set(auth(token)).send(body);
const get = (path: string, token: string) =>
  request(app.getHttpServer()).get(`/v1/${path}`).set(auth(token));
const info = { platform: 'darwin', osVersion: '15.0', appVersion: '0.2', hostname: 'w6-mac' };
async function code() {
  return (await post('me/pairing-codes', b).expect(201)).body.code;
}
async function stream(token: string) {
  const controller = new AbortController();
  const response = await fetch(`${await app.getUrl()}/v1/desktop/events/stream`, {
    headers: auth(token),
    signal: controller.signal,
  });
  const events: string[] = [];
  let ended = false;
  const reading = (async () => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop()!;
        events.push(...parts);
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      ended = true;
    }
  })();
  async function wait(check: () => boolean) {
    const deadline = Date.now() + 3000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`SSE timeout: ${events.join('|')}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  await wait(() => events.some((e) => e.includes('connection.ready')));
  return {
    events,
    wait,
    ended: () => ended,
    close: async () => {
      controller.abort();
      await reading;
    },
  };
}
test.before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  db = app.get(PrismaService);
  a = (await post('auth/login', '', { email: 'a@baton.local', password: 'baton-dev-password' }))
    .body.token;
  b = (await post('auth/login', '', { email: 'b@baton.local', password: 'baton-dev-password' }))
    .body.token;
  bId = (await db.user.findUniqueOrThrow({ where: { email: 'b@baton.local' } })).id;
  device = (
    await post('devices/pair', '', { code: await code(), deviceName: 'W6 device', ...info }).expect(
      201,
    )
  ).body;
  agentId = (await post('desktop/agents', device.deviceToken, {}).expect(201)).body.agentId;
  projectId = (await post('desktop/projects', device.deviceToken, { agentId }).expect(201)).body
    .projectId;
});
test.after(async () => app.close());

test('pair 정보·userId 및 heartbeat와 DB presence 만료·복구', async () => {
  assert.equal(device.userId, bId);
  let row = (await get('me/devices', b).expect(200)).body.find(
    (d: any) => d.id === device.deviceId,
  );
  for (const [key, value] of Object.entries(info)) assert.equal(row[key], value);
  await post('desktop/heartbeat', 'invalid').expect(401);
  await post('desktop/heartbeat', device.deviceToken, { appVersion: '0.3', agentId }).expect(201);
  assert.equal(
    (await db.device.findUniqueOrThrow({ where: { id: device.deviceId } })).appVersion,
    '0.3',
  );
  assert.ok((await db.agent.findUniqueOrThrow({ where: { id: agentId } })).lastSeenAt);
  const stale = new Date(Date.now() - 121_000);
  await db.agent.update({ where: { id: agentId }, data: { lastSeenAt: stale, status: 'BUSY' } });
  await db.device.update({ where: { id: device.deviceId }, data: { lastSeenAt: stale } });
  row = (await get('me/devices', b).expect(200)).body.find((d: any) => d.id === device.deviceId);
  assert.equal(row.status, 'OFFLINE');
  assert.equal((await db.agent.findUniqueOrThrow({ where: { id: agentId } })).status, 'OFFLINE');
  await post('desktop/heartbeat', device.deviceToken, { agentId }).expect(201);
  const agent = (await get('agents', b).expect(200)).body.find((d: any) => d.id === agentId);
  assert.equal(agent.status, 'ONLINE');
  assert.ok(agent.lastSeenAt);
  await db.agent.update({ where: { id: agentId }, data: { status: 'BUSY' } });
  await post('desktop/heartbeat', device.deviceToken, { agentId }).expect(201);
  assert.equal((await db.agent.findUniqueOrThrow({ where: { id: agentId } })).status, 'BUSY');
});

test('실제 HTTP SSE 중복 연결 종료·재-pairing 성공 회전·실패 연결 보존', async () => {
  const first = await stream(device.deviceToken);
  const second = await stream(device.deviceToken);
  try {
    await first.wait(first.ended);
    assert.ok(first.events.some((e) => e.includes('connection.replaced') && e.includes('reason')));
    assert.equal(second.ended(), false);
    await post('devices/pair', device.deviceToken, {
      code: 'AAAA-AAAA',
      deviceName: '실패',
    }).expect(403);
    assert.equal(second.ended(), false);
    const oldToken = device.deviceToken;
    device = (
      await post('devices/pair', oldToken, {
        code: await code(),
        deviceName: '회전',
        ...info,
      }).expect(201)
    ).body;
    await second.wait(second.ended);
    await post('desktop/heartbeat', oldToken).expect(401);
    await post('desktop/heartbeat', device.deviceToken, { agentId }).expect(201);
    assert.equal(
      (await db.agent.findUniqueOrThrow({ where: { id: agentId } })).deviceId,
      device.deviceId,
    );
  } finally {
    await first.close();
    await second.close();
  }
});

async function execution() {
  const backend = await db.team.findFirstOrThrow({ where: { name: 'backend' } });
  const infra = await db.team.findFirstOrThrow({ where: { name: 'infra', orgId: backend.orgId } });
  const draft = (
    await post('requests', a, {
      senderTeamId: backend.id,
      recipientTeamId: infra.id,
      recipientUserId: bId,
      title: 'W6 취소',
      originalInstruction: '취소 검증',
    }).expect(201)
  ).body;
  await post(`requests/${draft.id}/send`, a).expect(201);
  await post(`requests/${draft.id}/review/start`, b).expect(201);
  await post(`requests/${draft.id}/accept`, b).expect(201);
  return (await post(`requests/${draft.id}/executions`, b, { agentId, projectId }).expect(201))
    .body;
}
test('QUEUED·RUNNING 취소·권한·중복 취소·재실행·늦은 결과를 검증한다', async () => {
  for (const running of [false, true]) {
    const ex = await execution();
    if (running)
      await post(`desktop/executions/${ex.id}/status`, device.deviceToken, {
        status: 'RUNNING',
      }).expect(201);
    await post(`executions/${ex.id}/cancel`, a).expect(403);
    const cancelled = await post(`executions/${ex.id}/cancel`, b).expect(201);
    assert.equal(cancelled.body.status, 'CANCELLED');
    assert.equal(
      (await db.request.findUniqueOrThrow({ where: { id: ex.requestId } })).state,
      'READY_TO_RUN',
    );
    await post(`executions/${ex.id}/cancel`, b).expect(409);
    const event = await db.outboxEvent.findFirstOrThrow({
      where: { executionId: ex.id, eventName: 'execution.command.cancel_requested' },
    });
    assert.equal(event.deviceId, device.deviceId);
    assert.equal(
      await db.timelineEvent.count({
        where: { executionId: ex.id, eventType: 'execution.cancelled' },
      }),
      1,
    );
    const retry = (
      await post(`requests/${ex.requestId}/executions`, b, { agentId, projectId }).expect(201)
    ).body;
    await post(`desktop/executions/${ex.id}/status`, device.deviceToken, {
      status: 'RUNNING',
    }).expect(409);
    await post(`desktop/executions/${retry.id}/status`, device.deviceToken, {
      status: 'RUNNING',
    }).expect(201);
    await post(`desktop/executions/${ex.id}/result`, device.deviceToken, {
      status: 'SUCCEEDED',
      summary: '늦은 결과',
    }).expect(409);
    await post(`executions/${retry.id}/cancel`, b).expect(201);
  }
});

test('취소와 결과 동시 경합은 하나만 성공하고 최종 상태를 보존한다', async () => {
  const ex = await execution();
  await post(`desktop/executions/${ex.id}/status`, device.deviceToken, {
    status: 'RUNNING',
  }).expect(201);
  const responses = await Promise.all([
    post(`executions/${ex.id}/cancel`, b),
    post(`desktop/executions/${ex.id}/result`, device.deviceToken, {
      status: 'SUCCEEDED',
      summary: '경합 결과',
    }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  const saved = await db.execution.findUniqueOrThrow({
    where: { id: ex.id },
    include: { request: true },
  });
  assert.equal(
    saved.request.state,
    saved.status === 'CANCELLED' ? 'READY_TO_RUN' : 'RESULT_REVIEW',
  );
});

test('WEB_URL은 CORS origin의 영향을 받지 않는다', () => {
  const old = process.env.WEB_URL,
    origin = process.env.WEB_ORIGIN;
  try {
    process.env.WEB_URL = 'http://127.0.0.1:3210/';
    process.env.WEB_ORIGIN = 'http://localhost:3000';
    assert.equal(webUrlBase(), 'http://127.0.0.1:3210');
    delete process.env.WEB_URL;
    assert.equal(webUrlBase(), 'http://localhost:3000');
  } finally {
    if (old === undefined) delete process.env.WEB_URL;
    else process.env.WEB_URL = old;
    if (origin === undefined) delete process.env.WEB_ORIGIN;
    else process.env.WEB_ORIGIN = origin;
  }
});
