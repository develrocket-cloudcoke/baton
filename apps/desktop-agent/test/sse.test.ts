import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiClient } from '../src/transport/api-client';
import { SseClient, SseEvent } from '../src/transport/sse-client';
import { postJson, startFakeServer, waitFor } from './helpers';

test('SSE: 구독 → 이벤트 수신 → 소켓 끊김 → Last-Event-ID 재연결 → 중복 replay 무시', async () => {
  const fake = await startFakeServer();
  let sse: SseClient | undefined;
  try {
    const api = new ApiClient(fake.url(), null);
    const paired = await api.pair('BATON-PAIR-123', 'sse-test');
    const events: SseEvent[] = [];
    const connectionEvents: SseEvent[] = [];
    let lastEventId = '';
    const connections: string[] = [];
    sse = new SseClient({
      url: `${fake.url()}/v1/desktop/events/stream`,
      token: paired.deviceToken,
      getLastEventId: () => lastEventId,
      onEvent: (e) => {
        // 서버(Nest @Sse)는 connection.ready/replaced 에 **연결별 일련번호**를 붙인다. outbox id 가 아니므로
        // 데몬과 같이 제어 프레임으로 분류하고 lastEventId 를 옮기지 않는다 (04 §11.2).
        if (SseClient.isControlEvent(e.type)) {
          connectionEvents.push(e);
          return;
        }
        events.push(e);
        lastEventId = e.id;
      },
      onConnected: (last) => connections.push(last),
      minBackoffMs: 50
    });
    sse.idleReconnectMs = 0;
    sse.start();
    await waitFor(() => connections.length === 1);
    await waitFor(() => connectionEvents.some((e) => e.type === 'connection.ready'));

    await postJson(`${fake.url()}/__test/command`, { title: 'one' }, paired.deviceToken);
    await waitFor(() => events.length === 1);
    assert.equal(events[0].type, 'execution.command.requested');

    // 서버가 소켓을 끊으면 Last-Event-ID 를 들고 재연결한다 (replay 0)
    await postJson(`${fake.url()}/__test/disconnect`, {}, paired.deviceToken);
    await waitFor(() => connections.length === 2);
    assert.equal(connections[1], events[0].id);

    // 같은 id 를 다시 보내면 무시
    await postJson(`${fake.url()}/__test/replay/${events[0].id}`, {}, paired.deviceToken);
    await postJson(`${fake.url()}/__test/command`, { title: 'two' }, paired.deviceToken);
    await waitFor(() => events.length === 2);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(events.length, 2);
    assert.equal(sse.connectCount, 2);
    // 재연결마다 connection.ready 를 다시 받지만 lastEventId 는 그대로다
    assert.equal(connectionEvents.filter((e) => e.type === 'connection.ready').length, 2);
    assert.equal(lastEventId, events[1].id);
  } finally {
    sse?.stop();
    await fake.close();
  }
});
