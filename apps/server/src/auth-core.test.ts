import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth/auth.service';
import { LocalProvider } from './auth/providers/local.provider';
import {
  ExternalIdentity,
  IdentityProvider,
  IdentityProviderRegistry,
  RedirectIdentityProvider,
  readAuthConfig,
} from './auth/identity-provider';

const unauthorized = (e: any) => e.getStatus?.() === 401;
const makeUser = (id: string, email = `${id}@baton.local`) => ({
  id,
  email,
  displayName: id,
  status: 'ACTIVE',
  passwordHash: null as string | null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});
function fixture() {
  const users = [makeUser('a'), makeUser('b')];
  const links: any[] = [];
  let creates = 0;
  const db: any = {
    user: {
      findUnique: async ({ where }: any) =>
        users.find((u) => (where.id ? u.id === where.id : u.email === where.email)) ?? null,
      create: async ({ data }: any) => {
        creates++;
        const key = data.identities.create;
        if (
          users.some((u) => u.email === data.email) ||
          links.some((l) => l.providerId === key.providerId && l.subject === key.subject)
        )
          throw { code: 'P2002' };
        const user = {
          ...makeUser(`new-${creates}`, data.email),
          displayName: data.displayName,
          passwordHash: data.passwordHash,
        };
        users.push(user);
        links.push({ ...key, userId: user.id });
        return user;
      },
    },
    // 로그인 성공 시 갱신 토큰 세션을 만든다(30일 로그인 유지).
    authSession: { create: async ({ data }: any) => data },
    userIdentity: {
      findUnique: async ({ where }: any) => {
        const key = where.providerId_subject;
        const link = links.find(
          (l) => l.providerId === key.providerId && l.subject === key.subject,
        );
        return link ? { ...link, user: users.find((u) => u.id === link.userId) } : null;
      },
      upsert: async ({ where, create }: any) => {
        const key = where.providerId_subject;
        let link = links.find((l) => l.providerId === key.providerId && l.subject === key.subject);
        if (!link) {
          link = create;
          links.push(link);
        }
        return link;
      },
    },
  };
  const jwt = new JwtService({ secret: 'unit-test-secret', signOptions: { expiresIn: '8h' } });
  const local = new LocalProvider(db);
  const localService = new AuthService(
    db,
    jwt,
    new IdentityProviderRegistry([local], readAuthConfig({})),
  );
  const external = (identity: ExternalIdentity, autoProvision = false) =>
    new AuthService(
      db,
      jwt,
      new IdentityProviderRegistry(
        [
          {
            id: 'external',
            describe: () => ({ kind: 'password' }),
            authenticate: async () => identity,
          },
        ],
        { providerId: 'external', autoProvision },
      ),
    );
  return {
    db,
    jwt,
    users,
    links,
    local,
    localService,
    external,
    get creates() {
      return creates;
    },
  };
}

test('제공자 기본 local, 자동 가입 기본 false, 잘못된 설정/중복/미등록 제공자는 실패', () => {
  assert.deepEqual(readAuthConfig({}), { providerId: 'local', autoProvision: false });
  assert.deepEqual(readAuthConfig({ AUTH_PROVIDER: 'sso', AUTH_AUTO_PROVISION: 'true' }), {
    providerId: 'sso',
    autoProvision: true,
  });
  assert.throws(() => readAuthConfig({ AUTH_AUTO_PROVISION: 'TRUE' }));
  const provider: IdentityProvider = { id: 'local', describe: () => ({ kind: 'password' }) };
  assert.throws(() => new IdentityProviderRegistry([provider, provider], readAuthConfig({})));
  assert.throws(
    () => new IdentityProviderRegistry([provider], { providerId: 'missing', autoProvision: false }),
  );
});

test('local 기존 계정은 같은 비밀번호/응답/JWT 규약으로 로그인하고 User ID로 연결', async () => {
  const f = fixture();
  f.users[0].passwordHash = await bcrypt.hash('baton-dev-password', 4);
  const result = await f.localService.login('a@baton.local', 'baton-dev-password');
  assert.equal(result.user.id, 'a');
  assert.equal('passwordHash' in result.user, false);
  const claims = await f.jwt.verifyAsync(result.token);
  assert.equal(claims.sub, 'a');
  assert.equal(claims.email, 'a@baton.local');
  assert.equal(claims.exp - claims.iat, 8 * 3600);
  assert.deepEqual(f.links, [{ providerId: 'local', subject: 'a', userId: 'a' }]);
  assert.equal(f.creates, 0);
  f.users[0].email = 'changed@baton.local';
  assert.equal(
    (await f.localService.login('changed@baton.local', 'baton-dev-password')).user.id,
    'a',
  );
  assert.equal(f.links.length, 1);
  assert.deepEqual(f.localService.describe(), { providerId: 'local', kind: 'password' });
});

test('local 잘못된 비밀번호/없는 계정/null hash/비활성 계정은 연결 생성 전에 거부', async () => {
  const f = fixture();
  f.users[0].passwordHash = await bcrypt.hash('correct', 4);
  await assert.rejects(f.localService.login('a@baton.local', 'wrong'), unauthorized);
  await assert.rejects(f.localService.login('absent@baton.local', 'correct'), unauthorized);
  await assert.rejects(f.localService.login('b@baton.local', 'correct'), unauthorized);
  f.users[0].status = 'DISABLED';
  await assert.rejects(f.localService.login('a@baton.local', 'correct'), unauthorized);
  assert.equal(f.links.length, 0);
});

test('외부 매핑은 providerId/subject만 사용: 이메일 변경 유지, 같은 이메일 신규 subject 거부', async () => {
  const f = fixture();
  f.links.push({ providerId: 'external', subject: 'stable', userId: 'a' });
  const svc = f.external({ providerId: 'external', subject: 'stable', email: 'new@example.test' });
  assert.equal((await svc.login('ignored', 'secret')).user.id, 'a');
  assert.equal(f.users[0].email, 'a@baton.local');
  await assert.rejects(
    f
      .external({ providerId: 'external', subject: 'new-owner', email: 'a@baton.local' })
      .login('x', 'y'),
    unauthorized,
  );
  await assert.rejects(
    f.external({ providerId: 'local', subject: 'stable' }).login('x', 'y'),
    unauthorized,
  );
  f.links.push({ providerId: 'another-provider', subject: 'other', userId: 'b' });
  await assert.rejects(
    f.external({ providerId: 'external', subject: 'other' }).login('x', 'y'),
    unauthorized,
  );
  assert.equal(f.creates, 0);
});

test('자동 가입 명시 허용에서만 새 User 생성, 이메일 충돌은 기존 계정 연결 금지', async () => {
  const f = fixture();
  const svc = f.external(
    { providerId: 'external', subject: 'new', email: 'new@example.test', displayName: 'New' },
    true,
  );
  const [a, b] = await Promise.all([svc.login('x', 'y'), svc.login('x', 'y')]);
  assert.equal(a.user.id, b.user.id);
  assert.equal(f.links.length, 1);
  assert.equal(f.users.length, 3);
  assert.equal(f.users[2].passwordHash, null);
  await assert.rejects(
    f
      .external({ providerId: 'external', subject: 'takeover', email: 'a@baton.local' }, true)
      .login('x', 'y'),
    unauthorized,
  );
  assert.equal(f.links.length, 1);
  const noEmail = await f
    .external({ providerId: 'external', subject: 'no-email' }, true)
    .login('x', 'y');
  assert.ok(noEmail.user.email.endsWith('@baton.invalid'));
});

test('current는 Bearer/raw/cookie와 JWT claims를 유지하며 삭제/정지 User를 즉시 거부', async () => {
  const f = fixture();
  const token = await f.jwt.signAsync({ sub: 'a', email: 'a@baton.local', custom: 'keep' });
  const expected = await f.jwt.verifyAsync(token);
  for (const value of [
    token,
    `Bearer ${token}`,
    `bearer ${token}`,
    `other=x; baton_token=${encodeURIComponent(token)}; x=y`,
    `token=${token}`,
  ])
    assert.deepEqual(await f.localService.current(value), expected);
  f.users[0].status = 'DISABLED';
  await assert.rejects(f.localService.current(token), unauthorized);
  f.users.splice(0, 1);
  await assert.rejects(f.localService.current(token), unauthorized);
  for (const value of [undefined, '', 'bad-token', 'baton_token=%E0%A4%A'])
    await assert.rejects(f.localService.current(value), unauthorized);
  const expired = await f.jwt.signAsync({ sub: 'b' }, { expiresIn: -1 });
  await assert.rejects(f.localService.current(expired), unauthorized);
  const deviceToken = 'seed-device-token';
  await assert.rejects(f.localService.current(deviceToken), unauthorized);
});

test('연결된 외부 계정도 비활성화면 로그인 불가, 외부 장애는 local로 우회하지 않음', async () => {
  const f = fixture();
  f.links.push({ providerId: 'external', subject: 'stable', userId: 'a' });
  f.users[0].status = 'DISABLED';
  await assert.rejects(
    f.external({ providerId: 'external', subject: 'stable' }).login('x', 'y'),
    unauthorized,
  );
  const failing: IdentityProvider = {
    id: 'external',
    describe: () => ({ kind: 'password' }),
    authenticate: async () => {
      throw new Error('provider outage');
    },
  };
  await assert.rejects(
    new AuthService(
      f.db,
      f.jwt,
      new IdentityProviderRegistry([failing], { providerId: 'external', autoProvision: false }),
    ).login('x', 'y'),
    unauthorized,
  );
});

test('redirect 제공자 설명은 노출하되 password 로그인과 state 없는 callback에서 토큰 발급 금지', async () => {
  const f = fixture();
  let exchanges = 0;
  const redirect: RedirectIdentityProvider = {
    id: 'oidc',
    redirectUri: 'https://baton.example/v1/auth/callback',
    describe: () => ({ kind: 'redirect', authorizeUrl: 'https://baton.example/v1/auth/authorize' }),
    startAuthorization: async (state: string) => ({
      url: `https://sso.example/authorize?state=${state}`,
    }),
    exchange: async () => {
      exchanges++;
      return { providerId: 'oidc', subject: 's' };
    },
  };
  const svc = new AuthService(
    f.db,
    f.jwt,
    new IdentityProviderRegistry([redirect], { providerId: 'oidc', autoProvision: false }),
  );
  assert.deepEqual(svc.describe(), {
    providerId: 'oidc',
    kind: 'redirect',
    authorizeUrl: 'https://baton.example/v1/auth/authorize',
  });
  await assert.rejects(svc.login('x', 'y'), unauthorized);
  // state 를 통과하지 못한 code 는 제공자까지 가지도 않는다.
  await assert.rejects(svc.callback({ code: 'untrusted' }, {}), unauthorized);
  assert.equal(exchanges, 0);

  // redirect 규약을 갖추지 않은 제공자(local 포함)에서는 콜백 경로가 없는 것으로 둔다.
  await assert.rejects(
    f.localService.callback({ code: 'untrusted' }, {}),
    (e: any) => e.getStatus() === 501,
  );
});

test('실제 HTTP 계약: describe/password login 쿠키와 미구현 callback, AuthModule DI', async () => {
  const { Global, Module } = await import('@nestjs/common');
  const { NestFactory } = await import('@nestjs/core');
  const { default: request } = await import('supertest');
  const { PrismaService } = await import('./prisma.service');
  const { BatonService } = await import('./baton.service');
  const { AppController } = await import('./app.controller');
  const { AuthModule } = await import('./auth/auth.module');
  const f = fixture();
  f.users[0].passwordHash = await bcrypt.hash('baton-dev-password', 4);
  @Global()
  @Module({ providers: [{ provide: PrismaService, useValue: f.db }], exports: [PrismaService] })
  class UnitPrismaModule {}
  @Module({
    imports: [UnitPrismaModule, AuthModule],
    controllers: [AppController],
    providers: [{ provide: BatonService, useValue: {} }],
  })
  class UnitAppModule {}
  const app = await NestFactory.create(UnitAppModule, { logger: false });
  try {
    // 127.0.0.1 로 명시해 연다. 호스트 없이 두면 supertest 가 '::' 로 listen(0) 하는데,
    // macOS 는 다른 프로세스(병렬로 도는 다른 테스트 파일의 가짜 인증 서버)가 같은 포트를
    // 127.0.0.1 로 또 열 수 있게 허용하고 요청이 그쪽으로 간다 — 20회 중 1회꼴로 콜백이
    // 가짜 서버의 404·400 을 받던 간헐 실패의 원인(2026-09-23 실측).
    await app.listen(0, '127.0.0.1');
    const api = request(app.getHttpServer());
    const description = await api.get('/v1/auth/describe').expect(200);
    assert.deepEqual(description.body, { providerId: 'local', kind: 'password' });
    const login = await api
      .post('/v1/auth/login')
      .send({ email: 'a@baton.local', password: 'baton-dev-password' })
      .expect(201);
    assert.equal(login.body.user.id, 'a');
    assert.equal(login.body.user.passwordHash, undefined);
    assert.match(login.headers['set-cookie'][0], /^baton_token=.*HttpOnly; SameSite=Lax/);
    assert.equal((await app.get(AuthService).current(`Bearer ${login.body.token}`)).sub, 'a');
    await api
      .post('/v1/auth/login')
      .send({ email: 'a@baton.local', password: 'wrong' })
      .expect(401);
    await api.post('/v1/auth/login').send({}).expect(401);
    const logout = await api.post('/v1/auth/logout').expect(201);
    assert.ok(
      [logout.headers['set-cookie']]
        .flat()
        .some((cookie: string) => cookie.startsWith('baton_token=;')),
    );
    // 기본 설정(local)에서는 redirect 경로가 통째로 없는 것으로 둔다.
    await api.get('/v1/auth/callback?code=untrusted').expect(501);
    await api.get('/v1/auth/authorize').expect(501);
  } finally {
    await app.close();
  }
});

test('미연결 신원 거부 로그는 허용 필드만 한 줄로 남기고 응답은 401', async () => {
  for (const autoProvision of [false, true]) {
    const f = fixture();
    const service = f.external(
      {
        providerId: 'external',
        subject: 'unlinked\nsubject',
        email: 'a@baton.local',
        accessToken: 'secret-token',
        code: 'secret-code',
      } as ExternalIdentity,
      autoProvision,
    );
    const messages: string[] = [];
    (service as any).logger.warn = (value: string) => messages.push(value);
    await assert.rejects(service.login('x', 'secret-password'), unauthorized);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].includes('\n'), false);
    assert.deepEqual(JSON.parse(messages[0]), {
      event: 'auth.identity_unlinked',
      providerId: 'external',
      subject: 'unlinked\nsubject',
      email: 'a@baton.local',
    });
    assert.ok(!messages[0].includes('secret-'));
  }
  const f = fixture();
  const service = f.external({ providerId: 'external', subject: 'no-email' });
  const messages: string[] = [];
  (service as any).logger.warn = (value: string) => messages.push(value);
  await assert.rejects(service.login('x', 'y'), unauthorized);
  assert.equal('email' in JSON.parse(messages[0]), false);
});
