'use client';

import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/components/auth-provider';
import { apiClient } from '@/lib/api-client';
import { TeamWithMembers, TeamLink, TeamLinkDirection } from '@/lib/types';
import {
  Network,
  ShieldAlert,
  CheckCircle,
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  ArrowLeft,
  X
} from 'lucide-react';

export default function AdminTeamLinksPage() {
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();

  // 방향 선택 모달 상태
  const [directionModal, setDirectionModal] = useState<{
    isOpen: boolean;
    teamA: { id: string; name: string };
    teamB: { id: string; name: string };
    selectedDirection: TeamLinkDirection | 'none';
  } | null>(null);

  // 기존 해제 확인 모달 상태 (호환용)
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    teamA: { id: string; name: string };
    teamB: { id: string; name: string };
  } | null>(null);

  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 팀 목록
  const { data: teams = [], isLoading: isLoadingTeams } = useQuery<TeamWithMembers[]>({
    queryKey: ['admin-teams'],
    queryFn: () => apiClient.getOrgTeams(),
    enabled: isAdmin
  });

  // 팀 링크 목록
  const { data: teamLinks = [], isLoading: isLoadingLinks } = useQuery<TeamLink[]>({
    queryKey: ['admin-team-links'],
    queryFn: () => apiClient.getOrgTeamLinks(),
    enabled: isAdmin
  });

  // URL 쿼리 기반 모달 트리거 (스크린샷 및 데모 지원)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const p = new URLSearchParams(window.location.search);
      if (p.get('modal') === 'confirm') {
        setConfirmModal({
          isOpen: true,
          teamA: { id: 'team_backend_id', name: 'backend' },
          teamB: { id: 'team_infra_id', name: 'infra' }
        });
      } else if (p.get('modal') === 'direction' || p.get('directionMenu') === 'open') {
        setDirectionModal({
          isOpen: true,
          teamA: { id: 'team_backend_id', name: 'backend' },
          teamB: { id: 'team_infra_id', name: 'infra' },
          selectedDirection: 'a-to-b'
        });
      }
    }
  }, []);

  // 방향 변경 뮤테이션
  const updateDirectionMutation = useMutation({
    mutationFn: async ({
      fromTeamId,
      toTeamId,
      direction
    }: {
      fromTeamId: string;
      toTeamId: string;
      direction: TeamLinkDirection | 'none';
    }) => {
      if (direction === 'none') {
        return apiClient.deleteOrgTeamLink(fromTeamId, toTeamId, 'both');
      }

      if (direction === 'both') {
        return apiClient.createOrgTeamLink(fromTeamId, toTeamId, 'both');
      }

      if (direction === 'a-to-b') {
        // 1. from -> to 단방향 생성
        await apiClient.createOrgTeamLink(fromTeamId, toTeamId, 'a-to-b');
        // 2. 만약 기존에 to -> from 행이 있다면 반대 방향 행 삭제
        const hasReverse = teamLinks.some(
          (l) => l.fromTeamId === toTeamId && l.toTeamId === fromTeamId
        );
        if (hasReverse) {
          try {
            await apiClient.deleteOrgTeamLink(toTeamId, fromTeamId, 'a-to-b');
          } catch (e) {
            console.warn('Failed to delete reverse link for a-to-b:', e);
          }
        }
        return;
      }

      if (direction === 'b-to-a') {
        // 1. to -> from 단방향 생성
        await apiClient.createOrgTeamLink(toTeamId, fromTeamId, 'a-to-b');
        // 2. 만약 기존에 from -> to 행이 있다면 반대 방향 행 삭제
        const hasForward = teamLinks.some(
          (l) => l.fromTeamId === fromTeamId && l.toTeamId === toTeamId
        );
        if (hasForward) {
          try {
            await apiClient.deleteOrgTeamLink(fromTeamId, toTeamId, 'a-to-b');
          } catch (e) {
            console.warn('Failed to delete forward link for b-to-a:', e);
          }
        }
        return;
      }
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin-team-links'] });
      setDirectionModal(null);
      setConfirmModal(null);
      const dirText =
        variables.direction === 'both'
          ? '양방향'
          : variables.direction === 'a-to-b'
            ? 'A → B 단방향'
            : variables.direction === 'b-to-a'
              ? 'B → A 단방향'
              : '차단(해제)';
      setMessage({ type: 'success', text: `팀 간 통신 링크가 [${dirText}]으로 변경되었습니다.` });
      setTimeout(() => setMessage(null), 3500);
    },
    onError: (err: Error) => {
      setMessage({ type: 'error', text: err.message });
    }
  });

  // 링크 해제 전용 뮤테이션 (기존 confirmModal 호환)
  const deleteLinkMutation = useMutation({
    mutationFn: ({ fromTeamId, toTeamId }: { fromTeamId: string; toTeamId: string }) =>
      apiClient.deleteOrgTeamLink(fromTeamId, toTeamId, 'both'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-team-links'] });
      setConfirmModal(null);
      setMessage({ type: 'success', text: '팀 간 통신 링크가 해제되었습니다.' });
      setTimeout(() => setMessage(null), 3000);
    },
    onError: (err: Error) => {
      setMessage({ type: 'error', text: err.message });
    }
  });

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-4xl py-12 px-4 sm:px-6">
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <ShieldAlert className="mx-auto h-12 w-12 text-red-500 mb-3" />
          <h2 className="text-lg font-bold text-red-900">관리자 권한이 필요합니다</h2>
          <p className="mt-1 text-sm text-red-700">
            팀 링크 매트릭스는 조직 관리자(ORG_ADMIN)만 접근할 수 있습니다.
          </p>
        </div>
      </div>
    );
  }

  // 두 팀 사이의 방향 상태 조회
  const getPairDirection = (team1Id: string, team2Id: string): TeamLinkDirection | 'none' => {
    const has1To2 = teamLinks.some((l) => l.fromTeamId === team1Id && l.toTeamId === team2Id);
    const has2To1 = teamLinks.some((l) => l.fromTeamId === team2Id && l.toTeamId === team1Id);

    if (has1To2 && has2To1) return 'both';
    if (has1To2) return 'a-to-b';
    if (has2To1) return 'b-to-a';
    return 'none';
  };

  const openDirectionMenu = (team1: TeamWithMembers, team2: TeamWithMembers) => {
    if (team1.id === team2.id) return;
    const current = getPairDirection(team1.id, team2.id);
    setDirectionModal({
      isOpen: true,
      teamA: { id: team1.id, name: team1.name },
      teamB: { id: team2.id, name: team2.name },
      selectedDirection: current
    });
  };

  return (
    <div className="mx-auto max-w-6xl py-8 px-4 sm:px-6 lg:px-8">
      {/* 헤더 */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between pb-6 border-b border-slate-200">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900">팀 링크 매트릭스</h1>
            <span className="rounded-full bg-purple-100 px-2.5 py-0.5 text-xs font-semibold text-purple-800">
              ORG_ADMIN
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-600">
            팀 간 작업 요청 전송을 허용할 통신 링크를 관리합니다. 양방향 통신 및 단방향(A→B, B→A) 통신을 세밀하게 제어할 수 있습니다.
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

      {/* 안내 카드 */}
      <div className="mt-6 rounded-xl border border-indigo-100 bg-indigo-50/60 p-4 text-xs text-indigo-900 flex items-start gap-3">
        <ArrowLeftRight className="w-5 h-5 text-indigo-600 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="font-semibold">팀 간 통신 허용 규칙</p>
          <p className="text-indigo-800/90">
            • 요청을 생성하려면 발신 팀에서 수신 팀으로 향하는 링크(TeamLink)가 활성화되어 있어야 합니다.<br />
            • <span className="font-semibold text-indigo-950">양방향(⇄)</span>: 양쪽 팀 모두 서로에게 요청을 보낼 수 있습니다.<br />
            • <span className="font-semibold text-emerald-950">단방향(→)</span>: 지정된 발신 팀에서만 요청을 생성할 수 있으며 역방향 요청은 차단됩니다.<br />
            • 셀을 클릭하여 양방향, 단방향, 통신 차단 상태를 원하는 방향으로 변경할 수 있습니다.
          </p>
        </div>
      </div>

      {/* 매트릭스 테이블 */}
      <div className="mt-8 rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
            <Network className="w-4 h-4 text-slate-600" />
            팀 × 팀 통신 허용 매트릭스
          </h2>
          {/* 범례 */}
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
            <span className="flex items-center gap-1.5">
              <span className="w-5 h-5 rounded bg-indigo-600 text-white font-bold flex items-center justify-center text-[10px]">
                ⇄
              </span>
              양방향 허용
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-5 h-5 rounded bg-emerald-600 text-white font-bold flex items-center justify-center text-[10px]">
                →
              </span>
              단방향 허용 (발신)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-5 h-5 rounded bg-amber-50 text-amber-700 border border-dashed border-amber-300 font-bold flex items-center justify-center text-[10px]">
                ✕
              </span>
              수신 전용 (역단방향)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-5 h-5 rounded bg-slate-100 text-slate-400 font-bold flex items-center justify-center text-[10px]">
                ✕
              </span>
              차단됨
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-5 h-5 rounded bg-slate-100 border border-slate-300 text-slate-400 font-bold flex items-center justify-center text-[10px]">
                ✓
              </span>
              동일 팀
            </span>
          </div>
        </div>

        {isLoadingTeams || isLoadingLinks ? (
          <div className="py-16 text-center text-slate-500 text-sm">매트릭스 로딩 중...</div>
        ) : (
          <div className="overflow-x-auto p-4">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr>
                  <th className="p-3 text-xs font-bold text-slate-500 border-b border-r border-slate-200 bg-slate-50/50 w-36">
                    발신 팀 ＼ 수신 팀
                  </th>
                  {teams.map((colTeam) => (
                    <th
                      key={colTeam.id}
                      className="p-3 text-xs font-bold text-slate-700 border-b border-slate-200 text-center min-w-[120px]"
                    >
                      <span className="inline-block rounded-md bg-slate-100 px-2.5 py-1 text-slate-800">
                        {colTeam.name}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {teams.map((rowTeam) => (
                  <tr key={rowTeam.id} className="hover:bg-slate-50/50 transition">
                    <td className="p-3 text-xs font-bold text-slate-800 border-r border-b border-slate-100 bg-slate-50/30">
                      <span className="inline-block rounded-md bg-slate-100 px-2.5 py-1">
                        {rowTeam.name}
                      </span>
                    </td>
                    {teams.map((colTeam) => {
                      const isSame = rowTeam.id === colTeam.id;
                      if (isSame) {
                        return (
                          <td
                            key={colTeam.id}
                            className="p-3 border-b border-slate-100 text-center align-middle"
                          >
                            <span
                              className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-slate-100 text-slate-400 text-xs font-semibold cursor-not-allowed border border-slate-200/60"
                              title="동일 팀 내 통신은 상시 허용됩니다"
                            >
                              ✓
                            </span>
                          </td>
                        );
                      }

                      const pairDir = getPairDirection(rowTeam.id, colTeam.id);
                      // rowTeam -> colTeam 방향 통신이 가능한가?
                      const canSend = pairDir === 'both' || pairDir === 'a-to-b';
                      const isBidirectional = pairDir === 'both';
                      const isUnidirectionalSend = pairDir === 'a-to-b';
                      const isUnidirectionalReceiveOnly = pairDir === 'b-to-a';

                      return (
                        <td
                          key={colTeam.id}
                          className="p-3 border-b border-slate-100 text-center align-middle"
                        >
                          <button
                            type="button"
                            onClick={() => openDirectionMenu(rowTeam, colTeam)}
                            disabled={updateDirectionMutation.isPending}
                            data-testid={`link-cell-${rowTeam.name}-${colTeam.name}`}
                            className={`group relative inline-flex flex-col items-center justify-center w-14 h-11 rounded-lg text-xs font-bold transition shadow-sm ${
                              isBidirectional
                                ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                                : isUnidirectionalSend
                                  ? 'bg-emerald-600 text-white hover:bg-emerald-700 ring-2 ring-emerald-300 ring-offset-1'
                                  : isUnidirectionalReceiveOnly
                                    ? 'bg-amber-50 text-amber-700 border border-dashed border-amber-300 hover:bg-amber-100'
                                    : 'bg-slate-100 text-slate-400 hover:bg-slate-200'
                            }`}
                            title={`[${rowTeam.name} → ${colTeam.name}] 클릭하여 통신 방향 변경 (${
                              isBidirectional
                                ? '양방향 허용'
                                : isUnidirectionalSend
                                  ? '단방향 허용(발신 가능)'
                                  : isUnidirectionalReceiveOnly
                                    ? '수신 전용(발신 차단)'
                                    : '차단됨'
                            })`}
                          >
                            <span className="flex items-center gap-0.5 text-sm">
                              {isBidirectional && <ArrowLeftRight className="w-4 h-4" />}
                              {isUnidirectionalSend && <ArrowRight className="w-4 h-4 text-emerald-100" />}
                              {isUnidirectionalReceiveOnly && <X className="w-4 h-4 text-amber-500" />}
                              {!canSend && !isUnidirectionalReceiveOnly && '✕'}
                            </span>
                            <span className="text-[9px] font-medium leading-none opacity-90">
                              {isBidirectional && '양방향'}
                              {isUnidirectionalSend && 'A→B'}
                              {isUnidirectionalReceiveOnly && '수신만'}
                              {!canSend && !isUnidirectionalReceiveOnly && '차단'}
                            </span>
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* CLO-18 방향 선택 및 관리 팝오버/모달 */}
      {directionModal && directionModal.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl border border-slate-200">
            {/* 모달 헤더 */}
            <div className="flex items-start justify-between pb-4 border-b border-slate-100">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600">
                  <ArrowLeftRight className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900">팀 링크 통신 방향 설정</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    <span className="font-semibold text-slate-800">{directionModal.teamA.name}</span> 팀과{' '}
                    <span className="font-semibold text-slate-800">{directionModal.teamB.name}</span> 팀 간 통신 권한
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDirectionModal(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* 방향 선택 라디오 카드 목록 */}
            <div className="mt-5 space-y-3">
              {/* 1. 양방향 (both) */}
              <label
                onClick={() =>
                  setDirectionModal((prev) =>
                    prev ? { ...prev, selectedDirection: 'both' } : null
                  )
                }
                className={`relative flex items-start gap-3.5 p-3.5 rounded-xl border cursor-pointer transition ${
                  directionModal.selectedDirection === 'both'
                    ? 'border-indigo-500 bg-indigo-50/60 ring-1 ring-indigo-500'
                    : 'border-slate-200 hover:bg-slate-50'
                }`}
              >
                <input
                  type="radio"
                  name="direction"
                  checked={directionModal.selectedDirection === 'both'}
                  onChange={() => {}}
                  className="mt-1 h-4 w-4 text-indigo-600 focus:ring-indigo-500"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm text-slate-900">
                      양방향 허용 ({directionModal.teamA.name} ⇄ {directionModal.teamB.name})
                    </span>
                    <span className="rounded bg-indigo-100 px-2 py-0.5 text-[11px] font-semibold text-indigo-800">
                      기본 권장
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 mt-1">
                    두 팀이 서로에게 자유롭게 업무 요청을 생성하고 결과를 교환할 수 있습니다.
                  </p>
                </div>
              </label>

              {/* 2. A -> B 단방향 (a-to-b) */}
              <label
                onClick={() =>
                  setDirectionModal((prev) =>
                    prev ? { ...prev, selectedDirection: 'a-to-b' } : null
                  )
                }
                className={`relative flex items-start gap-3.5 p-3.5 rounded-xl border cursor-pointer transition ${
                  directionModal.selectedDirection === 'a-to-b'
                    ? 'border-emerald-500 bg-emerald-50/60 ring-1 ring-emerald-500'
                    : 'border-slate-200 hover:bg-slate-50'
                }`}
              >
                <input
                  type="radio"
                  name="direction"
                  checked={directionModal.selectedDirection === 'a-to-b'}
                  onChange={() => {}}
                  className="mt-1 h-4 w-4 text-emerald-600 focus:ring-emerald-500"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm text-slate-900">
                      단방향 허용 ({directionModal.teamA.name} → {directionModal.teamB.name})
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 mt-1">
                    <span className="font-semibold text-emerald-900">{directionModal.teamA.name}</span> 팀만{' '}
                    <span className="font-semibold text-emerald-900">{directionModal.teamB.name}</span> 팀에 요청할 수 있으며, 역방향 발신은 엄격히 차단됩니다.
                  </p>
                </div>
              </label>

              {/* 3. B -> A 단방향 (b-to-a) */}
              <label
                onClick={() =>
                  setDirectionModal((prev) =>
                    prev ? { ...prev, selectedDirection: 'b-to-a' } : null
                  )
                }
                className={`relative flex items-start gap-3.5 p-3.5 rounded-xl border cursor-pointer transition ${
                  directionModal.selectedDirection === 'b-to-a'
                    ? 'border-emerald-500 bg-emerald-50/60 ring-1 ring-emerald-500'
                    : 'border-slate-200 hover:bg-slate-50'
                }`}
              >
                <input
                  type="radio"
                  name="direction"
                  checked={directionModal.selectedDirection === 'b-to-a'}
                  onChange={() => {}}
                  className="mt-1 h-4 w-4 text-emerald-600 focus:ring-emerald-500"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm text-slate-900">
                      단방향 허용 ({directionModal.teamB.name} → {directionModal.teamA.name})
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 mt-1">
                    <span className="font-semibold text-emerald-900">{directionModal.teamB.name}</span> 팀만{' '}
                    <span className="font-semibold text-emerald-900">{directionModal.teamA.name}</span> 팀에 요청할 수 있으며, 역방향 발신은 엄격히 차단됩니다.
                  </p>
                </div>
              </label>

              {/* 4. 통신 차단 및 링크 해제 (none) */}
              <label
                onClick={() =>
                  setDirectionModal((prev) =>
                    prev ? { ...prev, selectedDirection: 'none' } : null
                  )
                }
                className={`relative flex items-start gap-3.5 p-3.5 rounded-xl border cursor-pointer transition ${
                  directionModal.selectedDirection === 'none'
                    ? 'border-red-500 bg-red-50/60 ring-1 ring-red-500'
                    : 'border-slate-200 hover:bg-slate-50'
                }`}
              >
                <input
                  type="radio"
                  name="direction"
                  checked={directionModal.selectedDirection === 'none'}
                  onChange={() => {}}
                  className="mt-1 h-4 w-4 text-red-600 focus:ring-red-500"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm text-red-900">
                      통신 차단 (링크 해제)
                    </span>
                    <span className="rounded bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-800">
                      차단
                    </span>
                  </div>
                  <p className="text-xs text-red-700/80 mt-1">
                    두 팀 간의 모든 링크를 해제하여 신규 요청 생성 및 수신자 조회를 전면 차단합니다.
                  </p>
                </div>
              </label>
            </div>

            {/* 버튼 액션 */}
            <div className="mt-6 flex justify-end gap-3 pt-3 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setDirectionModal(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition"
              >
                취소
              </button>
              <button
                type="button"
                onClick={() =>
                  updateDirectionMutation.mutate({
                    fromTeamId: directionModal.teamA.id,
                    toTeamId: directionModal.teamB.id,
                    direction: directionModal.selectedDirection
                  })
                }
                disabled={updateDirectionMutation.isPending}
                className="rounded-lg bg-indigo-600 px-5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50 transition"
              >
                {updateDirectionMutation.isPending ? '적용 중...' : '방향 설정 적용'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 기존 호환용 단순 해제 확인 모달 */}
      {confirmModal && confirmModal.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl border border-slate-200">
            <div className="flex items-center gap-3 text-amber-600 mb-4">
              <AlertTriangle className="h-6 w-6" />
              <h3 className="text-lg font-bold text-slate-900">팀 링크 해제 확인</h3>
            </div>
            <p className="text-sm text-slate-600 leading-relaxed">
              <span className="font-semibold text-slate-900">'{confirmModal.teamA.name}'</span> 팀과{' '}
              <span className="font-semibold text-slate-900">'{confirmModal.teamB.name}'</span> 팀 사이의 통신 링크를 해제하시겠습니까?
            </p>
            <p className="mt-2 text-xs text-red-600 bg-red-50 p-2.5 rounded-lg border border-red-100">
              링크가 해제되면 두 팀 간 신규 요청 생성이 차단되며, 수신자 목록에서 서로가 숨겨집니다.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirmModal(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition"
              >
                취소
              </button>
              <button
                type="button"
                onClick={() =>
                  deleteLinkMutation.mutate({
                    fromTeamId: confirmModal.teamA.id,
                    toTeamId: confirmModal.teamB.id
                  })
                }
                disabled={deleteLinkMutation.isPending}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 transition"
              >
                {deleteLinkMutation.isPending ? '해제 중...' : '통신 차단 및 해제'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
