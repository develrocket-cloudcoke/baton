import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { SseClient } from '../src/transport/sse-client';
import { ApiClient } from '../src/transport/api-client';
import { Daemon } from '../src/daemon';
import { LocalShellServices } from '../src/services/shell-services';
import { LocalSettingsStore } from '../src/settings/store';
import { fakeClaudePath, hookCommand, startFakeServer, tmpDir, waitFor } from './helpers';

// Nest @Sse의 HTTP 200 + 비JSON 오류 프레임도 재현한다.
for (const mode of [401, 403, 'event'] as const) {
  test(`SSE 인증 실패 ${mode}: 한 번 알리고 재접속·이벤트 전달을 멈춘다`, async () => {
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests++;
      res.writeHead(mode === 'event' ? 200 : mode, { 'content-type': 'text/event-stream' });
      res.end(mode === 'event' ? 'event: error\nid: 1\ndata: uNaUtHoRiZeD\n\n' : 'Unauthorized');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    let failures = 0;
    const client = new SseClient({ url: `http://127.0.0.1:${(server.address() as any).port}`, token: 'invalid', getLastEventId: () => '1', onEvent: () => assert.fail('인증 오류는 outbox 이벤트가 아니다'), onAuthFailure: () => { failures++; }, minBackoffMs: 10 });
    try {
      client.start();
      await waitFor(() => failures === 1);
      await new Promise(r => setTimeout(r, 100));
      assert.equal(requests, 1);
      assert.equal(failures, 1);
    } finally { client.stop(); await new Promise<void>(r => server.close(() => r())); }
  });
}

test('일반 API 401은 한 번 알리고 무효 클라이언트는 다시 토큰을 보내지 않는다', async () => {
  const fake = await startFakeServer();
  let failures = 0;
  const api = new ApiClient(fake.url(), 'dead-token', () => { failures++; });
  try {
    await Promise.all([api.call('POST', '/v1/desktop/heartbeat', {}).catch(() => undefined), api.call('POST', '/v1/desktop/agents', {}).catch(() => undefined)]);
    assert.equal(failures, 1);
    await assert.rejects(api.call('POST', '/v1/desktop/heartbeat', {}));
    assert.equal(failures, 1);
  } finally { await fake.close(); }
});

for (const changeServer of [false, true]) {
  test(`데몬 ${changeServer ? '서버 변경' : 'heartbeat 401'}: 자격 증명 정리 후 pairing 대기`, async () => {
    const fake = await startFakeServer();
    const other = await startFakeServer();
    const home = tmpDir('auth-failure');
    const store = new LocalSettingsStore(home);
    store.apply({ serverUrl: fake.url() });
    const services = new LocalShellServices(store);
    const daemon = new Daemon({ services, home, providers: ['CLAUDE_CODE'], claudePath: fakeClaudePath, hook: hookCommand(), heartbeatIntervalMs: 60_000 });
    try {
      await daemon.start();
      await daemon.pair('BATON-PAIR-123');
      if (changeServer) await daemon.applySettings(store.apply({ serverUrl: other.url() }));
      else { fake.state.devices.clear(); await daemon.sendHeartbeat(); }
      await waitFor(() => daemon.currentState === 'idle' && store.getToken() === null && !store.all().deviceId);
      assert.equal(store.all().agents, '{}');
      assert.equal(store.all().lastEventId, '');
      // 설정 통지가 다시 와도 폐기된 토큰을 재로딩하지 않는다.
      await daemon.applySettings(store.all());
      assert.equal(daemon.currentState, 'idle');
      assert.equal(other.state.heartbeats.length, 0);
      assert.equal(other.state.agents.size, 0);
    } finally { await daemon.shutdown(); await fake.close(); await other.close(); }
  });
}

test('SSE 5xx와 일반 stream 종료는 계속 재접속한다', async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => { requests++; res.writeHead(requests === 1 ? 503 : 200, { 'content-type': 'text/event-stream' }); res.end(); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const client = new SseClient({ url: `http://127.0.0.1:${(server.address() as any).port}`, token: 'token', getLastEventId: () => '', onEvent: () => {}, onAuthFailure: () => assert.fail('일반 오류'), minBackoffMs: 10 });
  try { client.start(); await waitFor(() => requests >= 3); }
  finally { client.stop(); await new Promise<void>(r => server.close(() => r())); }
});
