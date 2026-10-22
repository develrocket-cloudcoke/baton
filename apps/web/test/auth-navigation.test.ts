import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loginErrorMessage,
  loginRedirectAllowed,
  logoutDestination,
  runSignOut,
  validReturnTo,
  autoReloginAllowed,
  AUTO_RELOGIN_INTERVAL_MS,
  singleFlight,
  shouldRefreshSession,
} from '../lib/auth-navigation';

test('거절 사유는 한국어 안내로 바꾸고 임의 문자열은 화면에 반영하지 않는다', () => {
  assert.match(loginErrorMessage('not_staff')!, /사내 직원/);
  assert.match(loginErrorMessage('unlinked')!, /계정 연결/);
  assert.equal(loginErrorMessage('<script>'), loginErrorMessage('failed'));
  assert.equal(loginErrorMessage(null), null);
});
test('오류 로그인 화면은 자동 이동하지 않으며 제공자 로그아웃은 redirect만 사용', () => {
  for (const reason of ['1', 'failed', 'not_staff', 'unlinked'])
    assert.equal(loginRedirectAllowed(`?auth_error=${reason}`), false);
  assert.equal(loginRedirectAllowed(''), true);
  assert.equal(
    logoutDestination({ kind: 'redirect', logoutUrl: 'https://accounts.example/logout' }),
    'https://accounts.example/logout',
  );
  assert.equal(logoutDestination({ kind: 'password', logoutUrl: 'ignored' }), null);
  assert.equal(logoutDestination({ kind: 'redirect' }), null);
});

test('로그아웃은 토큰 삭제 후 서버 쿠키를 지우고 외부로 이동한다', async () => {
  for (const fail of [false, true]) {
    const calls: string[] = [];
    await runSignOut(
      () => {
        calls.push('clear');
      },
      async () => {
        calls.push('revoke');
        if (fail) throw Error('offline');
      },
      'https://accounts.example/logout',
      (url) => {
        calls.push(url);
      },
    );
    assert.deepEqual(calls, ['clear', 'revoke', 'https://accounts.example/logout']);
  }
  let navigated = false;
  await runSignOut(
    () => {},
    async () => {},
    null,
    () => {
      navigated = true;
    },
  );
  assert.equal(navigated, false);
});


test('복귀는 사이트 내부 경로만 허용하고 로그인·외부 주소·정규화 우회를 거부한다', () => {
  assert.equal(validReturnTo('/requests/abc?tab=timeline'), '/requests/abc?tab=timeline');
  assert.equal(validReturnTo('/'), '/');
  for (const value of [null, '', 'requests', 'https://other.example', '//other.example',
    '/login', '/login?expired=1', '/login/', '/a/../login', '/%6cogin',
    '/%2fother.example', '/%5cother.example', '/\\other.example', '/\n/other.example']) {
    assert.equal(validReturnTo(value), null, String(value));
  }
});

test('자동 재로그인은 처음과 5분 경과 후만 허용한다', () => {
  const now = 1_800_000_000_000;
  assert.equal(autoReloginAllowed(null, now), true);
  assert.equal(autoReloginAllowed(String(now), now), false);
  assert.equal(autoReloginAllowed(String(now - AUTO_RELOGIN_INTERVAL_MS + 1), now), false);
  assert.equal(autoReloginAllowed(String(now - AUTO_RELOGIN_INTERVAL_MS), now), true);
  assert.equal(autoReloginAllowed(String(now + 1), now), false);
  for (const invalid of ['', 'invalid', 'NaN', 'Infinity', '-1'])
    assert.equal(autoReloginAllowed(invalid, now), false);
});


test('동시 갱신은 한 비행을 공유하고 성공·실패 후 다음 비행을 허용한다', async () => {
  let calls = 0;
  let finish!: (value: string) => void;
  let fail!: (error: Error) => void;
  const refresh = singleFlight(() => {
    calls++;
    return new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  });
  const first = refresh();
  const second = refresh();
  assert.equal(first, second);
  assert.equal(calls, 1);
  finish('token');
  assert.deepEqual(await Promise.all([first, second]), ['token', 'token']);
  const third = refresh();
  const fourth = refresh();
  assert.equal(third, fourth);
  fail(new Error('expired'));
  assert.equal((await Promise.allSettled([third, fourth])).every((item) => item.status === 'rejected'), true);
  const fifth = refresh();
  finish('next');
  assert.equal(await fifth, 'next');
  assert.equal(calls, 3);
});

test('보호 API 401에서만 한 번 갱신하고 인증 API·재시도 응답에서는 반복하지 않는다', () => {
  assert.equal(shouldRefreshSession('/v1/me', 401, false), true);
  assert.equal(shouldRefreshSession('/v1/requests', 401, true), false);
  for (const status of [200, 400, 403, 500]) assert.equal(shouldRefreshSession('/v1/me', status, false), false);
  for (const path of ['/v1/auth/refresh', '/v1/auth/login', '/v1/auth/describe', '/v1/auth/callback'])
    assert.equal(shouldRefreshSession(path, 401, false), false);
});
