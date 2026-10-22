import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { Daemon } from '../src/daemon';
import { DaemonStatusPayload } from '../src/ipc/messages';
import { LocalShellServices } from '../src/services/shell-services';
import { LocalSettingsStore } from '../src/settings/store';
import { ApiClient } from '../src/transport/api-client';
import { SseClient } from '../src/transport/sse-client';
import { hookCommand, postJson, startFakeServer, tmpDir, waitFor } from './helpers';

class RecordingShellServices extends LocalShellServices {
  statuses: DaemonStatusPayload[] = [];
  logs: { level: string; message: string }[] = [];
  override status(payload: DaemonStatusPayload): void {
    this.statuses.push(payload);
  }
  override log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.logs.push({ level, message });
  }
}

// 04 §11.2 중복 데몬: 서버가 '다른 연결로 대체됨' 사유로 끊으면 재연결하지 않고 셸에 알린 뒤 종료한다.
test('중복 데몬: connection.replaced 를 받으면 재연결하지 않고 셸에 알린 뒤 종료한다', async () => {
  const home = tmpDir('home');
  const serverLog: string[] = [];
  const fake = await startFakeServer({ log: (l) => serverLog.push(l) });
  const store = new LocalSettingsStore(home);
  store.apply({ serverUrl: fake.url(), deviceName: 'test-mac' });
  const services = new RecordingShellServices(store);
  const fatals: string[] = [];
  const daemon = new Daemon({ providers: ['CLAUDE_CODE'], services, hook: hookCommand(), home, statusIntervalMs: 60_000, heartbeatIntervalMs: 60_000, onFatal: (r) => fatals.push(r) });
  try {
    await daemon.start();
    await daemon.pair('BATON-PAIR-123');
    await waitFor(() => serverLog.some((l) => l.startsWith('SSE_CONNECTED')));
    const connectedCount = serverLog.filter((l) => l.startsWith('SSE_CONNECTED')).length;

    await postJson(`${fake.url()}/__test/supersede`, {});
    await waitFor(() => fatals.length === 1, 10_000);
    assert.match(fatals[0], /다른 데몬이 연결되어 이전 연결을 종료합니다/);
    assert.equal(daemon.currentState, 'idle');
    const last = services.statuses.filter((s) => s.lastError?.code === 'connection_replaced').pop();
    assert.ok(last, 'daemon.status 로 connection_replaced 를 알린다');
    assert.ok(services.logs.some((l) => l.level === 'error' && l.message.includes('다른 데몬이 이 디바이스에 연결되어 종료합니다')), '셸 로그');
    assert.equal(daemon.isStopped, true);

    // 재연결하지 않는다
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(serverLog.filter((l) => l.startsWith('SSE_CONNECTED')).length, connectedCount, 'SSE 재연결 없음');
  } finally {
    await daemon.shutdown();
    await fake.close();
  }
});

test('중복 데몬(실서버 동작): 디바이스당 SSE 1개 서버에 두 번째 연결이 붙으면 첫 연결이 대체 종료된다', async () => {
  const fake = await startFakeServer({ singleConnection: true });
  try {
    const api = new ApiClient(fake.url(), null);
    const paired = await api.pair('BATON-PAIR-123', 'dup-test');
    const fatals: string[] = [];
    // 데몬(Daemon.handleEvent)과 같게: connection.replaced 이벤트를 fatal 로 올린다
    const first: SseClient = new SseClient({
      url: `${fake.url()}/v1/desktop/events/stream`,
      token: paired.deviceToken,
      getLastEventId: () => '',
      onEvent: (e) => {
        if (e.type === 'connection.replaced') first.fatal(String(JSON.parse(e.data).reason));
      },
      onFatal: (r) => fatals.push(r),
      minBackoffMs: 50
    });
    first.idleReconnectMs = 0;
    first.start();
    await waitFor(() => first.connectCount === 1);

    // 두 번째 데몬이 붙는다 → 첫 연결에 connection.replaced 가 오고 끊긴다
    const second = new SseClient({ url: `${fake.url()}/v1/desktop/events/stream`, token: paired.deviceToken, getLastEventId: () => '', onEvent: () => undefined, minBackoffMs: 50 });
    second.idleReconnectMs = 0;
    second.start();
    await waitFor(() => fatals.length === 1, 10_000);
    assert.match(fatals[0], /다른 데몬이 연결되어 이전 연결을 종료합니다/);
    const before = first.connectCount;
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(first.connectCount, before, '첫 연결은 재연결하지 않는다');
    second.stop();
    first.stop();
  } finally {
    await fake.close();
  }
});

test('SSE: 409 는 재연결하지 않고 fatal, 401 은 백오프 재연결', async () => {
  // 서버가 "이 디바이스는 이미 다른 연결이 점유" 로 409 를 주는 경우 (실서버가 그렇게 바뀌어도 데몬이 루프에 빠지지 않도록)
  const conflict = http.createServer((req, res) => {
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: '다른 연결이 이미 이 디바이스를 점유하고 있습니다.' }));
  });
  await new Promise<void>((r) => conflict.listen(0, '127.0.0.1', () => r()));
  const port = (conflict.address() as { port: number }).port;
  const fatals: string[] = [];
  const sse = new SseClient({ url: `http://127.0.0.1:${port}/v1/desktop/events/stream`, token: 't', getLastEventId: () => '', onEvent: () => undefined, onFatal: (r) => fatals.push(r), minBackoffMs: 50 });
  sse.idleReconnectMs = 0;
  sse.start();
  await waitFor(() => fatals.length === 1, 5_000);
  assert.match(fatals[0], /409/);
  sse.stop();
  await new Promise<void>((r) => conflict.close(() => r()));

  // 401(토큰 문제) 은 fatal 이 아니라 백오프 재연결이다
  const fake = await startFakeServer();
  try {
    const unauthorizedFatals: string[] = [];
    const sse2 = new SseClient({ url: `${fake.url()}/v1/desktop/events/stream`, token: 'bogus-token', getLastEventId: () => '', onEvent: () => undefined, onFatal: (r) => unauthorizedFatals.push(r), minBackoffMs: 50 });
    sse2.idleReconnectMs = 0;
    sse2.start();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(unauthorizedFatals.length, 0);
    sse2.stop();
  } finally {
    await fake.close();
  }
});

// W6d 회귀: Nest @Sse 는 id 없는 제어 프레임에 **연결마다 1부터** 번호를 붙인다.
// 재연결 뒤 같은 번호로 오는 connection.replaced 가 멱등 캐시에 막혀 사라지면 중복 데몬을 못 잡는다.
test('중복 데몬: 재연결로 id 가 겹쳐도 connection.replaced 를 놓치지 않는다', async () => {
  const fake = await startFakeServer();
  try {
    const api = new ApiClient(fake.url(), null);
    const paired = await api.pair('BATON-PAIR-123', 'dup-id-test');
    const fatals: string[] = [];
    const seen: string[] = [];
    const sse: SseClient = new SseClient({
      url: `${fake.url()}/v1/desktop/events/stream`,
      token: paired.deviceToken,
      getLastEventId: () => '',
      onEvent: (e) => {
        seen.push(`${e.type}#${e.id}`);
        if (e.type === 'connection.replaced') sse.fatal(String(JSON.parse(e.data).reason));
      },
      onFatal: (r) => fatals.push(r),
      minBackoffMs: 50
    });
    sse.idleReconnectMs = 0;
    sse.start();
    await waitFor(() => sse.connectCount === 1);
    // 첫 연결에서 connection.ready(id 1) 를 받는다
    await waitFor(() => seen.includes('connection.ready#1'));

    // 소켓만 끊고 재연결 → 두 번째 연결도 connection.ready 를 id 1 로 다시 보낸다
    await postJson(`${fake.url()}/__test/disconnect`, {}, paired.deviceToken);
    await waitFor(() => sse.connectCount === 2);
    await waitFor(() => seen.filter((e) => e === 'connection.ready#1').length === 2, 10_000);

    // 이제 대체 종료를 보낸다 (id 2). 멱등 캐시가 제어 프레임을 막으면 안 된다.
    await postJson(`${fake.url()}/__test/supersede`, {});
    await waitFor(() => fatals.length === 1, 10_000);
    assert.match(fatals[0], /다른 데몬이 연결되어 이전 연결을 종료합니다/);
  } finally {
    await fake.close();
  }
});

// 2026-09-21: 웹에서 디바이스를 해제하면 서버가 연결을 끊는데, 이때 connection.replaced 를
// 보내는 바람에 데몬이 종료(exit 17)했고 셸이 재시작을 포기해 다시 pairing 하려 하면
// "daemon not running" 이 떴다. 해제는 종료 사유가 아니라 **재-pairing 대기 사유**다.
test('디바이스 해제: connection.revoked 는 데몬을 죽이지 않고 pairing 대기로 돌아간다', async () => {
  const home = tmpDir('home');
  const serverLog: string[] = [];
  const fake = await startFakeServer({ log: (l) => serverLog.push(l) });
  const store = new LocalSettingsStore(home);
  store.apply({ serverUrl: fake.url(), deviceName: 'test-mac' });
  const services = new RecordingShellServices(store);
  const fatals: string[] = [];
  const daemon = new Daemon({ providers: ['CLAUDE_CODE'], services, hook: hookCommand(), home, statusIntervalMs: 60_000, heartbeatIntervalMs: 60_000, onFatal: (r) => fatals.push(r) });
  try {
    await daemon.start();
    await daemon.pair('BATON-PAIR-123');
    await waitFor(() => serverLog.some((l) => l.startsWith('SSE_CONNECTED')));

    await postJson(`${fake.url()}/__test/supersede`, { eventName: 'connection.revoked', reason: '디바이스 연결이 해제되었습니다.' });
    await waitFor(() => services.statuses.some((s) => s.lastError?.code === 'not_paired'), 10_000);

    assert.deepEqual(fatals, [], '종료(onFatal)하지 않는다');
    assert.equal(daemon.isStopped, false, '데몬은 계속 살아 있다');
    assert.equal(daemon.currentState, 'idle');
    assert.equal(store.getToken(), null, '죽은 토큰은 지운다');

    // 새 코드로 다시 pairing 이 된다 — 이게 이 수정의 목적이다.
    const paired = await daemon.pair('BATON-PAIR-123');
    assert.ok(paired.deviceId);
    await waitFor(() => serverLog.filter((l) => l.startsWith('SSE_CONNECTED')).length >= 2, 10_000);
  } finally {
    await daemon.shutdown();
    await fake.close();
  }
});
