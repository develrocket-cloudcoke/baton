export function loginErrorMessage(reason: string | null): string | null {
  if (!reason) return null;
  if (reason === 'not_staff')
    return '사내 직원으로 확인되지 않았습니다. 소셜 계정 대신 사내 계정으로 로그인하거나 관리자에게 직원 권한을 확인해 주세요.';
  if (reason === 'unlinked')
    return 'Baton 계정과 연결되지 않은 신원입니다. 관리자에게 계정 연결을 요청해 주세요.';
  return '로그인을 마치지 못했습니다. 다시 시도해 주세요.';
}

export function loginRedirectAllowed(search: string): boolean {
  return !new URLSearchParams(search).has('auth_error');
}

export function logoutDestination(
  description: { kind: string; logoutUrl?: string } | null,
): string | null {
  return description?.kind === 'redirect' ? (description.logoutUrl ?? null) : null;
}

// 토큰·캐시를 먼저 지운다. Baton 연결이 끊겨도 외부 계정 전환은 가능하게 한다.
export async function runSignOut(
  clear: () => void,
  revoke: () => Promise<void>,
  destination: string | null,
  navigate: (url: string) => void,
): Promise<void> {
  clear();
  try {
    await revoke();
  } catch {
    /* 로컬 토큰 삭제는 이미 끝났다. */
  }
  if (destination) navigate(destination);
}

export const RETURN_TO_KEY = 'baton_return_to';
export const AUTO_RELOGIN_KEY = 'baton_auto_relogin_at';
export const AUTO_RELOGIN_INTERVAL_MS = 5 * 60 * 1000;

/** 브라우저가 정규화한 뒤에도 같은 사이트의 로그인 이외 경로여야 한다. */
export function validReturnTo(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value, 'https://baton.invalid');
    const pathname = decodeURIComponent(url.pathname);
    if (url.origin !== 'https://baton.invalid' || pathname.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(pathname)) return null;
    if (pathname === '/login' || pathname.startsWith('/login/')) return null;
    return url.pathname + url.search;
  } catch {
    return null;
  }
}

export function autoReloginAllowed(lastAttempt: string | null, now: number): boolean {
  if (lastAttempt === null) return true;
  if (!lastAttempt.trim()) return false;
  const previous = Number(lastAttempt);
  return Number.isFinite(previous) && previous >= 0 && now - previous >= AUTO_RELOGIN_INTERVAL_MS;
}

/** 한 탭의 여러 401은 같은 갱신 요청을 기다린다. 성공·실패 뒤에는 다음 비행을 허용한다. */
export function singleFlight<T>(operation: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      pending = (async () => operation())().finally(() => { pending = null; });
    }
    return pending;
  };
}

export function shouldRefreshSession(path: string, status: number, retried: boolean): boolean {
  return status === 401 && !retried && !/^\/v1\/auth(?:\/|\?|$)/.test(path);
}
