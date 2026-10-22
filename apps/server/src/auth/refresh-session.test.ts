import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { issueRefreshSession, rotateRefreshSession, revokeRefreshFamily, refreshHash, REFRESH_MAX_AGE, ACCESS_MAX_AGE } from './refresh-session';
import { AppController } from '../app.controller';

function fixture() {
  let rows: any[] = [];
  const user = { id: 'user', email: 'user@example.com', status: 'ACTIVE' };
  const db: any = {
    user: { findUnique: async () => user },
    $queryRaw: async () => [{ id: user.id }],
    authSession: {
      findUnique: async ({ where }: any) => rows.find((row) => Object.entries(where).every(([k, v]) => row[k] === v)) ?? null,
      create: async ({ data }: any) => { const row = { revokedAt: null, replacedById: null, ...data }; rows.push(row); return row; },
      update: async ({ where, data }: any) => Object.assign(rows.find((row) => row.id === where.id), data),
      updateMany: async ({ where, data }: any) => {
        const matches = rows.filter((row) => Object.entries(where).every(([k, v]) => row[k] === v));
        for (const row of matches) Object.assign(row, data);
        return { count: matches.length };
      },
    },
    $transaction: async (operation: any) => {
      const previous = structuredClone(rows);
      try { return await operation(db); } catch (error) { rows = previous; throw error; }
    },
  };
  const jwt: any = { signAsync: async ({ sub }: any) => `access-${sub}` };
  return { db, jwt, user, rows: () => rows };
}
const unauthorized = (error: any) => error.getStatus() === 401;

test('발급은 원문 대신 해시만 저장하고 독립 family와 30일 만료를 만든다', async () => {
  const f = fixture();
  const raw = await issueRefreshSession(f.db, 'user', 'agent');
  const second = await issueRefreshSession(f.db, 'user');
  const [a, b] = f.rows();
  assert.match(raw, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.tokenHash, refreshHash(raw));
  assert.notEqual(a.familyId, b.familyId);
  assert.notEqual(raw, second);
  assert.equal(a.expiresAt.getTime() - a.createdAt.getTime(), REFRESH_MAX_AGE);
  assert.equal(a.userAgent, 'agent');
  assert.equal(JSON.stringify(a).includes(raw), false);
});

test('회전은 같은 family에 후속 토큰을 만들고 마지막 사용부터 30일을 연장한다', async () => {
  const f = fixture();
  const raw = await issueRefreshSession(f.db, 'user');
  f.rows()[0].expiresAt = new Date(Date.now() + 1000);
  const result = await rotateRefreshSession(f.db, f.jwt, raw);
  const [a, b] = f.rows();
  assert.equal(result.token, 'access-user');
  assert.notEqual(result.refreshToken, raw);
  assert.equal(a.replacedById, b.id);
  assert.ok(a.revokedAt);
  assert.equal(a.familyId, b.familyId);
  assert.equal(b.tokenHash, refreshHash(result.refreshToken));
  assert.equal(b.expiresAt.getTime() - b.lastUsedAt.getTime(), REFRESH_MAX_AGE);
});

test('회전 직후 경합은 401만, 10초 뒤 재사용은 family 폐기를 커밋한다', async () => {
  const f = fixture();
  const raw = await issueRefreshSession(f.db, 'user');
  const unrelated = await issueRefreshSession(f.db, 'user');
  const next = await rotateRefreshSession(f.db, f.jwt, raw);
  await assert.rejects(rotateRefreshSession(f.db, f.jwt, raw), unauthorized);
  assert.equal(f.rows().find((row) => row.tokenHash === refreshHash(next.refreshToken)).revokedAt, null);
  f.rows()[0].revokedAt = new Date(Date.now() - 10_001);
  await assert.rejects(rotateRefreshSession(f.db, f.jwt, raw), unauthorized);
  assert.ok(f.rows().find((row) => row.tokenHash === refreshHash(next.refreshToken)).revokedAt);
  assert.equal(f.rows().find((row) => row.tokenHash === refreshHash(unrelated)).revokedAt, null);
  await assert.rejects(rotateRefreshSession(f.db, f.jwt, next.refreshToken), unauthorized);
});

test('만료·알 수 없는 토큰·비활성 사용자는 갱신할 수 없다', async () => {
  const f = fixture();
  const raw = await issueRefreshSession(f.db, 'user');
  f.rows()[0].expiresAt = new Date(Date.now() - 1);
  await assert.rejects(rotateRefreshSession(f.db, f.jwt, raw), unauthorized);
  await assert.rejects(rotateRefreshSession(f.db, f.jwt, 'unknown'), unauthorized);
  await assert.rejects(rotateRefreshSession(f.db, f.jwt), unauthorized);
  const active = await issueRefreshSession(f.db, 'user');
  f.user.status = 'DISABLED';
  await assert.rejects(rotateRefreshSession(f.db, f.jwt, active), unauthorized);
  assert.equal(f.rows().length, 2);
});

test('로그아웃은 회전 전 쿠키로도 같은 family의 현재 토큰을 폐기한다', async () => {
  const f = fixture();
  const raw = await issueRefreshSession(f.db, 'user');
  const next = await rotateRefreshSession(f.db, f.jwt, raw);
  await revokeRefreshFamily(f.db, raw);
  assert.ok(f.rows().every((row) => row.revokedAt));
  await assert.rejects(rotateRefreshSession(f.db, f.jwt, next.refreshToken), unauthorized);
});

test('로그인·콜백·갱신 쿠키에 만료와 경로를 주고, 원문 갱신 토큰은 JSON에 내보내지 않는다', async () => {
  const cookies: any[] = [];
  const cleared: any[] = [];
  const response: any = { cookie: (...args: any[]) => cookies.push(args), clearCookie: (...args: any[]) => cleared.push(args), redirect: () => {} };
  const auth: any = {
    login: async () => ({ token: 'access', user: { id: 'user' } }),
    callback: async () => ({ token: 'access', user: { id: 'user' }, redirectTo: '/login/callback' }),
    createRefreshSession: async () => 'refresh',
    refresh: async (raw: string) => { assert.equal(raw, 'refresh'); return { token: 'access', refreshToken: 'next' }; },
    logout: async (raw: string) => { assert.equal(raw, 'refresh'); },
  };
  const controller = new AppController(auth, {} as any);
  const body = await controller.login({ email: 'user', password: 'password' }, response);
  assert.equal('refreshToken' in body, false);
  await controller.authCallback({}, '', response);
  assert.deepEqual(await controller.refresh('baton_refresh=refresh', response), { token: 'access' });
  for (const [name, , options] of cookies) {
    assert.equal(options.httpOnly, true);
    assert.equal(options.sameSite, 'lax');
    assert.equal(options.secure, process.env.NODE_ENV === 'production');
    assert.equal(options.path, name === 'baton_refresh' ? '/v1/auth' : '/');
    assert.equal(options.maxAge, name === 'baton_refresh' ? REFRESH_MAX_AGE : ACCESS_MAX_AGE);
  }
  await controller.logout(response, 'baton_refresh=refresh');
  assert.ok(cleared.some(([name, options]) => name === 'baton_refresh' && options.path === '/v1/auth'));
  auth.refresh = async () => { throw Object.assign(new Error('expired'), { status: 401 }); };
  const before = cleared.length;
  await assert.rejects(controller.refresh('baton_refresh=refresh', response));
  assert.equal(cleared.length - before, 2);
});
