import {
  AuthorizationStart,
  ExchangeContext,
  ExternalIdentity,
  RedirectIdentityProvider,
} from '../identity-provider';
import { authorizeEntryUrl, RedirectProviderConfig } from './redirect-config';
import { getJson, postForm, requireAccessToken } from './oauth-http';

// 사내 accounts 어댑터. **표준 OIDC 가 아니다**(설계 08 §7):
//   discovery 없음 · id_token 없음 · JWKS 없음 · PKCE 없음
// 인터페이스는 3절의 OIDC 모양(authorize → token → userinfo)을 그대로 두고,
// 비표준인 부분은 전부 이 파일 안에서만 흡수한다. 밖으로 새면 나중에 못 바꾼다.

export const ACCOUNTS_ENDPOINTS = {
  authorize: '/oauth/v2/authorize',
  token: '/oauth/v2/token',
  userinfo: '/oauth/v2/user',
} as const;

export class AccountsProvider implements RedirectIdentityProvider {
  readonly autoProvisionRequiresStaff = true;
  readonly id: string;
  readonly redirectUri: string;

  constructor(private readonly config: RedirectProviderConfig) {
    this.id = config.providerId;
    this.redirectUri = config.redirectUri;
  }

  logoutUrl(webUrl: string) {
    const url = new URL(`${this.config.issuer}/oauth/logout`);
    url.searchParams.set('post_logout_redirect_uri', new URL('/login', webUrl).toString());
    return url.toString();
  }

  describe() {
    return { kind: 'redirect' as const, authorizeUrl: authorizeEntryUrl(this.redirectUri) };
  }

  private endpoint(key: keyof typeof ACCOUNTS_ENDPOINTS) {
    return `${this.config.issuer}${ACCOUNTS_ENDPOINTS[key]}`;
  }

  // PKCE 가 없으므로 code 가 가로채이면 그대로 쓸 수 있다. 우리가 걸 수 있는 자물쇠는
  // state(로그인 CSRF)와 client_secret(교환은 서버만 가능) 둘뿐이다.
  async startAuthorization(state: string): Promise<AuthorizationStart> {
    const url = new URL(this.endpoint('authorize'));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('scope', this.config.scope);
    url.searchParams.set('state', state);
    return { url: url.toString() };
  }

  async exchange(
    code: string,
    _redirectUri: string,
    _context?: ExchangeContext,
  ): Promise<ExternalIdentity> {
    // 인자로 온 redirect_uri 를 쓰지 않는다. accounts 는 미등록 client_id 에도 임의
    // redirect_uri 를 307 로 돌려주므로(설계 08 §7 결함 1) 설정 고정값만 신뢰한다.
    const token = await postForm(
      this.endpoint('token'),
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
        client_id: this.config.clientId,
        // Basic 이 아니라 본문으로 보낸다. 표준 협상(discovery)이 없어 어느 쪽을 받는지
        // 물어볼 방법이 없으므로 accounts 어댑터는 본문 방식을 사용한다.
        client_secret: this.config.clientSecret,
      }),
      {},
    );
    // id_token 이 없으므로 신원은 userinfo 호출로 얻는다. 여기가 accounts 의 핵심 차이다.
    const info = await getJson(
      this.endpoint('userinfo'),
      requireAccessToken(token),
      'accounts userinfo',
    );
    const subject = typeof info?.id === 'number' ? String(info.id) : info?.id;
    // subject 는 `id` 다. `uid` 는 사용자명 성격이라 바뀔 수 있고, email 은 더더욱 아니다(§7).
    if (typeof subject !== 'string' || !subject.trim())
      throw new Error('accounts userinfo 에 id 가 없습니다.');
    const email = typeof info.email === 'string' ? info.email : undefined;
    const name = typeof info.name === 'string' ? info.name : undefined;
    // 발급 시점 claim 대신 accounts의 실시간 직원 판정만 신뢰한다. 실패는 자동 가입 불가다.
    let staff = false;
    try {
      const me = await getJson(
        `${this.config.issuer}/auth/v2/me`,
        requireAccessToken(token),
        'accounts staff',
      );
      staff = me?.isAdmin === true;
    } catch {
      /* 토큰·응답 본문을 기록하지 않는다. */
    }
    return {
      providerId: this.id,
      subject: subject.trim(),
      email,
      displayName: name ?? email,
      staff,
    };
  }
}
