import { sessionSecret } from './state';

// 세션 발급 뒤 브라우저를 어디로 돌려보낼지. 설정 값 하나뿐이지만 형식이 틀리면
// 로그인 마지막 단계에서만 드러나므로 기동 시점에 검사한다.
export interface SessionOptions {
  stateSecret: string;
  /** 웹 origin. 콜백이 끝나면 여기로 돌려보낸다. */
  webUrl: string;
}

export const SESSION_OPTIONS = Symbol('SESSION_OPTIONS');

export function readSessionOptions(env: NodeJS.ProcessEnv = process.env): SessionOptions {
  const raw = env.WEB_URL?.trim() || 'http://127.0.0.1:3000';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`WEB_URL 이 올바른 절대 URL 이 아닙니다: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error(`WEB_URL 은 http(s) 여야 합니다: ${raw}`);
  return { stateSecret: sessionSecret(env), webUrl: url.origin };
}
