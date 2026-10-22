import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionSecret } from './auth/state';

// 운영 환경에서 세션이 공개된 개발용 값으로 서명되지 않도록 한다.
test('운영 환경에서 JWT_SECRET 이 없거나 짧으면 기동을 멈춘다', () => {
  assert.throws(() => sessionSecret({ NODE_ENV: 'production' }), /JWT_SECRET/);
  assert.throws(() => sessionSecret({ NODE_ENV: 'production', JWT_SECRET: 'short' }), /32자/);
  const good = 'x'.repeat(48);
  assert.equal(sessionSecret({ NODE_ENV: 'production', JWT_SECRET: good }), good);
});

test('개발 환경은 지금처럼 기본값으로 뜬다', () => {
  assert.equal(sessionSecret({}), 'baton-development-secret');
  assert.equal(sessionSecret({ JWT_SECRET: 'short' }), 'short');
});
