'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import { useAuth } from '@/components/auth-provider';
import { StateBadge } from '@/components/ui/badge';
import { RequestState, RequestEntity, UserMeResponse } from '@/lib/types';
import {
  Inbox,
  Send,
  PlusCircle,
  Clock,
  ArrowRight,
  Filter,
  Users,
  User as UserIcon,
  AlertTriangle
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { isInbox, isSent } from '@/lib/request-boxes';

export default function RequestsPage() {
  const { currentUser, users } = useAuth();
  const [tab, setTab] = useState<'inbox' | 'sent' | 'all'>('inbox');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  // 내 정보 (소속 팀 확인용)
  const { data: myInfo } = useQuery<UserMeResponse>({
    queryKey: ['me', currentUser.id],
    queryFn: () => apiClient.getMe(currentUser.id)
  });

  const myTeamIds = myInfo?.teams.map((t) => t.id || (t as any).teamId) || [];

  const { data: requests, isLoading } = useQuery({
    queryKey: ['requests', currentUser.id],
    queryFn: () => apiClient.getRequests(currentUser.id)
  });

  // 서버가 요청에 실어 보낸 이름을 먼저 쓴다. users 목록은 ORG_ADMIN 만 받을 수 있어서
  // 일반 사용자 화면에서는 이름을 못 찾고 UUID 가 그대로 찍혔다.
  const getUserName = (
    userId: string | null,
    ...people: Array<{ displayName?: string } | null | undefined>
  ) => {
    for (const person of people) {
      if (person?.displayName) return person.displayName;
    }
    if (!userId) return '미확정 (팀 전체)';
    const u = users.find((user) => user.id === userId);
    return u ? u.displayName : userId;
  };

  const filteredRequests = (requests || []).filter((req) => {
    // 탭 필터
    if (tab === 'inbox' && !isInbox(req, currentUser.id, myTeamIds)) return false;
    if (tab === 'sent' && !isSent(req, currentUser.id)) return false;
    // 상태 필터
    if (statusFilter !== 'ALL' && req.state !== statusFilter) return false;
    return true;
  });

  const inboxCount = (requests || []).filter((r) => isInbox(r, currentUser.id, myTeamIds)).length;
  const sentCount = (requests || []).filter((r) => isSent(r, currentUser.id)).length;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* 상단 타이틀 및 새 요청 버튼 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-6 mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
              Baton 요청 목록
            </h1>
            <span className="text-xs font-semibold text-indigo-700 rounded-full bg-indigo-50 px-2.5 py-0.5 border border-indigo-200">
              {currentUser.displayName}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-600">
            소속 팀으로 인입된 요청 및 개인 배정 업무, AI 에이전트 작업 현황을 관리합니다.
          </p>
        </div>

        <Link
          href="/requests/new"
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 transition self-start sm:self-auto"
        >
          <PlusCircle className="w-4 h-4" />
          <span>새 Baton 요청 작성</span>
        </Link>
      </div>

      {/* 탭 및 필터 바 */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        {/* 탭 */}
        <div className="flex items-center gap-1.5 bg-slate-200/70 p-1 rounded-xl self-start">
          <button
            onClick={() => setTab('inbox')}
            className={cn(
              'flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition',
              tab === 'inbox'
                ? 'bg-white text-indigo-700 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            )}
          >
            <Inbox className="w-3.5 h-3.5" />
            <span>받은 요청</span>
            <span className="rounded-full bg-indigo-50 px-1.5 py-0.2 text-[10px] text-indigo-700 font-bold border border-indigo-200">
              {inboxCount}
            </span>
          </button>

          <button
            onClick={() => setTab('sent')}
            className={cn(
              'flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition',
              tab === 'sent'
                ? 'bg-white text-indigo-700 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            )}
          >
            <Send className="w-3.5 h-3.5" />
            <span>보낸 요청</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.2 text-[10px] text-slate-600 font-bold border border-slate-200">
              {sentCount}
            </span>
          </button>

          <button
            onClick={() => setTab('all')}
            className={cn(
              'px-3.5 py-1.5 rounded-lg text-xs font-semibold transition',
              tab === 'all'
                ? 'bg-white text-indigo-700 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            )}
          >
            <span>전체</span>
          </button>
        </div>

        {/* 상태 필터 드롭다운 */}
        <div className="flex items-center gap-2 text-xs">
          <Filter className="w-3.5 h-3.5 text-slate-400" />
          <span className="font-medium text-slate-600">상태 필터:</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs focus:border-indigo-500 focus:outline-none"
          >
            <option value="ALL">모든 상태</option>
            {Object.values(RequestState).map((st) => (
              <option key={st} value={st}>
                {st}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 로딩 인디케이터 */}
      {isLoading && (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center text-slate-500 text-sm">
          요청 목록을 불러오는 중입니다...
        </div>
      )}

      {/* 빈 목록 */}
      {!isLoading && filteredRequests.length === 0 && (
        <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-white p-12 text-center">
          <Inbox className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <h3 className="font-bold text-slate-800 text-base">표시할 요청이 없습니다</h3>
          <p className="text-xs text-slate-500 mt-1 mb-4">
            새로운 Baton 요청을 작성해 팀원에게 업무를 인계해보세요.
          </p>
          <Link
            href="/requests/new"
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-50 px-3.5 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 transition border border-indigo-200"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            <span>새 요청 작성</span>
          </Link>
        </div>
      )}

      {/* 요청 리스트 카드 목록 */}
      {!isLoading && filteredRequests.length > 0 && (
        <div className="space-y-3">
          {filteredRequests.map((req) => {
            const isMeSender = req.senderUserId === currentUser.id;
            const isMeRecipient = req.recipientUserId === currentUser.id || req.claimedBy?.id === currentUser.id;
            const isBroadcastUnclaimed = req.recipientUserId === null && !req.claimedAt && !req.claimedBy;
            const isClaimedByOther =
              (req.recipientUserId !== null || req.claimedAt !== null) &&
              req.recipientUserId !== currentUser.id &&
              req.claimedBy?.id !== currentUser.id &&
              req.claimedAt !== null;

            const recipientTeamName = req.recipientTeam?.name || 'infra';
            const senderTeamName = req.senderTeam?.name || 'backend';

            return (
              <Link
                key={req.id}
                href={`/requests/${req.id}`}
                className={cn(
                  'group block rounded-xl border bg-white p-5 shadow-sm transition hover:shadow-md',
                  isBroadcastUnclaimed
                    ? 'border-amber-300 hover:border-amber-400 bg-amber-50/20'
                    : 'border-slate-200 hover:border-indigo-300'
                )}
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <StateBadge state={req.state} />

                    {/* 팀 뿌리기 배지 (05 설계 §5.3) */}
                    {isBroadcastUnclaimed ? (
                      <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 border border-amber-300 px-2 py-0.5 text-xs font-bold text-amber-800 animate-pulse">
                        <Users className="w-3 h-3" />
                        팀: {recipientTeamName} · 미확정
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                        <UserIcon className="w-3 h-3 text-slate-500" />
                        처리 중: {getUserName(req.recipientUserId, req.claimedBy, req.recipient)}
                      </span>
                    )}

                    <h3 className="font-bold text-base text-slate-900 group-hover:text-indigo-600 transition">
                      {req.title}
                      {req.isDelegated && <span className="ml-2 inline-flex rounded-full bg-indigo-50 px-2 py-0.5 align-middle text-[10px] font-semibold text-indigo-700">도움 요청</span>}
                      {req.isFollowup && <span className="ml-2 text-xs text-indigo-600">이어서 요청({req.currentRevisionNo}차)</span>}
                    </h3>
                  </div>

                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <Clock className="w-3.5 h-3.5" />
                    <span>{new Date(req.createdAt).toLocaleDateString('ko-KR')}</span>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-mono text-slate-600">
                      Rev {req.currentRevisionNo}
                    </span>
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs text-slate-500 mt-3 pt-3 border-t border-slate-100">
                  <div className="flex items-center gap-2 sm:gap-4 flex-wrap">
                    <span>
                      팀:{' '}
                      <strong className="text-slate-800">
                        {senderTeamName} → {recipientTeamName}
                      </strong>
                    </span>
                    <span className="text-slate-300">|</span>
                    <span>
                      발신:{' '}
                      <strong className={isMeSender ? 'text-indigo-600' : 'text-slate-700'}>
                        {getUserName(req.senderUserId, req.sender)}
                        {isMeSender && ' (나)'}
                      </strong>
                    </span>
                    <span>→</span>
                    <span>
                      수신:{' '}
                      <strong
                        className={
                          isBroadcastUnclaimed
                            ? 'text-amber-700 font-bold'
                            : isMeRecipient
                            ? 'text-purple-600'
                            : 'text-slate-700'
                        }
                      >
                        {getUserName(req.recipientUserId, req.claimedBy, req.recipient)}
                        {isMeRecipient && ' (나)'}
                      </strong>
                    </span>
                  </div>

                  <span className="flex items-center gap-1 font-semibold text-indigo-600 group-hover:translate-x-1 transition text-xs shrink-0">
                    <span>상세 보기</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
