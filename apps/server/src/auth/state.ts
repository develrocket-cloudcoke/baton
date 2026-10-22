import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// 세션 JWT 와 state 서명은 같은 비밀을 쓴다. auth.module 의 JwtModule 과 값이 어긋나면
// 재시작마다 진행 중이던 로그인이 전부 깨지므로 여기 한 곳에서만 읽는다.
//
// 운영 이미지(NODE_ENV=production)에서 JWT_SECRET 이 없으면 기동을 멈춘다.
// 이 값이 빠지면 세션이 공개된 개발용 고정값으로 서명되어 토큰 위조가 가능해진다.
// 조용히 기본값으로 떨어지는 대신 뜨지 않는 편이 안전하다.
export function sessionSecret(env: NodeJS.ProcessEnv = process.env): string {
  if (env.JWT_SECRET) {
    if (env.NODE_ENV === 'production' && env.JWT_SECRET.length < 32)
      throw new Error('JWT_SECRET 은 32자 이상이어야 합니다.');
    return env.JWT_SECRET;
  }
  if (env.NODE_ENV === 'production')
    throw new Error('JWT_SECRET 이 설정되지 않았습니다. 운영 환경에서는 개발용 기본값을 쓰지 않습니다.');
  return 'baton-development-secret';
}

// 외부 인증 서버를 거쳐 돌아오는 동안만 살아 있으면 되는 쿠키다. 경로를 /v1/auth 로 좁혀
// 다른 요청에 묻어 나가지 않게 한다.
export const AUTH_STATE_COOKIE = 'baton_auth_state';
export const AUTH_VERIFIER_COOKIE = 'baton_auth_verifier';
export const AUTH_COOKIE_PATH = '/v1/auth';
export const STATE_TTL_SECONDS = 600;

const sign = (secret: string, payload: string) =>
  createHmac('sha256', secret).update(payload).digest('base64url');

const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// state = nonce.만료.서명. 서버가 상태를 들고 있지 않아서 재시작·다중 인스턴스에도 산다.
// 같은 값을 쿠키와 authorize 쿼리 양쪽에 두고 콜백에서 맞춰 본다(double submit).
export function createState(secret: string, now = Date.now()): string {
  const payload = `${randomBytes(16).toString('base64url')}.${
    Math.floor(now / 1000) + STATE_TTL_SECONDS
  }`;
  return `${payload}.${sign(secret, payload)}`;
}

// 쿠키 값과 쿼리 값이 같고, 우리 서명이며, 아직 만료되지 않았는가. 셋을 다 봐야 한다.
// 쿠키만 보면 남이 만든 state 를 심을 수 있고, 서명만 보면 다른 사람의 로그인을 이어받을 수 있다.
export function verifyState(
  cookieValue: unknown,
  queryValue: unknown,
  secret: string,
  now = Date.now(),
): boolean {
  if (typeof cookieValue !== 'string' || typeof queryValue !== 'string') return false;
  if (!cookieValue || cookieValue.length > 512) return false;
  if (!equal(cookieValue, queryValue)) return false;
  const parts = cookieValue.split('.');
  if (parts.length !== 3) return false;
  const [nonce, exp, mac] = parts;
  if (!equal(sign(secret, `${nonce}.${exp}`), mac)) return false;
  const expires = Number(exp);
  return Number.isSafeInteger(expires) && expires * 1000 > now;
}

// id_token 의 nonce 는 state 에서 결정론적으로 뽑는다. 쿠키를 하나 덜 쓰면서도
// 콜백에서 같은 값을 다시 만들 수 있다. state 를 그대로 쓰면 외부 서버에 이미 노출된 값을
// 재사용하는 셈이라 서명을 한 번 더 건다.
export function nonceForState(secret: string, state: string): string {
  return sign(secret, `nonce:${state}`);
}

// cookie-parser 를 쓰지 않으므로 헤더를 직접 읽는다. 같은 이름이 여러 번 오면 첫 값을 쓴다.
export function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // 깨진 퍼센트 인코딩은 없는 쿠키로 본다.
    }
  }
  return out;
}
