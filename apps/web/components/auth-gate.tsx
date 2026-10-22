'use client';

import React, { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { isSessionExpiryRedirecting } from '@/lib/api-client';
import { isPublicPath } from '@/lib/public-paths';

/// 로그인하지 않은 사람을 로그인 화면으로 보낸다.
///
/// 인증 확인이 끝나기 전(`authReady=false`)에는 **아무 판단도 하지 않는다.** 확인 전에
/// 리다이렉트하면 새로고침할 때마다 로그인 화면이 깜빡이고, 반대로 내용을 먼저 그리면
/// 로그인하지 않은 사람에게 남의 요청 목록이 한 순간 보인다.
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { authReady, isAuthenticated } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const isLoginPage = isPublicPath(pathname);

  useEffect(() => {
    if (authReady && !isAuthenticated && !isLoginPage && !isSessionExpiryRedirecting()) router.replace('/login');
  }, [authReady, isAuthenticated, isLoginPage, router]);

  if (!authReady) {
    return <div className="p-8 text-sm text-slate-500">확인 중…</div>;
  }
  if (!isAuthenticated && !isLoginPage) {
    return null;
  }
  return <>{children}</>;
}
