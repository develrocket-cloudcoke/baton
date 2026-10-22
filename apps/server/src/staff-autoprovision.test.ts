import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { JwtService } from '@nestjs/jwt';
import { AuthService, AuthRejection } from './auth/auth.service';
import { IdentityProviderRegistry } from './auth/identity-provider';
import { AccountsProvider } from './auth/providers/accounts.provider';

function fixture(
  options: {
    staff?: boolean;
    linked?: boolean;
    auto?: boolean;
    orgs?: string[];
    configured?: string;
    duplicate?: boolean;
    auditFailure?: boolean;
  } = {},
) {
  let linked: any = options.linked ? { user: { id: 'existing', status: 'ACTIVE' } } : null;
  const writes: any[] = [];
  let filter: any;
  const db: any = {
    userIdentity: { findUnique: async () => linked },
    organization: {
      findMany: async (query: any) => {
        filter = query.where;
        return (options.orgs ?? ['org'])
          .filter((id) => !query.where.id || query.where.id === id)
          .map((id) => ({ id }));
      },
    },
    user: {
      create: async ({ data }: any) => {
        if (options.duplicate) throw { code: 'P2002' };
        writes.push(data);
        linked = { user: { id: 'new', status: 'ACTIVE', ...data } };
        return linked.user;
      },
    },
    timelineEvent: {
      create: async ({ data }: any) => {
        if (options.auditFailure) throw Error('audit');
        writes.push(data);
      },
    },
    $transaction: async (fn: any) => {
      try {
        return await fn(db);
      } catch (e) {
        linked = null;
        writes.length = 0;
        throw e;
      }
    },
  };
  const provider = {
    id: 'accounts',
    autoProvisionRequiresStaff: true,
    describe: () => ({ kind: 'password' as const }),
    authenticate: async () => ({
      providerId: 'accounts',
      subject: '77',
      email: 'staff@example.com',
      staff: options.staff,
    }),
  };
  const svc = new AuthService(
    db,
    new JwtService({ secret: 'test-secret' }),
    new IdentityProviderRegistry([provider], {
      providerId: 'accounts',
      autoProvision: options.auto ?? true,
      defaultOrgId: options.configured,
    }),
  );
  return { svc, writes, filter: () => filter };
}
const rejected = (reason: string) => (e: any) =>
  e instanceof AuthRejection && e.reason === reason && e.getStatus() === 401;

test('직원 자동 가입은 MEMBER 조직 소속·신원·감사를 함께 생성', async () => {
  const f = fixture({ staff: true });
  assert.equal((await f.svc.login('x', 'y')).user.id, 'new');
  assert.deepEqual(f.writes[0].orgMemberships, { create: { orgId: 'org', role: 'MEMBER' } });
  assert.deepEqual(f.writes[0].identities, { create: { providerId: 'accounts', subject: '77' } });
  assert.equal(f.writes[1].eventType, 'user.auto_provisioned');
  const selected = fixture({ staff: true, orgs: ['a', 'b'], configured: 'b' });
  await selected.svc.login('x', 'y');
  assert.deepEqual(selected.filter(), { id: 'b' });
});

test('비직원·누락 직원 판정은 차단하되 이미 연결한 계정은 잠그지 않는다', async () => {
  for (const staff of [false, undefined]) {
    const f = fixture({ staff });
    await assert.rejects(f.svc.login('x', 'y'), rejected('not_staff'));
    assert.equal(f.writes.length, 0);
    assert.equal((await fixture({ staff, linked: true }).svc.login('x', 'y')).user.id, 'existing');
  }
  await assert.rejects(
    fixture({ staff: true, auto: false }).svc.login('x', 'y'),
    rejected('unlinked'),
  );
});

test('조직 미확정·이메일 충돌·감사 실패는 가입을 남기지 않는다', async () => {
  for (const options of [{ orgs: [] }, { orgs: ['a', 'b'] }, { configured: 'missing' }]) {
    const f = fixture({ staff: true, ...options });
    await assert.rejects(f.svc.login('x', 'y'), rejected('failed'));
    assert.equal(f.writes.length, 0);
  }
  const duplicate = fixture({ staff: true, duplicate: true });
  await assert.rejects(duplicate.svc.login('x', 'y'), rejected('unlinked'));
  const failed = fixture({ staff: true, auditFailure: true });
  await assert.rejects(failed.svc.login('x', 'y'));
  assert.equal(failed.writes.length, 0);
});

test('오류 URL은 허용한 사유만 노출한다', () => {
  const { svc } = fixture();
  for (const reason of ['not_staff', 'unlinked', 'failed'] as const)
    assert.equal(
      new URL(svc.loginErrorUrl(new AuthRejection(reason))).searchParams.get('auth_error'),
      reason,
    );
  assert.equal(
    new URL(svc.loginErrorUrl(Error('token-secret'))).searchParams.get('auth_error'),
    'failed',
  );
});

test('accounts 직원 조회는 userinfo와 같은 ATK를 쓰고 오류·잘못된 형식은 false', async () => {
  const original = globalThis.fetch;
  const provider = new AccountsProvider({
    providerId: 'accounts',
    issuer: 'https://accounts.example',
    clientId: 'client',
    clientSecret: 'secret',
    redirectUri: 'https://api.example/v1/auth/callback',
    scope: 'profile',
  });
  try {
    for (const result of [
      { isAdmin: true },
      { isAdmin: false },
      { isAdmin: 'true' },
      {},
      null,
      'http-error',
      'invalid-json',
      'network-error',
    ]) {
      const calls: { url: string; token: unknown }[] = [];
      globalThis.fetch = (async (url: any, init: any) => {
        calls.push({ url: String(url), token: new Headers(init.headers).get('authorization') });
        if (String(url).endsWith('/token')) return Response.json({ access_token: 'same-token' });
        if (String(url).endsWith('/user')) return Response.json({ id: 77, email: 'e@example.com' });
        if (result === 'network-error') throw Error('private-token');
        if (result === 'invalid-json') return new Response('invalid');
        return Response.json(result, { status: result === 'http-error' ? 503 : 200 });
      }) as typeof fetch;
      const identity = await provider.exchange('code', provider.redirectUri);
      assert.equal(identity.staff, typeof result === 'object' && result?.isAdmin === true);
      assert.equal(calls[2].url, 'https://accounts.example/auth/v2/me');
      assert.equal(calls[1].token, 'Bearer same-token');
      assert.equal(calls[2].token, 'Bearer same-token');
    }
    const logout = new URL(provider.logoutUrl('https://baton.example'));
    assert.equal(logout.pathname, '/oauth/logout');
    assert.equal(
      logout.searchParams.get('post_logout_redirect_uri'),
      'https://baton.example/login',
    );
  } finally {
    globalThis.fetch = original;
  }
});
