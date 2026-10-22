'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { apiClient, isSessionExpiryRedirecting } from '@/lib/api-client';
import { loginErrorMessage, loginRedirectAllowed, runSignOut, validReturnTo, autoReloginAllowed, RETURN_TO_KEY, AUTO_RELOGIN_KEY } from '@/lib/auth-navigation';
import { ShieldCheck } from 'lucide-react';

/// 실제 로그인 화면. 제공자가 무엇인지(`/v1/auth/describe`)에 따라 폼을 그린다.
/// - password: 이메일·비밀번호 입력 (local, 그리고 같은 방식의 제공자)
/// - redirect: 외부 인증 서버로 보내는 버튼 하나 (accounts, OIDC)
export default function LoginPage() {
  const router = useRouter();
  const { signIn, isAuthenticated, authReady } = useAuth();

  const [describe, setDescribe] = useState<{
    providerId: string;
    kind: 'password' | 'redirect';
    authorizeUrl?: string;
    logoutUrl?: string;
  } | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [passwordSignedIn, setPasswordSignedIn] = useState(false);
  const [expired, setExpired] = useState(false);
  const [autoReloginBlocked, setAutoReloginBlocked] = useState(false);
  const autoAttempted = useRef(false);
  const loginCompleted = useRef(false);

  // 콜백 거절 사유는 서버가 정한 코드만 한국어 안내로 바꾼다.
  // useSearchParams 대신 주소를 직접 읽는다 — 이 한 줄 때문에 Suspense 경계를 만들 이유가 없다.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setError(loginErrorMessage(params.get('auth_error')));
    setExpired(params.get('expired') === '1');
  }, []);

  useEffect(() => {
    apiClient
      .describeAuth()
      .then(setDescribe)
      // 서버가 응답하지 않아도 화면은 떠야 한다. 기본형(비밀번호)으로 그린다.
      .catch(() => setDescribe({ providerId: 'local', kind: 'password' }));
  }, []);

  // 콜백과 비밀번호 로그인 모두 여기서 복귀 경로를 한 번만 소비한다.
  useEffect(() => {
    if (!authReady || !isAuthenticated || isSessionExpiryRedirecting() ||
        (!passwordSignedIn && !loginRedirectAllowed(window.location.search)) || loginCompleted.current) return;
    loginCompleted.current = true;
    let destination = '/requests';
    try {
      destination = validReturnTo(window.sessionStorage.getItem(RETURN_TO_KEY)) ?? '/requests';
      window.sessionStorage.removeItem(RETURN_TO_KEY);
      window.sessionStorage.removeItem(AUTO_RELOGIN_KEY);
    } catch { /* 저장소를 쓸 수 없으면 기본 목록으로 이동한다. */ }
    router.replace(destination);
  }, [authReady, isAuthenticated, passwordSignedIn, router]);

  useEffect(() => {
    if (!expired || !authReady || isAuthenticated || isSessionExpiryRedirecting() || describe?.kind !== 'redirect' || !describe.authorizeUrl ||
        !loginRedirectAllowed(window.location.search) || autoAttempted.current) return;
    autoAttempted.current = true;
    try {
      const now = Date.now();
      if (!autoReloginAllowed(window.sessionStorage.getItem(AUTO_RELOGIN_KEY), now)) {
        setAutoReloginBlocked(true);
        return;
      }
      // 외부로 이동하기 전에 기록해야 콜백 실패·StrictMode에서도 반복하지 않는다.
      window.sessionStorage.setItem(AUTO_RELOGIN_KEY, String(now));
      window.location.assign(describe.authorizeUrl);
    } catch {
      setAutoReloginBlocked(true);
    }
  }, [expired, authReady, isAuthenticated, describe]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email.trim(), password);
      setPasswordSignedIn(true);
    } catch {
      // 어느 쪽이 틀렸는지 알려 주지 않는다. 계정 존재 여부를 흘리지 않기 위해서다.
      setError('이메일 또는 비밀번호가 올바르지 않습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4">
      <div className="mb-8 text-center">
        <img src="/baton-logo.png" alt="Baton" className="mx-auto mb-4 h-20 w-20 rounded-2xl shadow-md" />
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">Baton 로그인</h1>
      </div>

      {expired && <p role="status" className="mb-3 text-sm text-slate-600">
        로그인이 만료됐습니다. 다시 로그인합니다…
        {autoReloginBlocked && <span className="mt-1 block">최근 자동 로그인을 시도했습니다. 아래 로그인 버튼으로 다시 진행해 주세요.</span>}
      </p>}

      {/* 비밀번호 실패와 콜백 실패가 같은 자리에 뜬다. 제공자 종류와 무관하게 보여야 한다. */}
      {error && (
        <p data-testid="login-error" className="mb-3 text-xs font-semibold text-rose-700">
          {error}
        </p>
      )}

      {error && describe?.logoutUrl && (
        <button
          type="button"
          className="mb-3 rounded-lg border p-3 text-sm"
          onClick={async () => {
            await runSignOut(
              () => apiClient.setToken(null),
              () => apiClient.logout(),
              describe.logoutUrl!,
              (url) => window.location.assign(url),
            );
          }}
        >
          다른 accounts 계정으로 로그인
        </button>
      )}

      {describe?.kind === 'redirect' ? (
        <a
          href={describe.authorizeUrl ?? '#'}
          className="flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700"
        >
          <ShieldCheck className="h-4 w-4" />
          {describe.providerId} 계정으로 로그인
        </a>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">이메일</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
              className="w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">비밀번호</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              className="w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            data-testid="login-submit"
            className="w-full cursor-pointer rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-50"
          >
            {submitting ? '확인 중…' : '로그인'}
          </button>
        </form>
      )}

      {describe && (
        <p className="mt-6 text-center text-xs text-slate-500">
          인증 제공자: {describe.providerId}
        </p>
      )}
    </div>
  );
}
