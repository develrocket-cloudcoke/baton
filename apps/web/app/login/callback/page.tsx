'use client';

import React, { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api-client';

/// redirect 제공자로 로그인한 뒤 서버가 브라우저를 여기로 돌려보낸다.
///
/// 세션 토큰은 쿼리가 아니라 **fragment** 로 온다 — 쿼리에 실으면 웹 서버 접근 로그와
/// Referer 헤더에 그대로 남는다. fragment 는 서버로 전송되지 않으므로 이 페이지의 JS 만 본다.
/// 코드 교환은 이미 서버에서 끝났다(설계 08 §7 — client_secret 은 브라우저에 두지 않는다).
export default function LoginCallbackPage() {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (!token) {
      setFailed(true);
      return;
    }
    apiClient.setToken(token);
    // 주소창과 히스토리에 토큰을 남기지 않는다.
    window.history.replaceState(null, '', '/login/callback');
    // 전체 이동이라 AuthProvider 가 처음부터 다시 뜨고, 저장된 토큰으로 사용자를 읽는다.
    window.location.replace('/requests');
  }, []);

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center px-4 text-center">
      {failed ? (
        <>
          <p className="text-sm font-semibold text-slate-900">로그인을 마치지 못했습니다.</p>
          <a href="/login" className="mt-3 text-xs font-semibold text-indigo-600 hover:underline">
            다시 로그인
          </a>
        </>
      ) : (
        <p className="text-sm text-slate-600">로그인 중…</p>
      )}
    </div>
  );
}
