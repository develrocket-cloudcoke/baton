'use client';

import React, { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/components/auth-provider';
import { apiClient } from '@/lib/api-client';
import { User } from '@/lib/types';
import { UserPlus, ShieldAlert, CheckCircle, Users, Mail, Key, RefreshCw } from 'lucide-react';
import {
  generateTempPassword,
  isUsableTempPassword,
  MIN_TEMP_PASSWORD_LENGTH,
} from '@/lib/temp-password';

export default function AdminUsersPage() {
  const { isAdmin, providerId } = useAuth();
  // 외부 로그인(accounts 등)이면 비밀번호 계정 생성 대신 안내를 보인다. 서버도 거부한다(409).
  const passwordAccounts = providerId === 'local';
  const queryClient = useQueryClient();

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  // 고정값을 채워 두지 않는다. 관리자가 그대로 제출하면 조직의 모든 신규 계정이
  // 알려진 같은 비밀번호로 만들어진다(전수조사 결함 3). 무작위 값은 **마운트 뒤**에
  // 만든다 — 서버 렌더에서 만들면 hydration 이 어긋난다.
  const [tempPassword, setTempPassword] = useState('');
  useEffect(() => setTempPassword(generateTempPassword()), []);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 사용자 목록
  const { data: userList = [], isLoading } = useQuery<User[]>({
    queryKey: ['admin-users'],
    queryFn: () => apiClient.getUsers(),
    enabled: isAdmin,
  });

  // 사용자 생성 뮤테이션
  const createUserMutation = useMutation({
    mutationFn: (data: { email: string; name: string; tempPassword: string }) =>
      apiClient.createOrgUser(data.email, data.name, data.tempPassword),
    onSuccess: (_user, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setEmail('');
      setName('');
      // 관리자가 본인에게 직접 전달해야 하는 값이다. 여기서 한 번 보여 주지 않으면
      // 다음 줄에서 새 비밀번호로 덮어써져 영영 알 수 없다.
      setMessage({
        type: 'success',
        text: `신규 사용자를 만들었습니다. 임시 비밀번호: ${variables.tempPassword} — 본인에게 직접 전달하세요.`,
      });
      setTempPassword(generateTempPassword());
    },
    onError: (err: Error) => {
      setMessage({ type: 'error', text: err.message });
    },
  });

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-4xl py-12 px-4 sm:px-6">
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <ShieldAlert className="mx-auto h-12 w-12 text-red-500 mb-3" />
          <h2 className="text-lg font-bold text-red-900">관리자 권한이 필요합니다</h2>
          <p className="mt-1 text-sm text-red-700">
            사용자 생성 및 관리는 조직 관리자(ORG_ADMIN)만 접근할 수 있습니다.
          </p>
        </div>
      </div>
    );
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !name.trim() || !isUsableTempPassword(tempPassword)) return;
    createUserMutation.mutate({
      email: email.trim(),
      name: name.trim(),
      tempPassword: tempPassword.trim(),
    });
  };

  return (
    <div className="mx-auto max-w-5xl py-8 px-4 sm:px-6 lg:px-8">
      {/* 헤더 */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between pb-6 border-b border-slate-200">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900">사용자 관리</h1>
            <span className="rounded-full bg-purple-100 px-2.5 py-0.5 text-xs font-semibold text-purple-800">
              ORG_ADMIN
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-600">
            조직에 새 구성원을 초대하고 임시 비밀번호를 발급합니다.
          </p>
        </div>
      </div>

      {message && (
        <div
          className={`mt-4 rounded-lg p-3 text-sm flex items-center gap-2 ${
            message.type === 'success'
              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
              : 'bg-red-50 text-red-800 border border-red-200'
          }`}
        >
          <CheckCircle className="w-4 h-4 shrink-0" />
          <span>{message.text}</span>
        </div>
      )}

      {!passwordAccounts && (
        <div className="mt-6 rounded-xl border border-indigo-100 bg-indigo-50 p-5 text-sm text-slate-700">
          <p className="font-semibold text-slate-900">
            구성원은 처음 로그인할 때 자동으로 추가됩니다.
          </p>
          <p className="mt-1 text-xs text-slate-600">
            사내 계정(accounts)으로 Baton 에 로그인하면 이 조직의 구성원(MEMBER)이 됩니다. 추가된 뒤{' '}
            <a href="/admin/teams" className="font-semibold text-indigo-700 hover:underline">
              팀 관리
            </a>
            에서 팀을 배정하세요.
          </p>
        </div>
      )}

      {/* 사용자 생성 폼 — 비밀번호 로그인(local)일 때만 */}
      {passwordAccounts && (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2 mb-4">
            <UserPlus className="w-4 h-4 text-indigo-600" />새 사용자 계정 생성
          </h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  이름 (표시명)
                </label>
                <input
                  type="text"
                  required
                  placeholder="예: 홍길동 (보안팀)"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  이메일 주소
                </label>
                <input
                  type="email"
                  required
                  placeholder="user@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  임시 비밀번호
                </label>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    required
                    minLength={MIN_TEMP_PASSWORD_LENGTH}
                    data-testid="temp-password"
                    value={tempPassword}
                    onChange={(e) => setTempPassword(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-mono text-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                  <button
                    type="button"
                    title="무작위로 다시 만들기"
                    onClick={() => setTempPassword(generateTempPassword())}
                    className="shrink-0 rounded-lg border border-slate-300 px-2.5 text-slate-600 hover:bg-slate-50"
                  >
                    <RefreshCw className="w-4 h-4" />
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  무작위로 만들어진 값입니다. 계정 생성 후 본인에게 직접 전달하세요.
                </p>
              </div>
            </div>
            <div className="flex justify-end pt-2">
              <button
                type="submit"
                disabled={
                  createUserMutation.isPending ||
                  !email.trim() ||
                  !name.trim() ||
                  !isUsableTempPassword(tempPassword)
                }
                className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition"
              >
                {createUserMutation.isPending ? '생성 중...' : '계정 생성 완료'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* 등록된 사용자 목록 */}
      <div className="mt-8 rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="p-4 bg-slate-50 border-b border-slate-200">
          <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
            <Users className="w-4 h-4 text-slate-600" />
            등록된 조직 사용자 ({userList.length}명)
          </h2>
        </div>

        {isLoading ? (
          <div className="py-12 text-center text-slate-500 text-sm">사용자 목록 로딩 중...</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {userList.map((user) => (
              <div
                key={user.id}
                className="p-4 flex items-center justify-between hover:bg-slate-50/60 transition"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-700 font-bold text-sm">
                    {user.displayName.charAt(0)}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-900 text-sm">{user.displayName}</span>
                      {/* 실서버는 목록의 orgRole 로, mock 은 seed 관리자 id 로 판단한다 */}
                      {(user as any).orgRole === 'ORG_ADMIN' || user.id === 'user_admin_id' ? (
                        <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-bold text-purple-800">
                          ORG_ADMIN
                        </span>
                      ) : (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                          MEMBER
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1">
                      <Mail className="w-3 h-3" />
                      {user.email}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 border border-emerald-200">
                    ACTIVE
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
