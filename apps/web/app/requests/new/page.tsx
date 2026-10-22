'use client';

import React, { useState, useEffect } from 'react';
import { AttachmentPicker, PickedAttachment } from '@/components/attachment-picker';
import { MarkdownEditor } from '@/components/markdown-editor';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiClient, API_MODE } from '@/lib/api-client';
import { useAuth } from '@/components/auth-provider';
import { RecipientsResponse, UserMeResponse } from '@/lib/types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Send,
  Save,
  FileText,
  Paperclip,
  Eye,
  Edit3,
  User as UserIcon,
  Users,
  ArrowLeft,
  CheckCircle,
  AlertCircle,
  Laptop,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import Link from 'next/link';

export default function NewRequestPage() {
  const router = useRouter();
  const { currentUser } = useAuth();

  // 내 정보 및 소속 팀 목록 조회
  const { data: myInfo } = useQuery<UserMeResponse>({
    queryKey: ['me', currentUser.id],
    queryFn: () => apiClient.getMe(currentUser.id),
  });

  const myTeams = myInfo?.teams || [];
  const [senderTeamId, setSenderTeamId] = useState<string>('');

  // 발신 팀 결정. real 모드에서는 /v1/me 의 실제 팀만 쓴다.
  // (W5d-2 수정: 인증 초기화 전 placeholder 사용자(user_b_id)로 mock id `team_infra_id` 가 먼저 잡혀
  //  실제 팀이 로드돼도 바뀌지 않아 recipients 조회가 400 으로 끝나던 문제)
  useEffect(() => {
    const teamIds = myTeams.map((t) => t.id || (t as any).teamId).filter(Boolean) as string[];
    if (teamIds.length > 0) {
      if (!senderTeamId || !teamIds.includes(senderTeamId)) setSenderTeamId(teamIds[0]);
      return;
    }
    if (API_MODE !== 'mock' || senderTeamId) return;
    if (currentUser.id === 'user_a_id') setSenderTeamId('team_backend_id');
    else if (currentUser.id === 'user_b_id') setSenderTeamId('team_infra_id');
  }, [myTeams, senderTeamId, currentUser.id]);

  // 수신자 후보 조회 (GET /v1/recipients?senderTeamId=). real 모드는 실제 팀 id 가 잡힐 때까지 조회하지 않는다.
  const effectiveSenderTeamId =
    senderTeamId ||
    myTeams[0]?.id ||
    (myTeams[0] as any)?.teamId ||
    (API_MODE === 'mock'
      ? currentUser.id === 'user_a_id'
        ? 'team_backend_id'
        : 'team_infra_id'
      : '');

  const { data: recipientsData, isLoading: isLoadingRecipients } = useQuery<RecipientsResponse>({
    queryKey: ['recipients', effectiveSenderTeamId],
    queryFn: () => apiClient.getRecipients(effectiveSenderTeamId),
    enabled: Boolean(effectiveSenderTeamId),
  });

  // 실서버/Mock 응답 호환 정규화 (usersByTeam)
  const usersByTeam: Record<string, any[]> = React.useMemo(() => {
    if (!recipientsData) return {};
    if (recipientsData.usersByTeam) return recipientsData.usersByTeam;
    if (recipientsData.teams) {
      return Object.fromEntries(
        recipientsData.teams.map((t) => [
          t.id,
          (t.members || []).map((m) => ({
            id: m.id,
            name: m.displayName || m.email,
            displayName: m.displayName || m.email,
            email: m.email,
            teamId: t.id,
            teamName: t.name,
            hasActiveDevice: m.hasActiveDevice,
          })),
        ]),
      );
    }
    return {};
  }, [recipientsData]);

  // 대상 모드: 'user' (사람) | 'team' (팀 전체 뿌리기)
  const [targetMode, setTargetMode] = useState<'user' | 'team'>(() => {
    if (typeof window !== 'undefined') {
      if (new URLSearchParams(window.location.search).get('tab') === 'team') return 'team';
    }
    return 'user';
  });
  const [recipientUserId, setRecipientUserId] = useState<string>('');
  const [recipientTeamId, setRecipientTeamId] = useState<string>('');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('tab') === 'team') {
        setTargetMode('team');
      }
    }
  }, []);

  // 수신자 자동 선택
  useEffect(() => {
    if (!recipientsData) return;

    if (targetMode === 'team') {
      if (!recipientTeamId && recipientsData.teams.length > 0) {
        // 상대 팀 우선 선택 (예: backend -> infra)
        const otherTeam =
          recipientsData.teams.find((t) => t.id !== effectiveSenderTeamId) ||
          recipientsData.teams[0];
        setRecipientTeamId(otherTeam.id);
      }
    } else {
      // 사람 모드
      const allUsers = Object.values(usersByTeam).flat();
      const otherUsers = allUsers.filter((u) => u.id !== currentUser.id);
      if (
        otherUsers.length > 0 &&
        (!recipientUserId || !allUsers.some((u) => u.id === recipientUserId))
      ) {
        setRecipientUserId(otherUsers[0].id);
        setRecipientTeamId(otherUsers[0].teamId);
      }
    }
  }, [
    recipientsData,
    usersByTeam,
    targetMode,
    recipientUserId,
    recipientTeamId,
    effectiveSenderTeamId,
    currentUser.id,
  ]);

  // 사람 선택 시 해당 유저의 teamId 자동 반영
  const handleSelectUser = (userId: string) => {
    setRecipientUserId(userId);
    for (const [tId, uList] of Object.entries(usersByTeam)) {
      if (uList.some((u) => u.id === userId)) {
        setRecipientTeamId(tId);
        break;
      }
    }
  };

  // 데모 기본값을 채워 두면 안 된다. 실행자가 지우지 않으면 **그대로 전송되어 에이전트까지
  // 전달된다** — 2026-09-18 테스트에서 math.js 저장소 작업에 Kubernetes 분석 문서와 가짜
  // server.log 첨부가 딸려 갔다. 예시는 placeholder 로만 보여 준다(입력칸에 이미 있다).
  const [title, setTitle] = useState<string>('');
  const [originalInstruction, setOriginalInstruction] = useState<string>('');

  // Markdown 문서
  const [documentTitle, setDocumentTitle] = useState<string>('');
  const [documentContent, setDocumentContent] = useState<string>('');
  const [docTab, setDocTab] = useState<'write' | 'preview'>('write');

  // 첨부 파일
  const [attachments, setAttachments] = useState<PickedAttachment[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: (autoSend: boolean) => {
      const finalRecipientTeamId =
        targetMode === 'team'
          ? recipientTeamId
          : recipientTeamId || recipientsData?.teams[0]?.id || '';
      // 예전에는 'team_infra_id' 를 넣어 보내서 서버가 UUID 형식 오류로 거절했다.
      // 원인이 "받는 팀을 못 골랐다" 인데 화면에는 400 만 떴다 (전수조사 결함 10).
      if (!finalRecipientTeamId) {
        throw new Error('받는 팀을 고를 수 없습니다. 통신 링크가 허용된 팀이 있는지 확인해 주세요.');
      }

      return apiClient.createRequest(currentUser.id, {
        senderTeamId: effectiveSenderTeamId,
        recipientTeamId: finalRecipientTeamId,
        recipientUserId: targetMode === 'user' ? recipientUserId : null,
        title,
        originalInstruction,
        // 내용이 없으면 문서를 만들지 않는다. 이름만 비어 있으면 기본 이름을 준다.
        documentTitle: documentTitle.trim() || 'document.md',
        documentContent,
        attachments,
        autoSend,
      });
    },
    onSuccess: (data) => {
      router.push(`/requests/${data.id}`);
    },
    onError: (err: Error) => {
      setErrorMessage(err.message);
    },
  });

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      {/* 상단 네비게이션 */}
      <div className="mb-6">
        <Link
          href="/requests"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-800 transition mb-3"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>요청 목록으로 돌아가기</span>
        </Link>
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <span>새 Baton 요청 작성</span>
          <span className="rounded bg-indigo-50 border border-indigo-200 text-indigo-700 text-xs px-2 py-0.5 font-normal">
            05 조직·팀 반영
          </span>
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          소속 팀을 지정하고, 허용된 팀 또는 팀원에게 작업을 인계(Pass)합니다.
        </p>
      </div>

      {errorMessage && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 flex items-center gap-2">
          <AlertCircle className="w-5 h-5 shrink-0 text-red-500" />
          <span>{errorMessage}</span>
        </div>
      )}

      <div className="space-y-6">
        {/* 1. 발신 및 수신 팀/대상 설정 */}
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* 보내는 팀 */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                보내는 팀 (발신 팀)
              </label>
              {myTeams.length > 1 ? (
                <select
                  value={effectiveSenderTeamId}
                  onChange={(e) => setSenderTeamId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white p-2.5 text-sm font-medium focus:border-indigo-500 focus:outline-none"
                >
                  {myTeams.map((t) => (
                    <option key={t.id || (t as any).teamId} value={t.id || (t as any).teamId}>
                      {t.name || (t as any).teamName} ({t.role})
                    </option>
                  ))}
                </select>
              ) : (
                <div className="rounded-lg bg-slate-50 border border-slate-200 p-2.5 text-sm text-slate-800 font-semibold flex items-center justify-between">
                  <span>{myTeams[0]?.name || (myTeams[0] as any)?.teamName || 'backend'}</span>
                  <span className="text-xs text-slate-500 font-normal">
                    작성자: {currentUser.displayName}
                  </span>
                </div>
              )}
            </div>

            {/* 수신 방식 탭 선택: 사람 vs 팀 전체 */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                수신 대상 유형
              </label>
              <div className="flex rounded-lg border border-slate-200 bg-slate-50 p-1">
                <button
                  type="button"
                  onClick={() => setTargetMode('user')}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-semibold transition',
                    targetMode === 'user'
                      ? 'bg-white text-indigo-700 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900',
                  )}
                >
                  <UserIcon className="w-3.5 h-3.5" />
                  <span>사람 (개인 지정)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setTargetMode('team')}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-semibold transition',
                    targetMode === 'team'
                      ? 'bg-white text-indigo-700 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900',
                  )}
                >
                  <Users className="w-3.5 h-3.5" />
                  <span>팀 전체 (팀에 뿌리기)</span>
                </button>
              </div>
            </div>
          </div>

          {/* 대상 선택 영역 (GET /v1/recipients 기반) */}
          <div className="pt-2 border-t border-slate-100">
            {isLoadingRecipients ? (
              <div className="text-xs text-slate-500 py-2">
                수신 가능한 팀 및 팀원 목록 조회 중...
              </div>
            ) : targetMode === 'user' ? (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  받는 사람 (통신 링크 허용된 팀별 구성원)
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {recipientsData &&
                    Object.entries(usersByTeam).map(([teamId, userList]) => {
                      const teamInfo = recipientsData.teams.find((t) => t.id === teamId);
                      return (
                        <div
                          key={teamId}
                          className="rounded-lg border border-slate-200 p-3 bg-slate-50/50"
                        >
                          <div className="text-xs font-bold text-slate-700 mb-2 flex items-center justify-between">
                            <span>팀: {teamInfo?.name || teamId}</span>
                            <span className="text-[11px] text-slate-400 font-normal">
                              {userList.length}명
                            </span>
                          </div>
                          <div className="space-y-1.5">
                            {userList.map((u) => {
                              const isSelected = recipientUserId === u.id;
                              return (
                                <button
                                  key={u.id}
                                  type="button"
                                  onClick={() => handleSelectUser(u.id)}
                                  className={cn(
                                    'w-full flex items-center justify-between rounded-md p-2 text-left text-xs transition border',
                                    isSelected
                                      ? 'bg-white border-indigo-500 ring-1 ring-indigo-500 text-slate-900 font-bold shadow-sm'
                                      : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50',
                                  )}
                                >
                                  <div>
                                    <div className="font-medium">{u.name}</div>
                                    <div className="text-[11px] text-slate-500 font-normal">
                                      {u.email}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-1.5">
                                    {u.hasActiveDevice ? (
                                      <span className="flex items-center gap-1 text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded font-semibold">
                                        <Laptop className="w-3 h-3" />
                                        ONLINE
                                      </span>
                                    ) : (
                                      <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">
                                        OFFLINE
                                      </span>
                                    )}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>
            ) : (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  수신할 팀 선택 (팀 전체에 뿌려지며, 팀원 중 1명이 먼저 수락 시 배정 확정)
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {recipientsData &&
                    recipientsData.teams.map((team) => {
                      const isSelected = recipientTeamId === team.id;
                      return (
                        <button
                          key={team.id}
                          type="button"
                          onClick={() => setRecipientTeamId(team.id)}
                          className={cn(
                            'flex items-center justify-between rounded-xl p-3.5 text-left transition border',
                            isSelected
                              ? 'bg-indigo-50/70 border-indigo-500 ring-1 ring-indigo-500'
                              : 'bg-white border-slate-200 hover:bg-slate-50',
                          )}
                        >
                          <div className="flex items-center gap-3">
                            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700 font-bold text-sm">
                              {team.name.charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <div className="text-sm font-bold text-slate-900">{team.name} 팀</div>
                              <div className="text-xs text-slate-500">
                                팀원 {team.memberCount ?? team.members?.length ?? 0}명 수신
                              </div>
                            </div>
                          </div>
                          {isSelected && <CheckCircle className="w-5 h-5 text-indigo-600" />}
                        </button>
                      );
                    })}
                </div>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">요청 제목</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="예: 로그인 API 오류 해결 요청"
              className="w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-indigo-500 focus:outline-none font-medium"
            />
          </div>

          <MarkdownEditor
            label="요청 상세 지시사항 (Original Instruction)"
            value={originalInstruction}
            onChange={setOriginalInstruction}
            rows={8}
            placeholder={'업무 목표와 요청 내용을 구체적으로 작성하세요.\nmarkdown 을 쓸 수 있습니다 — 목록, **강조**, `코드`, 표.'}
            testId="original-instruction"
          />
        </div>

        {/* 2. Markdown 문서 첨부 (에디터 & 뷰어 탭) */}
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3 mb-4">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-indigo-600" />
              <h2 className="text-sm font-bold text-slate-900">Markdown 문서 첨부</h2>
            </div>

            <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg text-xs">
              <button
                type="button"
                onClick={() => setDocTab('write')}
                className={cn(
                  'flex items-center gap-1 px-3 py-1 rounded-md font-semibold transition',
                  docTab === 'write' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-600',
                )}
              >
                <Edit3 className="w-3.5 h-3.5" />
                <span>편집</span>
              </button>
              <button
                type="button"
                onClick={() => setDocTab('preview')}
                className={cn(
                  'flex items-center gap-1 px-3 py-1 rounded-md font-semibold transition',
                  docTab === 'preview' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-600',
                )}
              >
                <Eye className="w-3.5 h-3.5" />
                <span>미리보기</span>
              </button>
            </div>
          </div>

          <div className="mb-3">
            <label className="block text-xs font-semibold text-slate-700 mb-1">문서 파일명</label>
            <input
              type="text"
              value={documentTitle}
              onChange={(e) => setDocumentTitle(e.target.value)}
              placeholder="예: api-error-analysis.md"
              className="w-full rounded-lg border border-slate-300 p-2 text-xs font-mono focus:border-indigo-500 focus:outline-none"
            />
          </div>

          {docTab === 'write' ? (
            <textarea
              value={documentContent}
              onChange={(e) => setDocumentContent(e.target.value)}
              rows={10}
              placeholder="Markdown 형식으로 분석 내용이나 문서를 작성하세요"
              className="w-full rounded-lg border border-slate-300 p-3 font-mono text-xs focus:border-indigo-500 focus:outline-none leading-relaxed"
            />
          ) : (
            <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-4 min-h-[220px] max-h-[400px] overflow-y-auto">
              <div className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {documentContent || '미리볼 문서 내용이 없습니다.'}
                </ReactMarkdown>
              </div>
            </div>
          )}
        </div>

        {/* 3. 일반 파일 첨부 */}
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-2 border-b border-slate-100 pb-3 mb-4">
            <Paperclip className="w-4 h-4 text-indigo-600" />
            <h2 className="text-sm font-bold text-slate-900">
              참고 파일 첨부 (서버 로그, 설정 파일 등)
            </h2>
          </div>

          <AttachmentPicker attachments={attachments} onChange={setAttachments} />
        </div>

        {/* 4. 액션 버튼 */}
        <div className="flex items-center justify-end gap-3 pt-4">
          <button
            type="button"
            onClick={() => createMutation.mutate(false)}
            disabled={createMutation.isPending}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition shadow-sm disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            <span>임시저장 (DRAFT)</span>
          </button>

          <button
            type="button"
            onClick={() => createMutation.mutate(true)}
            disabled={createMutation.isPending}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 transition disabled:opacity-50"
          >
            <Send className="w-4 h-4" />
            <span>{createMutation.isPending ? '전송 중...' : 'Baton 전송하기'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
