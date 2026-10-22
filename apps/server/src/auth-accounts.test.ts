import 'reflect-metadata';
import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, before } from 'node:test';
import { AddressInfo } from 'node:net';

// accounts 어댑터 계약 테스트. **실계정이 없어 이것이 유일한 검증 수단이다**(설계 08 §7).
// 가짜 accounts 서버를 실제로 띄워 authorize → code → token → userinfo → Baton 세션까지
// 한 바퀴를 돈다. 네트워크 호출을 가짜로 바꾸지 않는 이유는, 우리가 검증하려는 것이
// 바로 "우리가 만드는 HTTP 요청의 모양" 이기 때문이다.

const CLIENT_ID = 'baton-test-client';
const CLIENT_SECRET = 'baton-test-secret-do-not-log';
const WEB_URL = 'http://127.0.0.1:4321';

process.env.JWT_SECRET = 'accounts-contract-test-secret';
process.env.WEB_URL = WEB_URL;

interface FakeAccounts {
  base: string;
  /** 토큰 엔드포인트가 실제로 받은 본문들. client_secret 이 서버→서버로만 갔는지 본다. */
  tokenRequests: Array<Record<string, string>>;
  userinfoAuth: string[];
  staff: boolean;
  user: { id: unknown; uid: string; email: string; name: string; emailVerified: boolean };
  close(): Promise<void>;
}

async function startFakeAccounts(): Promise<FakeAccounts> {
  const codes = new Map<string, { redirectUri: string; used: boolean }>();
  const tokens = new Set<string>();
  const state: FakeAccounts = {
    base: '',
    tokenRequests: [],
    userinfoAuth: [],
    staff: true,
    // id 와 uid·email 을 일부러 다르게 둔다. subject 로 무엇을 쓰는지 드러나게 하려는 것이다.
    user: {
      id: 77,
      uid: 'alice.backend',
      email: 'alice@example.com',
      name: '김백엔드',
      emailVerified: true,
    },
    close: async () => {},
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/oauth/v2/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const clientState = url.searchParams.get('state') ?? '';
      if (url.searchParams.get('client_id') !== CLIENT_ID)
        return json(400, { error: 'unauthorized_client' });
      if (url.searchParams.get('response_type') !== 'code')
        return json(400, { error: 'unsupported_response_type' });
      const code = `code-${codes.size + 1}`;
      codes.set(code, { redirectUri, used: false });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', clientState);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    if (url.pathname === '/oauth/v2/token') {
      if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
      const raw = await new Promise<string>((resolve) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => resolve(body));
      });
      const form = Object.fromEntries(new URLSearchParams(raw));
      state.tokenRequests.push({
        ...form,
        __authorization: String(req.headers.authorization ?? ''),
      });
      const entry = codes.get(form.code ?? '');
      if (form.grant_type !== 'authorization_code')
        return json(400, { error: 'unsupported_grant_type' });
      if (form.client_id !== CLIENT_ID || form.client_secret !== CLIENT_SECRET)
        return json(401, { error: 'invalid_client' });
      // 인가 코드는 한 번만 쓴다. 재사용은 도난 신호다.
      if (!entry || entry.used) return json(400, { error: 'invalid_grant' });
      if (entry.redirectUri !== form.redirect_uri) return json(400, { error: 'invalid_grant' });
      entry.used = true;
      const token = `access-${tokens.size + 1}`;
      tokens.add(token);
      return json(200, { access_token: token, token_type: 'Bearer', expires_in: 3600 });
    }

    if (url.pathname === '/auth/v2/me') {
      if (!tokens.has(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')))
        return json(401, {});
      return json(200, { isAdmin: state.staff });
    }

    if (url.pathname === '/oauth/v2/user') {
      const auth = String(req.headers.authorization ?? '');
      state.userinfoAuth.push(auth);
      if (!tokens.has(auth.replace(/^Bearer\s+/i, ''))) return json(401, { error: 'unauthorized' });
      return json(200, state.user);
    }

    json(404, { error: 'not_found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}

// 인증에 필요한 최소 Prisma 대역. 실제 DB 를 건드리지 않는다.
function fakeDb() {
  const users: any[] = [
    {
      id: 'existing-user',
      email: 'alice@example.com',
      displayName: '김백엔드',
      status: 'ACTIVE',
      passwordHash: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  ];
  const links: any[] = [];
  return {
    users,
    links,
    async $transaction(fn: any) {
      return fn(this);
    },
    organization: { findMany: async () => [{ id: 'org' }] },
    timelineEvent: { create: async () => ({}) },
    user: {
      findUnique: async ({ where }: any) =>
        users.find((u) => (where.id ? u.id === where.id : u.email === where.email)) ?? null,
      create: async ({ data }: any) => {
        const user = {
          id: `new-${users.length}`,
          email: data.email,
          displayName: data.displayName,
          status: 'ACTIVE',
          passwordHash: data.passwordHash,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
        users.push(user);
        links.push({ ...data.identities.create, userId: user.id });
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
        if (!link) links.push((link = create));
        return link;
      },
    },
  };
}

let accounts: FakeAccounts;

before(async () => {
  accounts = await startFakeAccounts();
  process.env.AUTH_PROVIDER = 'accounts';
  process.env.ACCOUNTS_ISSUER = accounts.base;
  process.env.ACCOUNTS_CLIENT_ID = CLIENT_ID;
  process.env.ACCOUNTS_CLIENT_SECRET = CLIENT_SECRET;
  process.env.ACCOUNTS_REDIRECT_URI = 'http://127.0.0.1:3999/v1/auth/callback';
});
after(async () => {
  await accounts?.close();
});

async function createApp(db: any) {
  const { Global, Module } = await import('@nestjs/common');
  const { NestFactory } = await import('@nestjs/core');
  const { PrismaService } = await import('./prisma.service');
  const { BatonService } = await import('./baton.service');
  const { AppController } = await import('./app.controller');
  const { AuthModule } = await import('./auth/auth.module');
  @Global()
  @Module({ providers: [{ provide: PrismaService, useValue: db }], exports: [PrismaService] })
  class UnitPrismaModule {}
  @Module({
    imports: [UnitPrismaModule, AuthModule],
    controllers: [AppController],
    providers: [{ provide: BatonService, useValue: {} }],
  })
  class UnitAppModule {}
  const app = await NestFactory.create(UnitAppModule, { logger: false });
  // 127.0.0.1 로 명시해 연다. 호스트 없이 두면 supertest 가 '::' 로 listen(0) 하는데,
  // macOS 는 다른 프로세스(병렬로 도는 다른 테스트 파일의 가짜 인증 서버)가 같은 포트를
  // 127.0.0.1 로 또 열 수 있게 허용하고 요청이 그쪽으로 간다 — 20회 중 1회꼴로 콜백이
  // 가짜 서버의 404·400 을 받던 간헐 실패의 원인(2026-09-23 실측).
  await app.listen(0, '127.0.0.1');
  return app;
}

const setCookies = (res: any): string[] => {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
};
const cookieHeader = (cookies: string[]) =>
  cookies
    .map((c) => c.split(';')[0])
    .filter((c) => !c.endsWith('='))
    .join('; ');

/** authorize 로 시작해 가짜 accounts 를 실제로 거쳐 콜백 쿼리까지 받아 온다. */
async function walkToCallback(api: any) {
  const start = await api.get('/v1/auth/authorize').expect(302);
  const cookies = setCookies(start);
  const authorizeUrl = new URL(start.headers.location);
  const hop = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(hop.status, 302);
  const back = new URL(hop.headers.get('location') as string);
  return {
    cookies,
    authorizeUrl,
    query: back.search,
    state: back.searchParams.get('state') as string,
  };
}

test('accounts 한 바퀴: authorize → code → token → userinfo → Baton 세션', async () => {
  const { default: request } = await import('supertest');
  const { AuthService } = await import('./auth/auth.service');
  const db = fakeDb();
  // 자동 가입은 기본 꺼짐이다. 이미 있는 User 에만 연결한다(설계 08 §4).
  db.links.push({ providerId: 'accounts', subject: '77', userId: 'existing-user' });
  const app = await createApp(db);
  try {
    const api = request(app.getHttpServer());

    // 웹 로그인 화면이 보는 값. 버튼은 외부가 아니라 **우리 서버**의 authorize 로 향한다.
    const described = await api.get('/v1/auth/describe').expect(200);
    assert.deepEqual(described.body, {
      providerId: 'accounts',
      kind: 'redirect',
      authorizeUrl: 'http://127.0.0.1:3999/v1/auth/authorize',
      logoutUrl: `${accounts.base}/oauth/logout?post_logout_redirect_uri=${encodeURIComponent(`${WEB_URL}/login`)}`,
    });

    const walk = await walkToCallback(api);

    // authorize 로 보내는 URL 에 시크릿이 실리면 안 된다 — 이건 브라우저가 보는 주소다.
    assert.equal(walk.authorizeUrl.origin, accounts.base);
    assert.equal(walk.authorizeUrl.pathname, '/oauth/v2/authorize');
    assert.equal(walk.authorizeUrl.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(
      walk.authorizeUrl.searchParams.get('redirect_uri'),
      'http://127.0.0.1:3999/v1/auth/callback',
    );
    assert.equal(walk.authorizeUrl.searchParams.get('response_type'), 'code');
    assert.ok(!walk.authorizeUrl.search.includes(CLIENT_SECRET));
    assert.ok(walk.state && walk.state.length > 20);

    // state 는 httpOnly 쿠키로만 들고 다닌다. JS 가 읽을 수 있으면 CSRF 방어가 무의미하다.
    const stateCookie = walk.cookies.find((c) => c.startsWith('baton_auth_state='));
    assert.ok(stateCookie, 'state 쿠키가 있어야 한다');
    assert.match(stateCookie, /HttpOnly/);
    assert.match(stateCookie, /SameSite=Lax/);
    assert.match(stateCookie, /Path=\/v1\/auth/);
    assert.equal(stateCookie.includes('Secure'), false); // http 루프백이므로

    const callback = await api
      .get(`/v1/auth/callback${walk.query}`)
      .set('cookie', cookieHeader(walk.cookies))
      .expect(302);

    // 세션이 발급됐고, 브라우저는 웹으로 돌아간다. 토큰은 쿼리가 아니라 fragment 다.
    const location = new URL(callback.headers.location);
    assert.equal(location.origin, WEB_URL);
    assert.equal(location.pathname, '/login/callback');
    assert.equal(location.search, '');
    const token = new URLSearchParams(location.hash.slice(1)).get('token') as string;
    assert.ok(token, 'fragment 에 토큰이 있어야 한다');
    assert.equal((await app.get(AuthService).current(`Bearer ${token}`)).sub, 'existing-user');
    assert.match(
      setCookies(callback).find((c) => c.startsWith('baton_token=')) as string,
      /HttpOnly; SameSite=Lax/,
    );

    // 코드 교환은 서버에서만 한다. client_secret 은 서버→서버 본문에만 있었다.
    assert.equal(accounts.tokenRequests.length, 1);
    const tokenRequest = accounts.tokenRequests[0];
    assert.equal(tokenRequest.client_secret, CLIENT_SECRET);
    assert.equal(tokenRequest.grant_type, 'authorization_code');
    assert.equal(tokenRequest.redirect_uri, 'http://127.0.0.1:3999/v1/auth/callback');
    assert.equal(accounts.userinfoAuth.length, 1);
    assert.match(accounts.userinfoAuth[0], /^Bearer access-/);

    // 브라우저가 받은 어떤 값에도 시크릿이 없어야 한다.
    for (const seen of [...walk.cookies, ...setCookies(callback), callback.headers.location])
      assert.ok(!String(seen).includes(CLIENT_SECRET));

    // 한 번 쓴 state 쿠키는 즉시 버린다 — 같은 code 로 다시 들어와도 통과하지 못한다.
    assert.ok(
      setCookies(callback).some((c) => /^baton_auth_state=;/.test(c)),
      'state 쿠키를 지워야 한다',
    );
    const replay = await api
      .get(`/v1/auth/callback${walk.query}`)
      .set('cookie', cookieHeader(walk.cookies))
      .expect(302);
    assert.equal(new URL(replay.headers.location).pathname, '/login');
    assert.equal(
      setCookies(replay).some((c) => c.startsWith('baton_token=')),
      false,
    );
  } finally {
    await app.close();
  }
});

test('subject 는 uid·email 이 아니라 id 다. id 가 없으면 로그인시키지 않는다', async () => {
  const { default: request } = await import('supertest');
  process.env.AUTH_AUTO_PROVISION = 'true';
  const db = fakeDb();
  const app = await createApp(db);
  try {
    const api = request(app.getHttpServer());
    const walk = await walkToCallback(api);
    await api
      .get(`/v1/auth/callback${walk.query}`)
      .set('cookie', cookieHeader(walk.cookies))
      .expect(302);
    // 숫자 id 77 → '77'. uid('alice.backend')·email 은 바뀔 수 있으므로 키가 아니다(§7).
    assert.deepEqual(
      db.links.map((l: any) => ({ providerId: l.providerId, subject: l.subject })),
      [{ providerId: 'accounts', subject: '77' }],
    );
    // 이메일이 같은 기존 계정을 넘겨받지 않는다. 새 User 가 생겼어야 한다.
    assert.equal(db.links[0].userId.startsWith('new-'), true);

    // id 를 주지 않는 응답은 신원이 아니다.
    accounts.user = { ...accounts.user, id: undefined };
    const second = await walkToCallback(api);
    const failed = await api
      .get(`/v1/auth/callback${second.query}`)
      .set('cookie', cookieHeader(second.cookies))
      .expect(302);
    assert.equal(new URL(failed.headers.location).pathname, '/login');
    assert.equal(db.links.length, 1);
    accounts.user = { ...accounts.user, id: 77 };
  } finally {
    process.env.AUTH_AUTO_PROVISION = 'false';
    await app.close();
  }
});

test('state 없음·위조·만료·불일치는 code 를 교환하지도 않는다', async () => {
  const { default: request } = await import('supertest');
  const { createState, AUTH_STATE_COOKIE } = await import('./auth/state');
  const db = fakeDb();
  db.links.push({ providerId: 'accounts', subject: '77', userId: 'existing-user' });
  const app = await createApp(db);
  try {
    const api = request(app.getHttpServer());
    const walk = await walkToCallback(api);
    const before = accounts.tokenRequests.length;
    const rejected = async (query: string, cookie?: string) => {
      const req = api.get(`/v1/auth/callback${query}`);
      if (cookie) req.set('cookie', cookie);
      const res = await req.expect(302);
      assert.equal(new URL(res.headers.location).pathname, '/login');
      assert.equal(
        setCookies(res).some((c) => c.startsWith('baton_token=')),
        false,
        '토큰이 발급되면 안 된다',
      );
    };

    // 쿠키 없이 code+state 만 들고 오는 경우 = 전형적인 로그인 CSRF
    await rejected(walk.query);
    // 쿠키는 있는데 쿼리 state 가 다른 경우
    await rejected(`?code=code-x&state=someone-elses-state`, cookieHeader(walk.cookies));
    // 우리 서명이 아닌 state 를 쿠키와 쿼리 양쪽에 심은 경우(double submit 만으로는 못 막는다)
    const forged = 'aaaa.9999999999.bbbb';
    await rejected(
      `?code=code-x&state=${forged}`,
      `${AUTH_STATE_COOKIE}=${encodeURIComponent(forged)}`,
    );
    // 서명은 맞지만 만료된 state
    const expired = createState(process.env.JWT_SECRET as string, Date.now() - 3600_000);
    await rejected(
      `?code=code-x&state=${encodeURIComponent(expired)}`,
      `${AUTH_STATE_COOKIE}=${encodeURIComponent(expired)}`,
    );
    // 제공자가 error 를 실어 보낸 경우(사용자가 동의 거부)
    await rejected(`?error=access_denied&state=${walk.state}`, cookieHeader(walk.cookies));

    assert.equal(accounts.tokenRequests.length, before, 'code 가 제공자까지 가면 안 된다');
  } finally {
    await app.close();
  }
});

test('설정 검증: 시크릿 없음·http 외부 주소·잘못된 URL 은 기동 시점에 막는다', async () => {
  const { readRedirectConfig } = await import('./auth/providers/redirect-config');
  const { buildRedirectProvider } = await import('./auth/providers/factory');
  const defaults = { providerId: 'accounts', issuer: 'https://accounts.example.com', scope: 's' };
  const base = {
    ACCOUNTS_CLIENT_ID: 'id',
    ACCOUNTS_CLIENT_SECRET: 'secret',
    ACCOUNTS_REDIRECT_URI: 'https://baton.example/v1/auth/callback',
  };
  assert.equal(
    readRedirectConfig('ACCOUNTS', defaults, base).issuer,
    'https://accounts.example.com',
  );
  assert.throws(() =>
    readRedirectConfig('ACCOUNTS', defaults, { ...base, ACCOUNTS_CLIENT_SECRET: '' }),
  );
  assert.throws(() =>
    readRedirectConfig('ACCOUNTS', defaults, { ...base, ACCOUNTS_CLIENT_ID: '' }),
  );
  // 시크릿이 오가는 경로다. 평문 http 는 루프백에서만 허용한다.
  assert.throws(() =>
    readRedirectConfig('ACCOUNTS', defaults, {
      ...base,
      ACCOUNTS_ISSUER: 'http://accounts.example',
    }),
  );
  assert.doesNotThrow(() =>
    readRedirectConfig('ACCOUNTS', defaults, { ...base, ACCOUNTS_ISSUER: 'http://127.0.0.1:8080' }),
  );
  assert.throws(() =>
    readRedirectConfig('ACCOUNTS', defaults, { ...base, ACCOUNTS_REDIRECT_URI: 'not-a-url' }),
  );
  // AUTH_PROVIDER 기본값(local)은 redirect 제공자를 만들지 않는다 — 설정이 없어도 기동해야 한다.
  assert.equal(buildRedirectProvider('local', {}), null);
  assert.equal(
    buildRedirectProvider('accounts', { ...base, ACCOUNTS_ISSUER: 'https://a.example' })?.id,
    'accounts',
  );
  // 조직마다 이름이 다를 수 있다.
  assert.equal(
    buildRedirectProvider('company-sso', {
      ...base,
      ACCOUNTS_PROVIDER_ID: 'company-sso',
      ACCOUNTS_ISSUER: 'https://a.example',
    })?.id,
    'company-sso',
  );
});

test('accounts HTTP 콜백은 비직원·미연결 사유를 안내하고 세션을 발급하지 않는다', async () => {
  const { default: request } = await import('supertest');
  for (const [auto, staff, reason] of [
    ['true', false, 'not_staff'],
    ['false', true, 'unlinked'],
  ] as const) {
    process.env.AUTH_AUTO_PROVISION = auto;
    accounts.staff = staff;
    const db = fakeDb();
    const app = await createApp(db);
    try {
      const api = request(app.getHttpServer());
      const walk = await walkToCallback(api);
      const response = await api
        .get(`/v1/auth/callback${walk.query}`)
        .set('cookie', cookieHeader(walk.cookies))
        .expect(302);
      assert.equal(new URL(response.headers.location).searchParams.get('auth_error'), reason);
      assert.equal(db.links.length, 0);
      assert.equal(
        setCookies(response).some((c) => c.startsWith('baton_token=')),
        false,
      );
    } finally {
      await app.close();
      accounts.staff = true;
      process.env.AUTH_AUTO_PROVISION = 'false';
    }
  }
});
