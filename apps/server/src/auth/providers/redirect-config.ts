// redirect(OAuth2/OIDC) 제공자 공통 설정. 값이 빠졌거나 모양이 틀리면 **기동 시점에** 죽는다.
// 로그인하려는 사람이 눌렀을 때 처음 알게 되면 안 된다.

export interface RedirectProviderConfig {
  providerId: string;
  /** 제공자 기준 주소. 끝 슬래시는 떼서 보관한다. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** 설정에 고정된 콜백 주소. 요청에서 온 redirect_uri 는 절대 쓰지 않는다. */
  redirectUri: string;
  scope: string;
}

const isLoopback = (url: URL) =>
  ['127.0.0.1', '::1', 'localhost'].includes(url.hostname.replace(/^\[|\]$/g, ''));

// 평문 http 는 개발용 루프백에서만 허용한다. 토큰과 시크릿이 오가는 경로다.
function requireUrl(raw: string | undefined, name: string): URL {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error(`${name} 가 올바른 절대 URL 이 아닙니다: ${raw ?? '(없음)'}`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url)))
    throw new Error(`${name} 는 https 여야 합니다(루프백 주소만 http 허용): ${raw}`);
  if (url.hash) throw new Error(`${name} 에 fragment 를 넣을 수 없습니다: ${raw}`);
  return url;
}

export function readRedirectConfig(
  prefix: string,
  defaults: { providerId: string; issuer?: string; scope: string },
  env: NodeJS.ProcessEnv = process.env,
): RedirectProviderConfig {
  const read = (key: string) => {
    const value = env[`${prefix}_${key}`];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const issuer = requireUrl(read('ISSUER') ?? defaults.issuer, `${prefix}_ISSUER`);
  const redirectUri = requireUrl(read('REDIRECT_URI'), `${prefix}_REDIRECT_URI`);
  const clientId = read('CLIENT_ID');
  const clientSecret = read('CLIENT_SECRET');
  if (!clientId) throw new Error(`${prefix}_CLIENT_ID 가 필요합니다.`);
  // PKCE 가 없는 제공자는 confidential client 다 — 시크릿 없이는 코드 교환을 할 수 없다.
  if (!clientSecret) throw new Error(`${prefix}_CLIENT_SECRET 가 필요합니다.`);
  return {
    providerId: read('PROVIDER_ID') ?? defaults.providerId,
    issuer: issuer.toString().replace(/\/+$/, ''),
    clientId,
    clientSecret,
    redirectUri: redirectUri.toString(),
    scope: read('SCOPE') ?? defaults.scope,
  };
}

// 웹의 로그인 버튼이 향하는 곳은 외부 서버가 아니라 **우리 서버**다.
// 매 시도마다 state 를 새로 만들어야 하는데 정적 URL 에는 담을 수 없기 때문이다.
// 주소는 설정에 고정된 콜백과 같은 origin 이므로 따로 환경변수를 만들지 않는다.
export function authorizeEntryUrl(redirectUri: string): string {
  return new URL('/v1/auth/authorize', redirectUri).toString();
}
