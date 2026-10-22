export interface ExternalIdentity {
  providerId: string;
  // 이메일/사용자명이 아닌 제공자의 영구 불변 식별자다.
  subject: string;
  email?: string;
  displayName?: string;
  staff?: boolean;
}

// redirect 제공자가 authorize 에서 콜백까지 넘겨야 하는 값. 둘 다 브라우저에 보이면 안 되므로
// httpOnly 쿠키로만 오간다(codeVerifier) 또는 state 에서 되계산한다(nonce).
export interface ExchangeContext {
  codeVerifier?: string;
  /** AuthService 가 이미 검증한 state. 제공자는 여기서 nonce 를 되계산한다. */
  state?: string;
}

export interface IdentityProvider {
  readonly id: string;
  readonly autoProvisionRequiresStaff?: boolean;
  logoutUrl?(webUrl: string): string;
  describe(): { kind: 'password' | 'redirect'; authorizeUrl?: string };
  authenticate?(email: string, password: string): Promise<ExternalIdentity>;
  exchange?(
    code: string,
    redirectUri: string,
    context?: ExchangeContext,
  ): Promise<ExternalIdentity>;
}

// authorize 시작에 필요한 것. codeVerifier 는 PKCE 를 쓰는 제공자만 돌려준다
// (accounts 는 PKCE 가 없다 — 설계 08 §7).
export interface AuthorizationStart {
  url: string;
  codeVerifier?: string;
}

export interface RedirectIdentityProvider extends IdentityProvider {
  /** 설정에 고정된 콜백 주소. 요청에서 받은 값을 쓰지 않는다(오픈 리다이렉트 방어). */
  readonly redirectUri: string;
  startAuthorization(state: string): Promise<AuthorizationStart>;
  exchange(code: string, redirectUri: string, context?: ExchangeContext): Promise<ExternalIdentity>;
}

export function isRedirectProvider(
  provider: IdentityProvider,
): provider is RedirectIdentityProvider {
  return (
    provider.describe().kind === 'redirect' &&
    typeof (provider as RedirectIdentityProvider).startAuthorization === 'function' &&
    typeof provider.exchange === 'function' &&
    typeof (provider as RedirectIdentityProvider).redirectUri === 'string'
  );
}

export interface AuthConfig {
  providerId: string;
  autoProvision: boolean;
  defaultOrgId?: string;
}

export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const providerId = env.AUTH_PROVIDER ?? 'local';
  const auto = env.AUTH_AUTO_PROVISION ?? 'false';
  if (!providerId.trim() || !['true', 'false'].includes(auto)) {
    throw new Error('AUTH_PROVIDER 또는 AUTH_AUTO_PROVISION 설정이 올바르지 않습니다.');
  }
  return {
    providerId,
    autoProvision: auto === 'true',
    ...(env.BATON_DEFAULT_ORG_ID?.trim() ? { defaultOrgId: env.BATON_DEFAULT_ORG_ID.trim() } : {}),
  };
}

// accounts/OIDC 구현체는 이 목록에 등록한다. 제공자 오류 시 local로 우회하지 않는다.
export const IDENTITY_PROVIDERS = Symbol('IDENTITY_PROVIDERS');
export class IdentityProviderRegistry {
  readonly active: IdentityProvider;
  constructor(
    providers: IdentityProvider[],
    readonly config: AuthConfig = readAuthConfig(),
  ) {
    const byId = new Map<string, IdentityProvider>();
    for (const provider of providers) {
      if (!provider.id || byId.has(provider.id))
        throw new Error('중복되거나 비어 있는 인증 제공자 ID');
      byId.set(provider.id, provider);
    }
    const active = byId.get(config.providerId);
    if (!active) throw new Error(`등록되지 않은 인증 제공자: ${config.providerId}`);
    this.active = active;
  }
}
