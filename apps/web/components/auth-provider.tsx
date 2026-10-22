'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { logoutDestination, runSignOut, validReturnTo, RETURN_TO_KEY, AUTO_RELOGIN_KEY } from '@/lib/auth-navigation';
import { User, OrgRole } from '@/lib/types';
import { SEED_USERS, SEED_USER_ORG_ROLES } from '@/lib/mock-data';
import { apiClient, API_MODE, getAuthToken, refreshAuthToken } from '@/lib/api-client';

interface AuthContextType {
  currentUser: User;
  switchUser: (userIdOrEmail: string) => void;
  isUserA: boolean;
  isUserB: boolean;
  isAdmin: boolean;
  orgRole: OrgRole;
  users: User[];
  /** 인증 확인이 끝났는지. 끝나기 전에는 화면을 판단하면 안 된다 */
  authReady: boolean;
  isAuthenticated: boolean;
  providerId: string;
  /** 역할 스위처를 쓸 수 있는지 (local + 명시적 옵트인) */
  switcherEnabled: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
}

// 역할 스위처는 **명시적으로 켰을 때만** 보인다. 켜져 있으면 아무 계정이나 될 수 있으므로
// 실제 로그인을 넣는 의미가 사라진다. 개발 편의가 필요한 사람만 켠다.
const DEV_SWITCHER = process.env.NEXT_PUBLIC_DEV_ROLE_SWITCHER === 'true';

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  // 실서버에서는 가짜 계정을 기본값으로 두지 않는다. 목록은 개발용 스위처를 켰을 때만 서버에서 채운다.
  const [users, setUsers] = useState<User[]>(API_MODE === 'real' ? [] : SEED_USERS);
  // mock 모드 기본값: B 또는 url의 as 파라미터
  const defaultUser = SEED_USERS.find((u) => u.id === 'user_b_id') || SEED_USERS[0];
  const [currentUser, setCurrentUser] = useState<User>(defaultUser);
  // mock 모드는 로그인 개념이 없으므로 처음부터 준비·인증된 것으로 둔다.
  const [authReady, setAuthReady] = useState<boolean>(API_MODE !== 'real');
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(API_MODE !== 'real');
  const [logoutUrl, setLogoutUrl] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<string>('local');
  // 실서버의 조직 역할(GET /v1/me 의 orgRole). mock 모드에서는 쓰지 않는다.
  const [serverOrgRole, setServerOrgRole] = useState<OrgRole | null>(null);

  // 사용자 초기화 및 실서버 인증 동기화
  useEffect(() => {
    let unmounted = false;

    const initAuth = async () => {
      if (API_MODE === 'mock') {
        let found = defaultUser;
        if (typeof window !== 'undefined') {
          const params = new URLSearchParams(window.location.search);
          const asParam = params.get('as')?.toLowerCase();
          if (asParam === 'admin') {
            found = SEED_USERS.find((u) => u.id === 'user_admin_id') || found;
          } else if (asParam === 'a' || asParam === 'user_a') {
            found = SEED_USERS.find((u) => u.id === 'user_a_id') || found;
          } else if (asParam === 'b' || asParam === 'user_b') {
            found = SEED_USERS.find((u) => u.id === 'user_b_id') || found;
          } else if (asParam === 'c' || asParam === 'user_c') {
            found = SEED_USERS.find((u) => u.id === 'user_c_id') || found;
          } else if (asParam === 'd' || asParam === 'user_d') {
            found = SEED_USERS.find((u) => u.id === 'user_d_id') || found;
          } else {
            const savedUserId = localStorage.getItem('baton_current_user_id');
            if (savedUserId) {
              const match = SEED_USERS.find((u) => u.id === savedUserId);
              if (match) found = match;
            }
          }
        }
        if (!unmounted) setCurrentUser(found);
        return;
      }

      // 저장된 접근 토큰 또는 서버의 갱신 쿠키로 본인 세션을 복원한다.
      // 둘 다 없으면 로그인 화면을 사용하며 개발용 계정으로 대신 로그인하지 않는다.
      try {
        const described = await apiClient.describeAuth().catch(() => null);
        if (unmounted) return;
        if (described) {
          setProviderId(described.providerId);
          setLogoutUrl(logoutDestination(described));
        }

        // 앱 재시작으로 접근 토큰이 없어도 httpOnly 갱신 쿠키로 먼저 복원한다.
        let token = getAuthToken();
        if (!token) {
          try { token = await refreshAuthToken(); } catch { /* 페어링과 무관하게 웹 로그인으로 안내한다. */ }
          if (unmounted) return;
        }
        if (token) {
          try {
            const me = await apiClient.getMe();
            if (unmounted) return;
            const u = (me as any)?.user ?? me;
            if (u?.id) {
              setCurrentUser({
                id: u.id,
                email: u.email,
                displayName: u.displayName ?? u.email,
                status: 'ACTIVE',
                createdAt: new Date(u.createdAt ?? Date.now()),
                updatedAt: new Date(u.updatedAt ?? Date.now()),
              } as User);
              setServerOrgRole(u.orgRole ?? null);
              setIsAuthenticated(true);
              // 기존 redirect 콜백은 /requests로 전체 이동한다. 그 뒤 인증 확인 시에도 복귀 표식을 소비한다.
              if (window.location.pathname !== '/login' && !window.location.pathname.startsWith('/login/')) {
                try {
                  const saved = window.sessionStorage.getItem(RETURN_TO_KEY);
                  window.sessionStorage.removeItem(RETURN_TO_KEY);
                  window.sessionStorage.removeItem(AUTO_RELOGIN_KEY);
                  if (saved !== null) {
                    const destination = validReturnTo(saved) ?? '/requests';
                    if (destination !== window.location.pathname + window.location.search) window.location.replace(destination);
                  }
                } catch { /* 저장소가 차단되어도 인증된 화면은 계속 쓴다. */ }
              }
            }
          } catch {
            // 토큰이 만료·폐기됐다. 지우고 로그인 화면으로 보낸다.
            apiClient.setToken(null);
          }
        }

        // 역할 스위처를 켰을 때만 계정 목록을 미리 받아 둔다. 평소에는 필요 없다.
        if (DEV_SWITCHER && described?.providerId === 'local') {
          const loaded = await apiClient.getUsers().catch(() => []);
          if (!unmounted && loaded.length) setUsers(loaded);
        }
      } catch (err) {
        console.warn('Real mode auth init error:', err);
      } finally {
        if (!unmounted) setAuthReady(true);
      }
    };

    initAuth();

    return () => {
      unmounted = true;
    };
  }, []);

  // SSE 이벤트 스트림 구독 (Real 모드 실시간 목록/상세 갱신)
  //
  // **로그인한 뒤에 연다.** subscribeEvents 는 구독하는 순간의 토큰을 붙잡아 두므로,
  // 로그인 전에 열면 토큰 없이 401 로 끊기고 로그인해도 다시 열리지 않는다(새로고침
  // 전까지 실시간 갱신이 죽는다). 로그아웃하면 이전 사용자의 스트림도 닫아야 한다.
  useEffect(() => {
    if (API_MODE !== 'real') return;
    if (!isAuthenticated) return;

    const unsubscribe = apiClient.subscribeEvents(
      (event) => {
        if (
          event.type === 'execution.approval_requested' ||
          event.type === 'execution.approval_decided'
        ) {
          queryClient.invalidateQueries({
            queryKey: ['execution-approvals', event.data.executionId],
          });
        }
        queryClient.invalidateQueries({ queryKey: ['requests'] });
        queryClient.invalidateQueries({ queryKey: ['request'] });
      },
      () => {
        queryClient.invalidateQueries({ queryKey: ['execution-approvals'] });
      },
    );

    return () => {
      unsubscribe();
    };
  }, [queryClient, isAuthenticated, currentUser.id]);

  const signIn = async (email: string, password: string) => {
    const res = await apiClient.login(email, password);
    const u = (res as any)?.user;
    if (!u?.id) throw new Error('로그인 응답이 올바르지 않습니다.');
    setCurrentUser({
      id: u.id,
      email: u.email,
      displayName: u.displayName ?? u.email,
      status: 'ACTIVE',
      createdAt: new Date(u.createdAt ?? Date.now()),
      updatedAt: new Date(u.updatedAt ?? Date.now()),
    } as User);
    // 로그인 응답에는 조직 역할이 없다. 관리자 메뉴가 새로고침 전까지 빠지지 않도록 바로 읽는다.
    const me = await apiClient.getMe().catch(() => null);
    setServerOrgRole((me as any)?.user?.orgRole ?? null);
    setIsAuthenticated(true);
    queryClient.clear();
  };

  const signOut = () =>
    runSignOut(
      () => {
        apiClient.setToken(null);
        setIsAuthenticated(false);
        setServerOrgRole(null);
        // 다음 사람에게 앞사람의 흔적을 남기지 않는다 — 캐시된 목록·상세도,
        // 스위처가 복원에 쓰는 마지막 계정도 같이 지운다.
        if (typeof window !== 'undefined') {
          localStorage.removeItem('baton_current_user_id');
          localStorage.removeItem('baton_current_user_email');
        }
        queryClient.clear();
      },
      () => (API_MODE === 'real' ? apiClient.logout() : Promise.resolve()),
      logoutUrl,
      (url) => window.location.assign(url),
    );

  const switchUser = async (userIdOrEmail: string) => {
    if (API_MODE === 'mock') {
      const found = users.find((u) => u.id === userIdOrEmail || u.email === userIdOrEmail);
      if (found) {
        setCurrentUser(found);
        localStorage.setItem('baton_current_user_id', found.id);
        queryClient.invalidateQueries({ queryKey: ['requests'] });
        queryClient.invalidateQueries({ queryKey: ['request'] });
        queryClient.invalidateQueries({ queryKey: ['me'] });
      }
      return;
    }

    // Real 모드: 대상 사용자 찾아서 실서버 로그인
    const found = users.find(
      (u) =>
        u.id === userIdOrEmail ||
        u.email === userIdOrEmail ||
        (userIdOrEmail === 'user_a_id' && u.email.startsWith('a@')) ||
        (userIdOrEmail === 'user_b_id' && u.email.startsWith('b@')) ||
        (userIdOrEmail === 'user_admin_id' && u.email.startsWith('admin@')),
    );

    if (found) {
      try {
        await apiClient.login(found.email, 'baton-dev-password');
        setCurrentUser(found);
        localStorage.setItem('baton_current_user_id', found.id);
        localStorage.setItem('baton_current_user_email', found.email);
        queryClient.invalidateQueries({ queryKey: ['requests'] });
        queryClient.invalidateQueries({ queryKey: ['request'] });
      } catch (err) {
        console.error('Failed to switch user:', err);
      }
    }
  };

  const isUserA = currentUser.email.startsWith('a@') || currentUser.id === 'user_a_id';
  const isUserB = currentUser.email.startsWith('b@') || currentUser.id === 'user_b_id';
  // 실서버에서는 서버가 준 역할만 믿는다. 예전에는 이메일이 admin@ 으로 시작하는지로 추측해서,
  // 실제 ORG_ADMIN 인데 관리자 메뉴가 안 보이는 경우가 있었다.
  // 추측은 seed 계정뿐인 mock 모드에만 남긴다.
  const orgRole: OrgRole =
    API_MODE === 'real'
      ? (serverOrgRole ?? 'MEMBER')
      : SEED_USER_ORG_ROLES[currentUser.id] ||
        (currentUser.email.startsWith('admin@') ? 'ORG_ADMIN' : 'MEMBER');
  const isAdmin = orgRole === 'ORG_ADMIN';

  return (
    <AuthContext.Provider
      value={{
        currentUser,
        switchUser,
        isUserA,
        isUserB,
        isAdmin,
        orgRole,
        users,
        authReady,
        isAuthenticated,
        providerId,
        switcherEnabled: DEV_SWITCHER && providerId === 'local',
        signIn,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
