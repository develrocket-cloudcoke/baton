'use client';

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Users, Mail, ShieldCheck } from 'lucide-react';
import { apiClient, API_MODE } from '@/lib/api-client';
import { OrgMember } from '@/lib/types';
import { useAuth } from '@/components/auth-provider';
import { cn } from '@/lib/utils';

/**
 * 조직 구성원 명부.
 *
 * **볼 수 있는 것과 보낼 수 있는 것은 다르다.** 여기서는 조직 전체를 보여 주고,
 * 누구에게 일을 넘길 수 있는지는 팀 링크가 정한다(새 요청 화면). 그래서 이 화면에는
 * 아무 동작도 없다 — 읽기 전용이다.
 */
export default function MembersPage() {
  const { currentUser } = useAuth();
  const { data, isLoading, error } = useQuery<OrgMember[]>({
    queryKey: ['org-members'],
    queryFn: () => apiClient.getOrgMembers(),
    enabled: API_MODE === 'real',
  });

  const members = data ?? [];
  // 서버가 팀 이름순으로 주지만, 화면에서는 팀별로 묶어 보여 준다.
  const groups = React.useMemo(() => {
    const out: Array<[string, OrgMember[]]> = [];
    for (const m of members) {
      const key = m.teams[0]?.name ?? '팀 없음';
      const last = out[out.length - 1];
      if (last && last[0] === key) last[1].push(m);
      else out.push([key, [m]]);
    }
    return out;
  }, [members]);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="border-b border-slate-200 pb-6">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-indigo-600" />
          <h1 className="text-2xl font-bold text-slate-900">조직 구성원</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700">
            {members.length}명
          </span>
        </div>
        <p className="mt-1 text-sm text-slate-600">
          같은 조직에 누가 있는지 보여 줍니다. 요청을 보낼 수 있는 대상은 팀 사이 통신 링크가
          정하므로, 여기 보이는 사람 모두에게 보낼 수 있는 것은 아닙니다.
        </p>
      </div>

      {isLoading && <p className="py-8 text-sm text-slate-500">불러오는 중…</p>}
      {error && (
        <p className="py-8 text-sm font-semibold text-rose-700">
          구성원 목록을 불러오지 못했습니다. 조직에 속해 있는지 확인해 주세요.
        </p>
      )}

      <div className="mt-6 space-y-6">
        {groups.map(([team, rows]) => (
          <section key={team}>
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">
              {team}
            </h2>
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              {rows.map((m) => (
                <div
                  key={m.id}
                  data-testid="org-member-row"
                  className={cn(
                    'flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 last:border-b-0',
                    m.id === currentUser.id && 'bg-indigo-50/40',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'h-2 w-2 rounded-full',
                        m.online ? 'bg-emerald-500' : 'bg-slate-300',
                      )}
                      title={m.online ? '온라인' : '오프라인'}
                    />
                    <span className="text-sm font-semibold text-slate-900">{m.displayName}</span>
                    {m.id === currentUser.id && (
                      <span className="text-[11px] font-semibold text-indigo-700">(나)</span>
                    )}
                    {m.orgRole === 'ORG_ADMIN' && (
                      <span className="flex items-center gap-1 rounded border border-purple-200 bg-purple-50 px-1.5 py-0.5 text-[11px] font-semibold text-purple-700">
                        <ShieldCheck className="h-3 w-3" />
                        관리자
                      </span>
                    )}
                    {m.status === 'DISABLED' && (
                      <span className="rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-500">
                        비활성
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-slate-500">
                    <Mail className="h-3.5 w-3.5" />
                    <span className="font-mono">{m.email}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
