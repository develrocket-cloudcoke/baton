import assert from 'node:assert/strict';
import test from 'node:test';
import { apiClient, getAuthToken, setAuthToken, refreshAuthToken } from '../lib/api-client';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test('갱신 복원·동시 401 단일 비행·한 번 재시도 후 만료 이동을 연결한다', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalFetch = globalThis.fetch;
  const local = storage();
  const session = storage();
  const navigations: string[] = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    sessionStorage: session,
    location: { pathname: '/requests/abc', search: '?tab=timeline', replace: (url: string) => navigations.push(url) },
  } });
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'expired-token' }), {
    status: 401, headers: { 'Content-Type': 'application/json' },
  });
  const unauthorized = (error: any) => error.status === 401 && error.message === 'expired-token';
  try {
    let refreshes = 0;
    globalThis.fetch = async (input, options) => {
      if (String(input).endsWith('/v1/auth/refresh')) {
        refreshes++;
        assert.equal(options?.credentials, 'include');
        return new Response(JSON.stringify({ token: 'restored' }), { status: 200 });
      }
      const authenticated = (options?.headers as Record<string, string>)?.Authorization === 'Bearer restored';
      return new Response(JSON.stringify(authenticated ? [] : { message: 'expired-token' }), { status: authenticated ? 200 : 401 });
    };
    setAuthToken(null);
    assert.deepEqual(await apiClient.getRequests(), []);
    assert.equal(refreshes, 1);
    assert.equal(getAuthToken(), 'restored');
    assert.deepEqual(navigations, []);

    globalThis.fetch = async () => new Response(JSON.stringify({ message: 'expired-token' }), { status: 401 });
    setAuthToken('old-token');
    await assert.rejects(apiClient.describeAuth(), unauthorized);
    assert.equal(getAuthToken(), 'old-token');
    assert.deepEqual(navigations, []);
    // 다른 요청이 이미 토큰을 바꿨으면 갱신 요청 없이 새 토큰으로 한 번 재시도한다.
    let respond!: (response: Response) => void;
    globalThis.fetch = () => new Promise<Response>((resolve) => { respond = resolve; });
    const pending = apiClient.getRequests();
    setAuthToken('new-token');
    globalThis.fetch = async () => new Response('[]', { status: 200 });
    respond(new Response(JSON.stringify({ message: 'expired-token' }), { status: 401 }));
    assert.deepEqual(await pending, []);
    assert.equal(getAuthToken(), 'new-token');
    assert.deepEqual(navigations, []);

    // 로그아웃한 동안 도착한 갱신 응답은 로컬 토큰을 되살리지 않는다.
    globalThis.fetch = () => new Promise<Response>((resolve) => { respond = resolve; });
    const refreshing = refreshAuthToken();
    setAuthToken(null);
    respond(new Response(JSON.stringify({ token: 'too-late' }), { status: 200 }));
    await assert.rejects(refreshing, /인증 상태가 변경/);
    assert.equal(getAuthToken(), null);
    assert.deepEqual(navigations, []);
    setAuthToken('expired-again');

    let protectedCalls = 0;
    refreshes = 0;
    globalThis.fetch = async (input) => {
      if (String(input).endsWith('/v1/auth/refresh')) {
        refreshes++;
        return new Response(JSON.stringify({ token: 'rotated' }), { status: 200 });
      }
      protectedCalls++;
      return new Response(JSON.stringify({ message: 'expired-token' }), { status: 401 });
    };
    const outcomes = await Promise.allSettled([apiClient.getRequests(), apiClient.getRequests()]);
    for (const outcome of outcomes) {
      assert.equal(outcome.status, 'rejected');
      if (outcome.status === 'rejected') assert.equal(unauthorized(outcome.reason), true);
    }
    assert.equal(refreshes, 1);
    assert.equal(protectedCalls, 4, '두 원본 요청은 각각 한 번만 재시도한다');
    assert.equal(getAuthToken(), null);
    assert.equal(local.getItem('baton_token'), null);
    assert.equal(session.getItem('baton_return_to'), '/requests/abc?tab=timeline');
    assert.deepEqual(navigations, ['/login?expired=1']);
  } finally {
    setAuthToken(null);
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
