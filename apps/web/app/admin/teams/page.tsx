'use client';

import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/components/auth-provider';
import { apiClient, API_MODE } from '@/lib/api-client';
import { TeamWithMembers, TeamRole, User } from '@/lib/types';
import { Users, Plus, Trash2, UserPlus, ShieldAlert, CheckCircle, Shield } from 'lucide-react';
import { ConfirmModal } from '@/components/ui/modal';

export default function AdminTeamsPage() {
  const { isAdmin, currentUser, users: authUsers } = useAuth();
  const queryClient = useQueryClient();

  // 팀원 후보는 서버의 실제 조직 구성원이다. 예전엔 useAuth().users 를 썼는데, 실서버에서도 그 기본값이
  // 데모 계정(admin@·a@·b@baton.local)이라 없는 사람이 뜨고 실제 구성원은 안 떴다(2026-09-23 dev).
  // 사용자 관리 화면과 같은 쿼리 키를 써서 캐시를 공유한다. mock 모드는 seed 목록 그대로.
  const { data: orgUsers = [] } = useQuery<User[]>({
    queryKey: ['admin-users'],
    queryFn: () => apiClient.getUsers(),
    enabled: isAdmin && API_MODE === 'real',
  });
  const users = API_MODE === 'real' ? orgUsers : authUsers;

  const [newTeamName, setNewTeamName] = useState('');
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [addMemberUserId, setAddMemberUserId] = useState('');
  const [addMemberRole, setAddMemberRole] = useState<TeamRole>('MEMBER');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // 팀 삭제 확인 모달 상태 (window.confirm 대체)
  const [teamToDelete, setTeamToDelete] = useState<TeamWithMembers | null>(null);
  // 팀원 제외도 확인을 받는다. 예전엔 × 를 누르면 바로 빠져, 관리자가 자기 자신을 실수로 뺐다(2026-09-23 dev).
  const [memberToRemove, setMemberToRemove] = useState<{ teamId: string; teamName: string; userId: string; name: string } | null>(null);

  // 팀 목록 쿼리
  const { data: teams = [], isLoading } = useQuery<TeamWithMembers[]>({
    queryKey: ['admin-teams'],
    queryFn: () => apiClient.getOrgTeams(),
    enabled: isAdmin,
  });

  // URL 쿼리 파라미터(?modal=deleteTeam) 연동
  useEffect(() => {
    if (typeof window !== 'undefined' && teams.length > 0) {
      if (new URLSearchParams(window.location.search).get('modal') === 'deleteTeam') {
        setTeamToDelete(teams[0]);
      }
    }
  }, [teams]);

  // 팀 생성 뮤테이션
  const createTeamMutation = useMutation({
    mutationFn: (name: string) => apiClient.createOrgTeam(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-teams'] });
      setNewTeamName('');
      setMessage({ type: 'success', text: '새 팀이 성공적으로 생성되었습니다.' });
      setTimeout(() => setMessage(null), 3000);
    },
    onError: (err: Error) => {
      setMessage({ type: 'error', text: err.message });
    },
  });

  // 팀 삭제 뮤테이션
  const deleteTeamMutation = useMutation({
    mutationFn: (teamId: string) => apiClient.deleteOrgTeam(teamId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-teams'] });
      setMessage({ type: 'success', text: '팀이 삭제되었습니다.' });
      setTimeout(() => setMessage(null), 3000);
    },
  });

  // 팀원 추가 뮤테이션
  const addMemberMutation = useMutation({
    mutationFn: ({ teamId, userId, role }: { teamId: string; userId: string; role: TeamRole }) =>
      apiClient.addTeamMember(teamId, userId, role),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-teams'] });
      setAddMemberUserId('');
      setMessage({ type: 'success', text: '팀원이 추가되었습니다.' });
      setTimeout(() => setMessage(null), 3000);
    },
    // 실패(400/403 등)를 조용히 삼키지 않는다 (W5d-2 수정)
    onError: (err: Error) => {
      setMessage({ type: 'error', text: `팀원 추가 실패: ${err.message}` });
    },
  });

  // 팀원 제거 뮤테이션
  const removeMemberMutation = useMutation({
    mutationFn: ({ teamId, userId }: { teamId: string; userId: string }) =>
      apiClient.removeTeamMember(teamId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-teams'] });
      setMessage({ type: 'success', text: '팀원이 제거되었습니다.' });
      setTimeout(() => setMessage(null), 3000);
    },
  });

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-4xl py-12 px-4 sm:px-6">
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <ShieldAlert className="mx-auto h-12 w-12 text-red-500 mb-3" />
          <h2 className="text-lg font-bold text-red-900">관리자 권한이 필요합니다</h2>
          <p className="mt-1 text-sm text-red-700">
            팀 관리 기능은 조직 관리자(ORG_ADMIN)만 접근할 수 있습니다. 상단 우측에서 [관리자]
            역할을 선택해주세요.
          </p>
        </div>
      </div>
    );
  }

  const handleCreateTeam = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTeamName.trim()) return;
    createTeamMutation.mutate(newTeamName.trim());
  };

  const handleAddMember = (teamId: string) => {
    if (!addMemberUserId) return;
    addMemberMutation.mutate({ teamId, userId: addMemberUserId, role: addMemberRole });
  };

  return (
    <div className="mx-auto max-w-6xl py-8 px-4 sm:px-6 lg:px-8">
      {/* 헤더 */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between pb-6 border-b border-slate-200">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900">팀 관리</h1>
            <span className="rounded-full bg-purple-100 px-2.5 py-0.5 text-xs font-semibold text-purple-800">
              ORG_ADMIN
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-600">
            조직 내 부서 및 팀을 구성하고 팀원을 배정합니다.
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

      {/* 새 팀 생성 폼 */}
      <div className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-bold text-slate-900 flex items-center gap-1.5 mb-3">
          <Plus className="w-4 h-4 text-indigo-600" />새 팀 생성
        </h2>
        <form onSubmit={handleCreateTeam} className="flex gap-3 items-center">
          <input
            type="text"
            placeholder="팀 이름 입력 (예: devops, frontend, data)"
            value={newTeamName}
            onChange={(e) => setNewTeamName(e.target.value)}
            className="flex-1 rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <button
            type="submit"
            disabled={createTeamMutation.isPending || !newTeamName.trim()}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition"
          >
            {createTeamMutation.isPending ? '생성 중...' : '팀 생성'}
          </button>
        </form>
      </div>

      {/* 팀 목록 */}
      <div className="mt-8 space-y-6">
        <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
          <Users className="w-5 h-5 text-slate-600" />
          전체 팀 목록 ({teams.length}개)
        </h2>

        {isLoading ? (
          <div className="text-center py-12 text-slate-500 text-sm">팀 목록 로딩 중...</div>
        ) : teams.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-500 text-sm">
            등록된 팀이 없습니다. 위에서 새 팀을 생성해보세요.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {teams.map((team) => (
              <div
                key={team.id}
                className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700 font-bold text-sm">
                        {team.name.charAt(0).toUpperCase()}
                      </span>
                      <div>
                        <h3 className="font-bold text-slate-900 text-base">{team.name}</h3>
                        <p className="text-xs text-slate-500">팀원 {team.members?.length || 0}명</p>
                      </div>
                    </div>
                    <button
                      onClick={() => setTeamToDelete(team)}
                      title="팀 삭제"
                      className="text-slate-400 hover:text-red-600 p-1 rounded transition"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  {/* 멤버 목록 */}
                  <div className="mt-4 pt-3 border-t border-slate-100">
                    <h4 className="text-xs font-semibold text-slate-500 mb-2">소속 팀원</h4>
                    {team.members && team.members.length > 0 ? (
                      <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                        {team.members.map((m) => (
                          <div
                            key={m.id}
                            className="flex items-center justify-between rounded-md bg-slate-50 px-2.5 py-1.5 text-xs"
                          >
                            <div className="flex items-center gap-1.5 truncate">
                              <span className="font-medium text-slate-800 truncate">
                                {m.user?.displayName || m.userId}
                              </span>
                              {m.role === 'TEAM_LEAD' && (
                                <span className="rounded bg-amber-100 px-1.5 py-0.2 text-[10px] font-bold text-amber-800">
                                  LEAD
                                </span>
                              )}
                            </div>
                            <button
                              onClick={() =>
                                setMemberToRemove({
                                  teamId: team.id,
                                  teamName: team.name,
                                  userId: m.user?.email || m.userId || '',
                                  name: m.user?.displayName || m.userId || '',
                                })
                              }
                              className="text-slate-400 hover:text-red-500 ml-2"
                              title="팀에서 제외"
                            >
                              &times;
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-slate-400 italic">배정된 팀원이 없습니다.</p>
                    )}
                  </div>
                </div>

                {/* 팀원 추가 인라인 */}
                <div className="mt-4 pt-3 border-t border-slate-100">
                  <div className="flex flex-col gap-2">
                    <div className="flex gap-1.5">
                      <select
                        value={selectedTeamId === team.id ? addMemberUserId : ''}
                        onChange={(e) => {
                          setSelectedTeamId(team.id);
                          setAddMemberUserId(e.target.value);
                        }}
                        className="min-w-0 flex-1 truncate rounded border border-slate-200 px-2 py-1 text-xs text-slate-700 bg-white"
                      >
                        <option value="">+ 팀원 선택</option>
                        {users
                          .filter(
                            (u) =>
                              u.id !== 'user_admin_id' &&
                              !team.members?.some((m) => m.userId === u.id),
                          )
                          .map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.displayName} ({u.email})
                            </option>
                          ))}
                      </select>
                      <select
                        value={selectedTeamId === team.id ? addMemberRole : 'MEMBER'}
                        onChange={(e) => {
                          setSelectedTeamId(team.id);
                          setAddMemberRole(e.target.value as TeamRole);
                        }}
                        className="shrink-0 rounded border border-slate-200 px-1.5 py-1 text-xs text-slate-700 bg-white"
                      >
                        <option value="MEMBER">MEMBER</option>
                        <option value="TEAM_LEAD">LEAD</option>
                      </select>
                    </div>
                    {selectedTeamId === team.id && addMemberUserId && (
                      <button
                        type="button"
                        onClick={() => handleAddMember(team.id)}
                        disabled={addMemberMutation.isPending}
                        className="w-full rounded bg-slate-900 py-1 text-xs font-semibold text-white hover:bg-slate-800 transition"
                      >
                        {addMemberMutation.isPending ? '추가 중...' : '팀원으로 배정'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 팀 삭제 확인 모달 (window.confirm 대체) */}
      <ConfirmModal
        isOpen={Boolean(teamToDelete)}
        onClose={() => setTeamToDelete(null)}
        onConfirm={() => {
          if (teamToDelete) {
            deleteTeamMutation.mutate(teamToDelete.id);
            setTeamToDelete(null);
          }
        }}
        title="팀 삭제 확인"
        description={
          <span>
            정말 <strong className="font-bold text-slate-800">'{teamToDelete?.name}'</strong> 팀을 삭제하시겠습니까?
          </span>
        }
        warningText="팀을 삭제하면 소속 팀원의 팀 배정이 해제되며 관련된 팀 링크가 비활성화됩니다."
        confirmLabel="팀 삭제"
        cancelLabel="취소"
        variant="danger"
        isLoading={deleteTeamMutation.isPending}
      />

      {/* 팀원 제외 확인 모달 */}
      <ConfirmModal
        isOpen={Boolean(memberToRemove)}
        onClose={() => setMemberToRemove(null)}
        onConfirm={() => {
          if (memberToRemove) {
            removeMemberMutation.mutate({ teamId: memberToRemove.teamId, userId: memberToRemove.userId });
            setMemberToRemove(null);
          }
        }}
        title="팀원 제외 확인"
        description={
          <span>
            <strong className="font-bold text-slate-800">{memberToRemove?.name}</strong> 님을{' '}
            <strong className="font-bold text-slate-800">'{memberToRemove?.teamName}'</strong> 팀에서 제외하시겠습니까?
          </span>
        }
        warningText="팀에서만 빠지고 조직 소속과 조직 권한은 그대로입니다. 다시 배정할 수 있습니다."
        confirmLabel="제외"
        cancelLabel="취소"
        variant="danger"
        isLoading={removeMemberMutation.isPending}
      />
    </div>
  );
}
