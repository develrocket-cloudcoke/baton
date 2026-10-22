// OAuth2 토큰·userinfo 호출의 공통부. 외부 서버가 느리거나 멈춰도 우리 요청이 매달려 있으면
// 안 되므로 전부 시간 제한을 건다(설계 08 §7 — accounts prod 는 단일 태스크다).

export const OAUTH_TIMEOUT_MS = 10_000;

async function readJson(response: Response, label: string): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    // 외부 서버가 HTML 오류 페이지를 준 경우다. 본문을 그대로 로그에 흘리지 않는다.
    throw new Error(`${label} 응답이 JSON 이 아닙니다 (status ${response.status})`);
  }
}

export async function postForm(
  url: string,
  body: URLSearchParams,
  headers: Record<string, string>,
) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      ...headers,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  });
  const json = await readJson(response, '토큰 엔드포인트');
  if (!response.ok)
    throw new Error(`토큰 교환 실패 (status ${response.status}, error ${json?.error ?? '없음'})`);
  return json;
}

export async function getJson(url: string, accessToken: string, label: string) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  });
  const json = await readJson(response, label);
  if (!response.ok) throw new Error(`${label} 호출 실패 (status ${response.status})`);
  return json;
}

export function requireAccessToken(token: any): string {
  const value = token?.access_token;
  if (typeof value !== 'string' || !value) throw new Error('응답에 access_token 이 없습니다.');
  return value;
}

export function basicAuth(clientId: string, clientSecret: string): string {
  // RFC 6749 §2.3.1: Basic 에 넣기 전에 각각 form-urlencode 한다.
  const encode = (value: string) => encodeURIComponent(value);
  return `Basic ${Buffer.from(`${encode(clientId)}:${encode(clientSecret)}`).toString('base64')}`;
}
