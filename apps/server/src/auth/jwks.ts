import { constants, createPublicKey, KeyObject, verify as verifySignature } from 'node:crypto';

// 새 의존성 없이 id_token 을 검증한다(jose·openid-client 를 쓰지 않는다).
// 표준 OIDC 제공자만 이 경로를 탄다 — accounts 는 id_token 자체가 없다(설계 08 §7).

// 비대칭 알고리즘만 받는다. 'none' 과 HS* 를 빼는 것이 핵심이다 —
// 공개 JWKS 를 HMAC 키로 쓰게 만드는 알고리즘 혼동 공격이 그 둘로 들어온다.
const ALGORITHMS: Record<string, { hash: string; ec?: boolean; pss?: boolean }> = {
  RS256: { hash: 'sha256' },
  RS384: { hash: 'sha384' },
  RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', pss: true },
  PS384: { hash: 'sha384', pss: true },
  PS512: { hash: 'sha512', pss: true },
  ES256: { hash: 'sha256', ec: true },
  ES384: { hash: 'sha384', ec: true },
  ES512: { hash: 'sha512', ec: true },
};

export interface IdTokenClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  azp?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  [claim: string]: unknown;
}

const decodeSegment = (segment: string): any => {
  const json = Buffer.from(segment, 'base64url').toString('utf8');
  const value = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JWT 형식 오류');
  return value;
};

// JWKS 는 매 로그인마다 받아오면 느리고, 영원히 캐시하면 키 교체를 못 따라간다.
// TTL 로 갱신하되 모르는 kid 가 오면 즉시 한 번 더 받아 본다(쿨다운으로 남용은 막는다).
export class JwksCache {
  private keys: any[] = [];
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;
  constructor(
    private readonly uri: string,
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly cooldownMs = 30 * 1000,
  ) {}

  private async load(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const response = await fetch(this.uri, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`JWKS 응답 오류: ${response.status}`);
      const body: any = await response.json();
      if (!Array.isArray(body?.keys)) throw new Error('JWKS 형식 오류');
      this.keys = body.keys;
      this.fetchedAt = Date.now();
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async key(kid: string | undefined, alg: string): Promise<KeyObject> {
    const stale = () => Date.now() - this.fetchedAt > this.ttlMs;
    if (!this.keys.length || stale()) await this.load();
    let jwk = this.select(kid, alg);
    if (!jwk && Date.now() - this.fetchedAt > this.cooldownMs) {
      await this.load();
      jwk = this.select(kid, alg);
    }
    if (!jwk) throw new Error('id_token 서명 키를 찾지 못했습니다.');
    return createPublicKey({ key: jwk, format: 'jwk' });
  }

  private select(kid: string | undefined, alg: string) {
    const usable = this.keys.filter(
      (k) => k && (!k.use || k.use === 'sig') && (!k.alg || k.alg === alg),
    );
    if (kid) return usable.find((k) => k.kid === kid) ?? null;
    // kid 가 없으면 후보가 하나일 때만 쓴다. 여럿 중 아무거나 고르면 검증이 무의미해진다.
    return usable.length === 1 ? usable[0] : null;
  }
}

export interface VerifyIdTokenOptions {
  issuer: string;
  audience: string;
  nonce?: string;
  now?: number;
  /** 시계 오차 허용치. 외부 서버와 우리 시계가 몇 초 어긋나는 것으로 로그인이 막히면 안 된다. */
  clockSkewSeconds?: number;
}

export async function verifyIdToken(
  idToken: unknown,
  jwks: JwksCache,
  options: VerifyIdTokenOptions,
): Promise<IdTokenClaims> {
  if (typeof idToken !== 'string' || !idToken) throw new Error('id_token 이 없습니다.');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('id_token 형식 오류');
  const [rawHeader, rawPayload, rawSignature] = parts;
  const header = decodeSegment(rawHeader);
  const spec = ALGORITHMS[header.alg];
  if (!spec) throw new Error(`허용하지 않는 서명 알고리즘: ${header.alg}`);

  const key = await jwks.key(typeof header.kid === 'string' ? header.kid : undefined, header.alg);
  const expectedType = spec.ec ? 'ec' : 'rsa';
  // JWKS 가 알고리즘과 다른 종류의 키를 돌려주면 거부한다.
  if (key.asymmetricKeyType !== expectedType && !(spec.pss && key.asymmetricKeyType === 'rsa-pss'))
    throw new Error('서명 키 종류가 알고리즘과 맞지 않습니다.');

  const data = Buffer.from(`${rawHeader}.${rawPayload}`);
  const signature = Buffer.from(rawSignature, 'base64url');
  const keyInput: any = spec.ec
    ? { key, dsaEncoding: 'ieee-p1363' }
    : spec.pss
      ? {
          key,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
        }
      : key;
  if (!verifySignature(spec.hash, data, keyInput, signature))
    throw new Error('id_token 서명이 올바르지 않습니다.');

  const claims: IdTokenClaims = decodeSegment(rawPayload);
  const skew = options.clockSkewSeconds ?? 60;
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (claims.iss !== options.issuer) throw new Error('id_token 발급자가 다릅니다.');
  const audience = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!audience.includes(options.audience)) throw new Error('id_token 대상이 우리가 아닙니다.');
  // 대상이 여럿이면 누가 받으라고 발급한 것인지 azp 로 못박혀 있어야 한다(OIDC Core 3.1.3.7).
  if (audience.length > 1 && claims.azp !== options.audience)
    throw new Error('id_token azp 가 우리가 아닙니다.');
  if (typeof claims.exp !== 'number' || claims.exp + skew <= now)
    throw new Error('id_token 이 만료되었습니다.');
  if (typeof claims.nbf === 'number' && claims.nbf - skew > now)
    throw new Error('id_token 사용 시작 시각이 아직입니다.');
  if (typeof claims.iat !== 'number' || claims.iat - skew > now)
    throw new Error('id_token 발급 시각이 올바르지 않습니다.');
  if (options.nonce !== undefined && claims.nonce !== options.nonce)
    throw new Error('id_token nonce 가 다릅니다.');
  if (typeof claims.sub !== 'string' || !claims.sub)
    throw new Error('id_token 에 sub 가 없습니다.');
  return claims;
}
