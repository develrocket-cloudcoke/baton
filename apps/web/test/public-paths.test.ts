import assert from 'node:assert/strict';
import test from 'node:test';
import { isPublicPath } from '../lib/public-paths';

// 2026-09-23 dev 를 accounts 로그인으로 바꾸자 로그인이 끝나지 않았다. 서버는 토큰을 실어
// /login/callback 으로 보냈는데, AuthGate 가 그 경로를 보호 화면으로 보고 /login 으로 돌려보냈다.
test('외부 로그인 콜백은 로그인 전에 열려야 한다', () => {
  assert.equal(isPublicPath('/login'), true);
  assert.equal(isPublicPath('/login/callback'), true);
});

test('그 밖의 화면은 보호한다', () => {
  for (const p of ['/', '/requests', '/admin/users', '/login/other', '/loginx', null, undefined, ''])
    assert.equal(isPublicPath(p as string), false, String(p));
});
