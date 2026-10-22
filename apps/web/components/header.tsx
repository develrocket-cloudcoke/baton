'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { ConfirmModal } from '@/components/ui/modal';
import { isPublicPath } from '@/lib/public-paths';
import {
  RotateCcw,
  PlusCircle,
  Inbox,
  User as UserIcon,
  Laptop,
  Users,
  Network,
  UserPlus,
  ShieldCheck
} from 'lucide-react';

export function Header() {
  const pathname = usePathname();
  const { currentUser, switchUser, users, isAdmin, switcherEnabled, signOut, authReady, isAuthenticated } =
    useAuth();
  const apiMode = apiClient.getMode();

  // Mock 데이터 초기화 확인 모달 상태 (window.confirm 대체)
  const [isResetModalOpen, setIsResetModalOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  // URL 쿼리 파라미터(?modal=resetMock) 연동
  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (new URLSearchParams(window.location.search).get('modal') === 'resetMock') {
        setIsResetModalOpen(true);
      }
    }
  }, []);

  const handleReset = async () => {
    try {
      setIsResetting(true);
      await apiClient.resetMockData();
      window.location.reload();
    } finally {
      setIsResetting(false);
      setIsResetModalOpen(false);
    }
  };

  // 로그인하지 않았으면 헤더를 그리지 않는다.
  //
  // AuthGate 는 /login 을 통과시키는데, 헤더가 그 바깥(layout)에 있어서 로그인 화면에도
  // 메뉴와 로그아웃 버튼이 그대로 보였다. 로그아웃 직후에도 마찬가지였다.
  if (!authReady || !isAuthenticated || isPublicPath(pathname)) return null;

  return (
    <>
      <header className="sticky top-0 z-40 w-full border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* 로고 & 네비게이션 */}
        <div className="flex items-center gap-6">
          <Link href="/requests" className="flex items-center gap-2 group">
            {/* 로고 원본은 branding/baton-logo-source.png */}
            <img src="/baton-logo.png" alt="Baton" className="h-9 w-9 rounded-lg shadow-sm transition group-hover:opacity-90" />
            <div>
              <div className="flex items-center gap-1.5 font-bold text-slate-900 leading-none">
                <span>Baton</span>
                <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700 border border-indigo-200">
                  MVP
                </span>
              </div>
              <p className="text-[11px] text-slate-500 mt-0.5 hidden sm:block">
                Pass the work, keep the context
              </p>
            </div>
          </Link>

          {/* 메인 메뉴 */}
          <nav className="flex items-center gap-1">
            <Link
              href="/requests"
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition',
                pathname === '/requests'
                  ? 'bg-slate-100 text-slate-900 font-semibold'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              )}
            >
              <Inbox className="w-4 h-4" />
              <span>요청 목록</span>
            </Link>
            <Link
              href="/requests/new"
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition',
                pathname === '/requests/new'
                  ? 'bg-indigo-50 text-indigo-700 font-semibold'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              )}
            >
              <PlusCircle className="w-4 h-4" />
              <span>새 요청</span>
            </Link>
            <Link
              href="/members"
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition',
                pathname === '/members'
                  ? 'bg-slate-100 text-slate-900 font-semibold'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              )}
            >
              <Users className="w-4 h-4" />
              <span>구성원</span>
            </Link>
            <Link
              href="/me/devices"
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition',
                pathname === '/me/devices'
                  ? 'bg-slate-100 text-slate-900 font-semibold'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              )}
            >
              <Laptop className="w-4 h-4" />
              <span>내 디바이스</span>
            </Link>

            {/* 관리자 메뉴 (ORG_ADMIN만 노출) */}
            {isAdmin && (
              <div className="flex items-center gap-1 pl-2 ml-2 border-l border-slate-200">
                <span className="flex items-center gap-1 text-[11px] font-semibold text-purple-700 bg-purple-50 border border-purple-200 rounded px-1.5 py-0.5 mr-1">
                  <ShieldCheck className="w-3 h-3" />
                  관리자
                </span>
                <Link
                  href="/admin/teams"
                  className={cn(
                    'flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition',
                    pathname === '/admin/teams'
                      ? 'bg-purple-100 text-purple-900 font-semibold'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  )}
                >
                  <Users className="w-3.5 h-3.5" />
                  <span>팀 관리</span>
                </Link>
                <Link
                  href="/admin/team-links"
                  className={cn(
                    'flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition',
                    pathname === '/admin/team-links'
                      ? 'bg-purple-100 text-purple-900 font-semibold'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  )}
                >
                  <Network className="w-3.5 h-3.5" />
                  <span>팀 링크</span>
                </Link>
                <Link
                  href="/admin/users"
                  className={cn(
                    'flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition',
                    pathname === '/admin/users'
                      ? 'bg-purple-100 text-purple-900 font-semibold'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  )}
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  <span>사용자 생성</span>
                </Link>
              </div>
            )}
          </nav>
        </div>

        {/* 우측 컨트롤: 모드, 리셋, 사용자 스위처 */}
        <div className="flex items-center gap-3">
          {/* API 모드 뱃지 */}
          <div className="hidden sm:flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600 border border-slate-200">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="font-mono uppercase font-bold text-[11px]">{apiMode} API</span>
          </div>

          {/* 리셋 버튼 (Mock 모드 전용) */}
          {apiMode === 'mock' && (
            <button
              onClick={() => setIsResetModalOpen(true)}
              title="초기 시나리오 데이터로 리셋"
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition border border-slate-200"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span className="hidden md:inline">초기화</span>
            </button>
          )}

          {/* 사용자 전환 스위처 — 켰을 때만 보인다. 켜져 있으면 아무 계정이나 될 수 있다 */}
          <div
            className={cn(
              'flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1 shadow-sm',
              !switcherEnabled && 'hidden',
            )}
          >
            <div className="flex items-center gap-1 px-1.5 text-xs font-semibold text-slate-600">
              <UserIcon className="w-3.5 h-3.5 text-slate-400" />
              <span className="hidden xl:inline">역할:</span>
            </div>
            {users.map((user) => {
              const isActive = currentUser.id === user.id;
              let badgeColor = 'bg-slate-400';
              if (user.id === 'user_admin_id') badgeColor = 'bg-purple-600';
              else if (user.id === 'user_a_id') badgeColor = 'bg-blue-600';
              else if (user.id === 'user_b_id') badgeColor = 'bg-emerald-600';
              else if (user.id === 'user_c_id') badgeColor = 'bg-teal-500';
              else if (user.id === 'user_d_id') badgeColor = 'bg-amber-500';

              const shortName = user.displayName.split(' ')[0];

              return (
                <button
                  key={user.id}
                  onClick={() => switchUser(user.id)}
                  title={`${user.displayName} (${user.email})`}
                  className={cn(
                    'flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition',
                    isActive
                      ? 'bg-white text-indigo-900 shadow-sm font-bold border border-slate-300 ring-1 ring-indigo-500'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
                  )}
                >
                  <span className={cn('w-2 h-2 rounded-full', badgeColor)} />
                  <span>{shortName}</span>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={signOut}
            data-testid="sign-out"
            title={`${currentUser.displayName} (${currentUser.email}) 로그아웃`}
            className="cursor-pointer rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 shadow-sm transition hover:text-slate-900"
          >
            로그아웃
          </button>
        </div>
      </div>
    </header>

    {/* Mock 초기화 확인 모달 (window.confirm 대체) */}
    <ConfirmModal
      isOpen={isResetModalOpen}
      onClose={() => setIsResetModalOpen(false)}
      onConfirm={handleReset}
      title="Mock 데이터 초기화"
      description="Mock 데이터를 초기 시나리오 상태로 리셋하시겠습니까?"
      warningText="진행 중인 모든 요청, 실행 이력 및 디바이스 상태가 초기 데모 상태로 초기화됩니다."
      confirmLabel="초기화 실행"
      cancelLabel="취소"
      variant="danger"
      isLoading={isResetting}
    />
  </>
);
}
