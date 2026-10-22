import 'reflect-metadata';
import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, before } from 'node:test';
import { AddressInfo } from 'node:net';
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  sign as signData,
} from 'node:crypto';

// 표준 OIDC 어댑터 계약 테스트. discovery·JWKS·PKCE 를 **실제로 쓰는** 가짜 제공자를 띄운다.
// accounts 는 이 셋이 전부 없어서 별도 구현체다(auth-accounts.test.ts).

const CLIENT_ID = 'baton-oidc-client';
const CLIENT_SECRET = 'baton-oidc-secret';
const REDIRECT_URI = 'http://127.0.0.1:3998/v1/auth/callback';
const WEB_URL = 'http://127.0.0.1:4322';

process.env.JWT_SECRET = 'oidc-contract-test-secret';
process.env.WEB_URL = WEB_URL;

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...(publicKey.export({ format: 'jwk' }) as any),
  kid: 'test-key-1',
  use: 'sig',
  alg: 'RS256',
};

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** RS256 id_token 을 만든다. alg 를 바꿔 공격 상황도 만들 수 있다. */
function makeIdToken(
  claims: Record<string, unknown>,
  options: { alg?: string; kid?: string } = {},
) {
  const alg = options.alg ?? 'RS256';
  const header = { alg, typ: 'JWT', kid: options.kid === undefined ? jwk.kid : options.kid };
  const body = `${b64(header)}.${b64(claims)}`;
  if (alg === 'none') return `${body}.`;
  // 알고리즘 혼동 공격: 공개 키(modulus)를 HMAC 비밀로 써서 서명한다.
  if (alg === 'HS256')
    return `${body}.${createHmac('sha256', jwk.n).update(body).digest('base64url')}`;
  return `${body}.${signData('sha256', Buffer.from(body), privateKey).toString('base64url')}`;
}

interface FakeOp {
  base: string;
  tokenRequests: Array<{ form: Record<string, string>; authorization: string }>;
  /** 다음 응답의 id_token 을 바꿔치기한다(검증 실패 경로 확인용). */
  idTokenOverride: string | null;
  discoveryIssuerOverride: string | null;
  close(): Promise<void>;
}

async function startFakeOp(): Promise<FakeOp> {
  const codes = new Map<string, { challenge: string; nonce: string }>();
  const tokens = new Set<string>();
  const state: FakeOp = {
    base: '',
    tokenRequests: [],
    idTokenOverride: null,
    discoveryIssuerOverride: null,
    close: async () => {},
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/.well-known/openid-configuration')
      return json(200, {
        issuer: state.discoveryIssuerOverride ?? state.base,
        authorization_endpoint: `${state.base}/authorize`,
        token_endpoint: `${state.base}/token`,
        jwks_uri: `${state.base}/jwks`,
        userinfo_endpoint: `${state.base}/userinfo`,
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      });

    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });

    if (url.pathname === '/authorize') {
      const challenge = url.searchParams.get('code_challenge') ?? '';
      // PKCE 를 요구하는 제공자를 흉내 낸다. 빠뜨리면 여기서 걸린다.
      if (!challenge || url.searchParams.get('code_challenge_method') !== 'S256')
        return json(400, { error: 'invalid_request' });
      const code = `oidc-code-${codes.size + 1}`;
      codes.set(code, { challenge, nonce: url.searchParams.get('nonce') ?? '' });
      const back = new URL(url.searchParams.get('redirect_uri') as string);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    if (url.pathname === '/token') {
      const raw = await new Promise<string>((resolve) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => resolve(body));
      });
      const form = Object.fromEntries(new URLSearchParams(raw));
      const authorization = String(req.headers.authorization ?? '');
      state.tokenRequests.push({ form, authorization });
      const expected = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
      if (authorization !== expected) return json(401, { error: 'invalid_client' });
      const entry = codes.get(form.code ?? '');
      if (!entry) return json(400, { error: 'invalid_grant' });
      codes.delete(form.code as string);
      const verified =
        createHash('sha256')
          .update(form.code_verifier ?? '')
          .digest('base64url') === entry.challenge;
      if (!verified) return json(400, { error: 'invalid_grant' });
      const access = `oidc-access-${tokens.size + 1}`;
      tokens.add(access);
      const now = Math.floor(Date.now() / 1000);
      return json(200, {
        access_token: access,
        token_type: 'Bearer',
        id_token:
          state.idTokenOverride ??
          makeIdToken({
            iss: state.base,
            sub: 'oidc-subject-1',
            aud: CLIENT_ID,
            exp: now + 300,
            iat: now,
            nonce: entry.nonce,
            email: 'sso@example.test',
            name: 'SSO 사용자',
          }),
      });
    }

    if (url.pathname === '/userinfo') {
      const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!tokens.has(token)) return json(401, { error: 'unauthorized' });
      return json(200, { sub: 'oidc-subject-1', email: 'sso@example.test', name: 'SSO 사용자' });
    }

    json(404, { error: 'not_found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}

function fakeDb() {
  const users: any[] = [];
  const links: any[] = [];
  return {
    users,
    links,
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
      upsert: async ({ where, create }: any) => create,
    },
  };
}

let op: FakeOp;

before(async () => {
  op = await startFakeOp();
  process.env.AUTH_PROVIDER = 'oidc';
  process.env.OIDC_ISSUER = op.base;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = CLIENT_SECRET;
  process.env.OIDC_REDIRECT_URI = REDIRECT_URI;
  process.env.AUTH_AUTO_PROVISION = 'true';
});
after(async () => {
  process.env.AUTH_AUTO_PROVISION = 'false';
  await op?.close();
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

test('표준 OIDC 한 바퀴: discovery → PKCE authorize → id_token 검증 → Baton 세션', async () => {
  const { default: request } = await import('supertest');
  const { AuthService } = await import('./auth/auth.service');
  const db = fakeDb();
  const app = await createApp(db);
  try {
    const api = request(app.getHttpServer());
    assert.deepEqual((await api.get('/v1/auth/describe').expect(200)).body, {
      providerId: 'oidc',
      kind: 'redirect',
      authorizeUrl: 'http://127.0.0.1:3998/v1/auth/authorize',
    });

    const start = await api.get('/v1/auth/authorize').expect(302);
    const cookies = setCookies(start);
    const authorizeUrl = new URL(start.headers.location);
    assert.equal(authorizeUrl.origin, op.base);
    assert.equal(authorizeUrl.pathname, '/authorize');
    assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
    const challenge = authorizeUrl.searchParams.get('code_challenge') as string;
    const stateValue = authorizeUrl.searchParams.get('state') as string;
    const nonce = authorizeUrl.searchParams.get('nonce') as string;
    assert.ok(challenge && nonce);
    // nonce 는 state 에서 만들되 **같은 값이면 안 된다** — state 는 외부에 이미 노출된 값이다.
    assert.notEqual(nonce, stateValue);

    // verifier 는 브라우저 주소가 아니라 httpOnly 쿠키로만 간다. 주소에 실리면 PKCE 가 무의미하다.
    const verifierCookie = cookies.find((c) => c.startsWith('baton_auth_verifier=')) as string;
    assert.ok(verifierCookie, 'verifier 쿠키가 있어야 한다');
    assert.match(verifierCookie, /HttpOnly/);
    const verifier = decodeURIComponent(verifierCookie.split(';')[0].split('=')[1]);
    assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge);
    assert.equal(authorizeUrl.search.includes(verifier), false);
    assert.equal(authorizeUrl.search.includes(CLIENT_SECRET), false);

    const hop = await fetch(authorizeUrl, { redirect: 'manual' });
    const back = new URL(hop.headers.get('location') as string);
    const callback = await api
      .get(`/v1/auth/callback${back.search}`)
      .set('cookie', cookieHeader(cookies))
      .expect(302);

    const location = new URL(callback.headers.location);
    assert.equal(location.pathname, '/login/callback');
    const token = new URLSearchParams(location.hash.slice(1)).get('token') as string;
    const claims = await app.get(AuthService).current(`Bearer ${token}`);
    assert.equal(db.links.length, 1);
    assert.deepEqual(
      { providerId: db.links[0].providerId, subject: db.links[0].subject },
      { providerId: 'oidc', subject: 'oidc-subject-1' },
    );
    assert.equal(claims.sub, db.links[0].userId);
    assert.equal(db.users[0].email, 'sso@example.test');
    assert.equal(db.users[0].displayName, 'SSO 사용자');

    // 클라이언트 인증은 Basic, code_verifier 는 본문. 시크릿은 서버→서버로만 갔다.
    const last = op.tokenRequests.at(-1) as FakeOp['tokenRequests'][number];
    assert.match(last.authorization, /^Basic /);
    assert.equal(last.form.code_verifier, verifier);
    assert.equal(last.form.redirect_uri, REDIRECT_URI);
    assert.equal(last.form.client_secret, undefined);
  } finally {
    await app.close();
  }
});

test('PKCE verifier 가 어긋나면 제공자가 거부하고 세션도 없다', async () => {
  const { default: request } = await import('supertest');
  const db = fakeDb();
  const app = await createApp(db);
  try {
    const api = request(app.getHttpServer());
    const start = await api.get('/v1/auth/authorize').expect(302);
    const cookies = setCookies(start);
    const hop = await fetch(new URL(start.headers.location), { redirect: 'manual' });
    const back = new URL(hop.headers.get('location') as string);
    // state 쿠키는 그대로 두고 verifier 만 바꿔치기한다(코드 가로채기 상황).
    const tampered = cookies.map((c) =>
      c.startsWith('baton_auth_verifier=') ? 'baton_auth_verifier=wrong-verifier' : c,
    );
    const res = await api
      .get(`/v1/auth/callback${back.search}`)
      .set('cookie', cookieHeader(tampered))
      .expect(302);
    assert.equal(new URL(res.headers.location).pathname, '/login');
    assert.equal(db.links.length, 0);
  } finally {
    await app.close();
  }
});

test('id_token 검증: alg 혼동·발급자·대상·만료·nonce·모르는 kid 를 모두 거부', async () => {
  const { JwksCache, verifyIdToken } = await import('./auth/jwks');
  const jwks = new JwksCache(`${op.base}/jwks`);
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: op.base,
    sub: 'oidc-subject-1',
    aud: CLIENT_ID,
    exp: now + 300,
    iat: now,
    nonce: 'n-1',
  };
  const options = { issuer: op.base, audience: CLIENT_ID, nonce: 'n-1' };
  // 정상 토큰은 통과한다 — 아래 거부들이 "무조건 실패" 가 아님을 먼저 못박는다.
  assert.equal((await verifyIdToken(makeIdToken(claims), jwks, options)).sub, 'oidc-subject-1');

  const rejects = (token: string, opts = options) =>
    assert.rejects(() => verifyIdToken(token, jwks, opts));
  // 서명 없음 / 공개 키를 HMAC 비밀로 쓴 알고리즘 혼동
  await rejects(makeIdToken(claims, { alg: 'none' }));
  await rejects(makeIdToken(claims, { alg: 'HS256' }));
  // 본문만 바꿔치기한 토큰(서명 불일치)
  const [h, , s] = makeIdToken(claims).split('.');
  await rejects(`${h}.${b64({ ...claims, sub: 'someone-else' })}.${s}`);
  // 발급자·대상·만료·nonce
  await rejects(makeIdToken({ ...claims, iss: 'https://evil.example' }));
  await rejects(makeIdToken({ ...claims, aud: 'another-client' }));
  await rejects(makeIdToken({ ...claims, exp: now - 3600 }));
  await rejects(makeIdToken({ ...claims, nonce: 'n-2' }));
  await rejects(makeIdToken({ ...claims, sub: '' }));
  // 대상이 여럿이면 azp 로 우리를 지목해야 한다(OIDC Core 3.1.3.7)
  await rejects(makeIdToken({ ...claims, aud: [CLIENT_ID, 'other'] }));
  assert.equal(
    (
      await verifyIdToken(
        makeIdToken({ ...claims, aud: [CLIENT_ID, 'other'], azp: CLIENT_ID }),
        jwks,
        options,
      )
    ).sub,
    'oidc-subject-1',
  );
  // JWKS 에 없는 kid
  await rejects(makeIdToken(claims, { kid: 'unknown-kid' }));
});

test('discovery 문서의 issuer 가 설정과 다르면 authorize 자체를 거절한다', async () => {
  const { default: request } = await import('supertest');
  const db = fakeDb();
  op.discoveryIssuerOverride = 'https://evil.example';
  const app = await createApp(db);
  try {
    // 가로챈 discovery 로 엔드포인트를 통째로 바꿔치기하는 경로를 여기서 끊는다.
    await request(app.getHttpServer()).get('/v1/auth/authorize').expect(503);
  } finally {
    op.discoveryIssuerOverride = null;
    await app.close();
  }
});
