import { RedirectIdentityProvider } from '../identity-provider';
import { sessionSecret } from '../state';
import { AccountsProvider } from './accounts.provider';
import { OidcProvider } from './oidc.provider';
import { readRedirectConfig, RedirectProviderConfig } from './redirect-config';

// AUTH_PROVIDER 가 가리킬 때만 만든다. 늘 만들면 ACCOUNTS_CLIENT_SECRET 이 없는
// 개발·CI 환경에서 서버가 기동조차 못 한다. 기본값(local)은 여기 오지 않는다.

interface Kind {
  prefix: string;
  defaults: { providerId: string; issuer?: string; scope: string };
  make: (config: RedirectProviderConfig, secret: string) => RedirectIdentityProvider;
}

const KINDS: Kind[] = [
  {
    prefix: 'ACCOUNTS',
    // scope 는 실계정이 없어 아직 확인하지 못했다. 클라이언트 등록 때 확인해 고친다(설계 08 §7).
    defaults: {
      providerId: 'accounts',
      issuer: 'https://accounts.example.com',
      scope: 'openid profile email',
    },
    make: (config) => new AccountsProvider(config),
  },
  {
    prefix: 'OIDC',
    defaults: { providerId: 'oidc', scope: 'openid profile email' },
    make: (config, secret) => new OidcProvider(config, secret),
  },
];

export function buildRedirectProvider(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): RedirectIdentityProvider | null {
  for (const kind of KINDS) {
    // 조직마다 이름이 다를 수 있다. <PREFIX>_PROVIDER_ID 로 AUTH_PROVIDER 값과 맞춘다.
    const id = env[`${kind.prefix}_PROVIDER_ID`]?.trim() || kind.defaults.providerId;
    if (id !== providerId) continue;
    const config = readRedirectConfig(kind.prefix, { ...kind.defaults, providerId: id }, env);
    return kind.make(config, sessionSecret(env));
  }
  return null;
}
