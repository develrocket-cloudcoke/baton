import { createHash, randomBytes } from 'node:crypto';
import {
  AuthorizationStart,
  ExchangeContext,
  ExternalIdentity,
  RedirectIdentityProvider,
} from '../identity-provider';
import { JwksCache, verifyIdToken } from '../jwks';
import { nonceForState } from '../state';
import { authorizeEntryUrl, RedirectProviderConfig } from './redirect-config';
import { basicAuth, getJson, postForm, requireAccessToken } from './oauth-http';

// 표준 OIDC 제공자. discovery 로 엔드포인트를 찾고, JWKS 로 id_token 서명을 검증하고,
// PKCE(S256)를 붙인다. 이 중 **하나도 없는** accounts 는 별도 구현체다(accounts.provider.ts).

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

const DISCOVERY_TTL_MS = 10 * 60 * 1000;

export class OidcProvider implements RedirectIdentityProvider {
  readonly id: string;
  readonly redirectUri: string;
  private cached: { at: number; value: Discovery } | null = null;
  private inflight: Promise<Discovery> | null = null;
  private jwks: JwksCache | null = null;

  constructor(
    private readonly config: RedirectProviderConfig,
    private readonly secret: string,
  ) {
    this.id = config.providerId;
    this.redirectUri = config.redirectUri;
  }

  describe() {
    return { kind: 'redirect' as const, authorizeUrl: authorizeEntryUrl(this.redirectUri) };
  }

  private async discover(): Promise<Discovery> {
    if (this.cached && Date.now() - this.cached.at < DISCOVERY_TTL_MS) return this.cached.value;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const url = `${this.config.issuer}/.well-known/openid-configuration`;
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`discovery 응답 오류: ${response.status}`);
      const doc = (await response.json()) as Discovery;
      // OIDC Discovery 4.3: 문서가 말하는 issuer 가 우리가 물어본 issuer 와 같아야 한다.
      // 이걸 빼면 가로챈 discovery 문서로 엔드포인트를 통째로 바꿔치기할 수 있다.
      if (doc?.issuer !== this.config.issuer)
        throw new Error('discovery 문서의 issuer 가 설정과 다릅니다.');
      for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const)
        if (typeof doc[key] !== 'string' || !doc[key])
          throw new Error(`discovery 문서에 ${key} 가 없습니다.`);
      this.cached = { at: Date.now(), value: doc };
      this.jwks = new JwksCache(doc.jwks_uri);
      return doc;
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async startAuthorization(state: string): Promise<AuthorizationStart> {
    const doc = await this.discover();
    const methods = doc.code_challenge_methods_supported;
    // 기본은 PKCE 를 붙인다. 제공자가 지원 목록을 밝히면서 S256 을 빼 놓은 경우에만 뺀다.
    const usePkce = !Array.isArray(methods) || methods.includes('S256');
    const codeVerifier = usePkce ? randomBytes(32).toString('base64url') : undefined;
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('scope', this.config.scope);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonceForState(this.secret, state));
    if (codeVerifier) {
      url.searchParams.set(
        'code_challenge',
        createHash('sha256').update(codeVerifier).digest('base64url'),
      );
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return { url: url.toString(), codeVerifier };
  }

  async exchange(
    code: string,
    _redirectUri: string,
    context?: ExchangeContext,
  ): Promise<ExternalIdentity> {
    // redirect_uri 는 인자가 아니라 **설정 값**을 쓴다. 콜백 요청에 실려 온 값을 그대로
    // 되돌려 보내면 오픈 리다이렉트의 통로가 된다(설계 08 §7 결함 1).
    const doc = await this.discover();
    if (!context?.state) throw new Error('state 없이 코드를 교환할 수 없습니다.');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: this.config.clientId,
    });
    if (context.codeVerifier) body.set('code_verifier', context.codeVerifier);
    const methods = doc.token_endpoint_auth_methods_supported;
    const usePost =
      Array.isArray(methods) &&
      methods.includes('client_secret_post') &&
      !methods.includes('client_secret_basic');
    const headers: Record<string, string> = {};
    if (usePost) body.set('client_secret', this.config.clientSecret);
    else headers.authorization = basicAuth(this.config.clientId, this.config.clientSecret);

    const token = await postForm(doc.token_endpoint, body, headers);
    if (!this.jwks) throw new Error('JWKS 준비 전입니다.');
    const claims = await verifyIdToken(token?.id_token, this.jwks, {
      issuer: this.config.issuer,
      audience: this.config.clientId,
      nonce: nonceForState(this.secret, context.state),
    });

    let email = typeof claims.email === 'string' ? claims.email : undefined;
    let name =
      typeof claims.name === 'string'
        ? claims.name
        : typeof claims.preferred_username === 'string'
          ? claims.preferred_username
          : undefined;
    // 이메일은 표시용이라 없어도 로그인은 된다. 다만 scope 설정에 따라 id_token 에 안 실리는
    // 제공자가 있어서, userinfo 가 있으면 한 번만 더 물어본다.
    if (!email && doc.userinfo_endpoint) {
      try {
        const info = await getJson(
          doc.userinfo_endpoint,
          requireAccessToken(token),
          'userinfo 엔드포인트',
        );
        // userinfo 의 sub 는 id_token 의 sub 와 같아야 한다(OIDC Core 5.3.2).
        if (info?.sub === claims.sub) {
          if (typeof info.email === 'string') email = info.email;
          if (!name && typeof info.name === 'string') name = info.name;
        }
      } catch {
        // 표시용 값을 못 얻은 것뿐이다. 신원은 이미 id_token 으로 확정됐다.
      }
    }
    return {
      providerId: this.id,
      subject: claims.sub as string,
      email,
      displayName: name ?? email,
    };
  }
}
