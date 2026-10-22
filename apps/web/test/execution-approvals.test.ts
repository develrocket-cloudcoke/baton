import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApprovalCard } from '../components/execution-approvals';
import type { ExecutionApproval } from '../lib/types';

const approval: ExecutionApproval = {
  id: 'approval',
  executionId: 'execution',
  toolName: 'Bash',
  detail: '<script>alert(1)</script>\ncat /tmp/file',
  reason: '셸 실행 차단',
  status: 'PENDING',
  expiresAt: new Date(10_000).toISOString(),
};
const render = (row = approval, now = 1000, busy = false) =>
  renderToStaticMarkup(
    React.createElement(ApprovalCard, { approval: row, now, busy, onDecision: () => {} }),
  );

test('승인 내용은 평문으로 이스케이프하고 긴 입력은 잘림을 표시한다', () => {
  const html = render();
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('cat /tmp/file'));
  assert.ok(html.includes('신뢰할 수 없으니'));
  assert.ok(html.includes('남은 시간 9초'));
  assert.ok(render({ ...approval, detail: 'x'.repeat(3000) }).includes('[내용 잘림]'));
  assert.ok(!render({ ...approval, detail: 'x'.repeat(3000) }).includes('x'.repeat(2001)));
});

test('마감·거부·허용된 카드는 결정 버튼을 없애고 저장 중에는 비활성화한다', () => {
  assert.ok(render(approval, 1000, true).includes('disabled=""'));
  for (const status of ['ALLOWED', 'DENIED', 'EXPIRED'] as const)
    assert.ok(!render({ ...approval, status }).includes('<button'));
  const expired = render(approval, 10_000);
  assert.ok(expired.includes('만료됨'));
  assert.ok(!expired.includes('<button'));
});

test('SSE 승인 이벤트를 전달하고 정상 EOF 후 재연결 때 목록 복구 콜백을 호출한다', async () => {
  const { apiClient, setAuthToken } = await import('../lib/api-client');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousFetch = globalThis.fetch;
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let calls = 0;
  let connected = 0;
  const received: string[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  // 토큰은 메모리에만 넣고 실제 브라우저 저장소/서버를 사용하지 않는다.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { setItem() {}, removeItem() {} },
  });
  setAuthToken('unit-token');
  let unsubscribe = () => {};
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const done = new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('SSE reconnect timeout')), 5000);
      globalThis.fetch = async () => {
        calls++;
        return new Response(
          `event: execution.approval_requested\ndata: {"executionId":"execution"}\n\n`,
        );
      };
      unsubscribe = apiClient.subscribeEvents(
        (event) => {
          received.push(event.data.executionId);
          if (received.length === 2) {
            unsubscribe();
            resolve();
          }
        },
        () => {
          connected++;
        },
      );
    });
    await done;
    assert.equal(calls, 2);
    assert.equal(connected, 2);
    assert.deepEqual(received, ['execution', 'execution']);
  } finally {
    clearTimeout(timeout);
    unsubscribe();
    setAuthToken(null);
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
