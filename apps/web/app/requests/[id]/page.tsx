'use client';

import { WithdrawRequest } from '@/components/withdraw-request';
import { RequestContentCard } from '@/components/request-content-card';

import { canPrepareExecution, failureGuidance } from '@/lib/failure-guidance';
import { canSendFollowup } from '@/lib/followup-request';
import { canCreateDelegation } from '@/lib/delegation';
import { DelegationForm } from '@/components/delegation-form';

import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import { useAuth } from '@/components/auth-provider';
import { StateBadge } from '@/components/ui/badge';
import {
  RequestState,
  UserMeResponse,
  UnenforceableProtection,
  UnenforceableProtectionKey,
} from '@/lib/types';
import { TimelineView } from '@/components/timeline-view';
import { ExecutionPrepareForm } from '@/components/execution-prepare-form';
import { RiskAcknowledgementModal } from '@/components/risk-acknowledgement-modal';
import { effectiveAgentCapabilities } from '@baton/shared';
import { ExecutionProgressView } from '@/components/execution-progress-view';
import { ExecutionProgressLive } from '@/components/execution-progress-live';
import { API_MODE } from '@/lib/api-client';
import { CancelledResultsView } from '@/components/cancelled-results-view';
import { ResultReviewView } from '@/components/result-review-view';
import { ResendForm } from '@/components/resend-form';
import { DisclosedResultView } from '@/components/disclosed-result-view';
import { inheritedPolicyNotice, policyFromExecution } from '@/lib/execution-policy';
import { DiffViewer, SAMPLE_MULTI_FILE_DIFF } from '@/components/diff-viewer';
import {
  ArrowLeft,
  Clock,
  User as UserIcon,
  Check,
  RotateCcw,
  XCircle,
  Play,
  Send,
  CheckCircle2,
  AlertTriangle,
  History,
  Users,
  AlertCircle,
  ShieldAlert,
  KeyRound,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * 실패 사유를 사람이 읽을 수 있게 푼다.
 *
 * 데몬의 능력 게이트는 기계가 분기할 수 있게 JSON 을 남긴다(code·키 배열). 그걸 그대로
 * 화면에 찍으면 사람은 왜 실패했는지 알 수 없다 — 실제로 `{"code":"execution.
 * capability_mismatch","localRequiredKeys":[...]}` 가 그대로 노출됐다(2026-09-21).
 * message 가 있으면 그 문장만 보여 준다.
 */
function describeFailure(reason?: string | null): string {
  if (!reason) return '실행 중 오류가 발생했습니다.';
  try {
    const parsed = JSON.parse(reason) as { message?: string; code?: string };
    if (parsed && typeof parsed === 'object') return parsed.message || parsed.code || reason;
  } catch {
    // JSON 이 아니면 데몬이 사람 말로 적은 사유다. 그대로 보여 준다.
  }
  return reason;
}

export default function RequestDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestId = params.id;

  const { currentUser } = useAuth();
  const queryClient = useQueryClient();

  // 내 정보 (소속 팀 확인용)
  const { data: myInfo } = useQuery<UserMeResponse>({
    queryKey: ['me', currentUser.id],
    queryFn: () => apiClient.getMe(currentUser.id),
  });
  const myTeamIds = myInfo?.teams.map((t) => t.id || (t as any).teamId) || [];

  // 반려 및 거절 모달 상태
  const [showFollowup, setShowFollowup] = useState(false);
  const [showDelegation, setShowDelegation] = useState(false);
  const [returnModalOpen, setReturnModalOpen] = useState(false);
  // 데모 기본값을 넣지 않는다. 지우지 않으면 그대로 상대에게 전송된다
  // (2026-09-18 에 새 요청·실행 준비 화면에서 같은 문제를 고쳤는데 이 파일이 빠져 있었다).
  const [returnReason, setReturnReason] = useState('');
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  // CLO-141: 결과 검토에서 반려할 때 에이전트 결과(result.md)를 요청자에게 보여 줄지.
  // **기본은 꺼짐**이다. 실행자 환경의 산출물은 승인 전까지 나가지 않는 것이 기본값이어야 한다.
  const [discloseResult, setDiscloseResult] = useState(false);
  const [discardModalOpen, setDiscardModalOpen] = useState(false);
  const [discardReason, setDiscardReason] = useState('');

  // 에러 메시지 토스트
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const {
    data: detail,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['request', requestId],
    queryFn: () => apiClient.getRequestDetail(requestId),
    // RUNNING 중에만 2초로 따라간다. READY_TO_RUN 은 **보는 사람이 실행을 누를 때까지**
    // 서버에서 바뀔 일이 없고(팀원이 집어 가는 경우는 SSE 로 온다), 그 상태로 남은 요청의
    // 상세 페이지를 열어 두면 아무 변화도 없이 2초마다 요청을 영원히 보낸다
    // — 실제로 예전 픽스처가 남긴 READY_TO_RUN 요청에서 그 증상을 확인했다(2026-09-18).
    refetchInterval: (query) =>
      query.state.data?.request.state === RequestState.RUNNING ? 2000 : false,
  });

  // 기존 타임라인 링크는 탭 대신 하단 섹션으로 이동한다. 폴링마다 스크롤을 되돌리지 않는다.
  const loadedRequestId = detail?.request.id;
  useEffect(() => {
    if (loadedRequestId && searchParams?.get('tab') === 'timeline') {
      document.getElementById('request-timeline')?.scrollIntoView({ block: 'start' });
    }
  }, [loadedRequestId, searchParams]);

  // 상태 전이 뮤테이션들
  const sendMutation = useMutation({
    mutationFn: () => apiClient.sendRequest(requestId, currentUser.id),
    onSuccess: () => refetch(),
    onError: (err: Error) => setErrorMessage(err.message),
  });

  const claimMutation = useMutation({
    mutationFn: () => apiClient.claimRequest(requestId, currentUser.id),
    onSuccess: () => refetch(),
    onError: (err: Error) => {
      const msg = err.message || '';
      if (msg.includes('409') || msg.includes('이미') || msg.includes('Conflict')) {
        setErrorMessage('이미 다른 팀원이 먼저 수락(Claim)하여 처리 중인 요청입니다.');
      } else {
        setErrorMessage(msg);
      }
      refetch();
    },
  });

  const startReviewMutation = useMutation({
    mutationFn: () => apiClient.startReview(requestId, currentUser.id),
    onSuccess: () => refetch(),
    onError: (err: Error) => setErrorMessage(err.message),
  });

  const acceptMutation = useMutation({
    mutationFn: () => apiClient.acceptRequest(requestId, currentUser.id),
    onSuccess: () => refetch(),
    onError: (err: Error) => {
      const msg = err.message || '';
      if (msg.includes('409') || msg.includes('이미') || msg.includes('Conflict')) {
        setErrorMessage('이미 다른 팀원이 먼저 수락(Claim)하여 처리 중인 요청입니다.');
      } else {
        setErrorMessage(msg);
      }
      refetch();
    },
  });

  const returnMutation = useMutation({
    mutationFn: () =>
      apiClient.returnRequest(requestId, currentUser.id, returnReason, discloseResult),
    onSuccess: () => {
      setReturnModalOpen(false);
      setDiscloseResult(false);
      refetch();
    },
    onError: (err: Error) => setErrorMessage(err.message),
  });

  // CLO-141: 결과만 버리고 요청은 살려 둔다. 실행 설정(ACCEPTED)부터 다시 한다.
  const discardMutation = useMutation({
    mutationFn: () => apiClient.discardResult(requestId, discardReason),
    onSuccess: () => {
      setDiscardModalOpen(false);
      setDiscardReason('');
      refetch();
    },
    onError: (err: Error) => setErrorMessage(err.message),
  });

  const rejectMutation = useMutation({
    mutationFn: () => apiClient.rejectRequest(requestId, currentUser.id, rejectReason),
    onSuccess: () => {
      setRejectModalOpen(false);
      refetch();
    },
    onError: (err: Error) => setErrorMessage(err.message),
  });

  // 실행 준비 화면과 달리 이 두 경로(재실행·추가 작업)는 409(강제 불가 보호 승인 필요)를
  // 그대로 오류 문구로 띄웠다. 다른 에이전트로 넘길 때 거의 항상 걸리는 길인데
  // (Antigravity 는 4개 보호를 하나도 강제하지 못한다) 승인할 화면이 없어 막혔다.
  // 승인 모달에 "어느 에이전트라서 못 막는지" 를 함께 보여 주기 위한 목록 (비활성 Agent 도 포함하여 이전 실행의 이름을 잃지 않는다)
  const { data: agentsForRisk } = useQuery({
    queryKey: ['agents', { includeDisabled: true }],
    queryFn: () => apiClient.getAgents({ includeDisabled: true }),
    enabled: API_MODE === 'real',
  });
  const { data: projectsForRetry } = useQuery({
    queryKey: ['projects'],
    queryFn: () => apiClient.getProjects(),
    enabled: API_MODE === 'real',
  });

  const [riskPrompt, setRiskPrompt] = useState<{
    protections: UnenforceableProtection[];
    agentId: string;
    retry: (keys: UnenforceableProtectionKey[]) => void;
  } | null>(null);

  // 재실행·추가 작업은 실행 준비 화면을 거치지 않는다. 그렇다고 여기서 정책을 지어내면
  // 1회차에 사람이 승인한 권한이 예고 없이 기본값으로 리셋된다(전수조사 결함 4).
  // 이전 실행이 실제로 쓴 정책을 그대로 물려주고, 못 읽으면 보내지 않아 서버 기본값에 맡긴다.
  // 어느 쪽이든 강제 불가 보호는 서버가 매번 다시 계산해 409 로 막으므로 승인은 건너뛰지 않는다.
  const previousExecution = detail?.latestExecution ?? null;

  const riskAgent =
    (agentsForRisk ?? []).find((a: any) => a.id === riskPrompt?.agentId) ??
    (previousExecution?.agentId === riskPrompt?.agentId ? (previousExecution as any)?.agent : null);

  /** 409 면 승인 모달을 띄우고 true 를 돌려준다(호출자는 오류로 처리하지 않는다). */
  const openRiskPromptIfNeeded = (
    err: any,
    agentId: string,
    retry: (keys: UnenforceableProtectionKey[]) => void,
  ): boolean => {
    if (err?.status !== 409 && err?.statusCode !== 409) return false;
    const body = err.data || err.response || err;
    const protections: UnenforceableProtection[] = body?.unenforceableProtections ?? [];
    if (!protections.length) return false;
    setRiskPrompt({ protections, agentId, retry });
    return true;
  };

  /**
   * 재실행 대상을 지금 살아 있는 Agent·Project 로 옮긴다.
   *
   * 앱을 다시 설치하거나 재-pairing 하면 **같은 기기라도 Agent 가 새로 등록되고 예전
   * 것은 DISABLED 가 된다.** 이전 실행의 agentId 를 그대로 쓰면 서버가 "자신의 활성
   * Agent와 Project만 선택할 수 있습니다" 로 거절하는데, 사람 입장에서는 같은
   * 컴퓨터에 같은 프로젝트라 이유를 알 수 없다 (2026-09-21).
   *
   * 그래서 provider 와 로컬 경로가 같은 현재 등록으로 되짚는다. 못 찾으면 추측하지
   * 않고 무엇을 해야 하는지 알려 준다.
   */
  const retryTarget = React.useMemo(() => {
    const agents = agentsForRisk ?? [];
    const projects = projectsForRetry ?? [];
    const prevAgentId = previousExecution?.agentId;
    const prevProjectId = previousExecution?.projectId;
    if (!prevAgentId || !prevProjectId) return null;
    const live = (id?: string) => agents.find((a: any) => a.id === id && a.status !== 'DISABLED');
    if (live(prevAgentId) && projects.some((p: any) => p.id === prevProjectId))
      return { agentId: prevAgentId, projectId: prevProjectId, remapped: false };

    const prevAgent =
      agents.find((a: any) => a.id === prevAgentId) ??
      (previousExecution?.agentId === prevAgentId ? (previousExecution as any)?.agent : null);
    const prevPath = projects.find((p: any) => p.id === prevProjectId)?.localPathHint ?? null;
    const nextAgent = agents.find(
      (a: any) => a.status !== 'DISABLED' && a.provider === prevAgent?.provider,
    );
    if (!nextAgent) return null;
    const nextProject = projects.find(
      (p: any) => p.agentId === nextAgent.id && (!prevPath || p.localPathHint === prevPath),
    );
    if (!nextProject) return null;
    return { agentId: nextAgent.id, projectId: nextProject.id, remapped: true };
  }, [agentsForRisk, projectsForRetry, previousExecution]);
  const inheritedPolicy = policyFromExecution(previousExecution);
  const policyNotice = inheritedPolicyNotice(inheritedPolicy);

  const retryMutation = useMutation({
    mutationFn: async (acknowledgedRisks?: UnenforceableProtectionKey[]) => {
      // 이전 실행이 없으면 무엇을 다시 돌릴지가 정해지지 않는다. mock ID 로 메우지 않는다.
      if (!previousExecution?.agentId || !previousExecution?.projectId)
        throw new Error(
          '이전 실행 정보를 찾지 못해 재실행할 수 없습니다. 새로고침 후 다시 시도하세요.',
        );
      if (!retryTarget)
        throw new Error(
          '이전 실행에 쓰인 에이전트가 더 이상 활성 상태가 아닙니다. 앱을 다시 설치했다면 그 컴퓨터가 다시 연결됐는지 확인한 뒤, 같은 프로젝트가 등록돼 있는지 보세요.',
        );
      return apiClient.createExecution(requestId, currentUser.id, {
        acknowledgedRisks,
        agentId: retryTarget.agentId,
        projectId: retryTarget.projectId,
        // 사람이 시킨 적 없는 문장을 에이전트에 보내지 않는다. 실패한 실행과 같은
        // 지시로 다시 돌린다 (2026-09-18 데모 기본값 사고와 같은 결함이었다).
        additionalInstruction: previousExecution.additionalInstruction ?? '',
        ...(inheritedPolicy ? { policy: inheritedPolicy } : {}),
      });
    },
    onSuccess: () => {
      setRiskPrompt(null);
      refetch();
    },
    onError: (err: any) => {
      const agentId = retryTarget?.agentId ?? detail?.latestExecution?.agentId ?? '';
      if (openRiskPromptIfNeeded(err, agentId, (keys) => retryMutation.mutate(keys))) return;
      setErrorMessage(err.message);
    },
  });

  const followUpMutation = useMutation({
    // 대상 에이전트·프로젝트·모델은 모달에서 고른다. 다른 에이전트로 넘기면 서버가
    // 세션을 이어가지 않고 원본 + 이전 결과를 새 세션에 다시 싣는다.
    mutationFn: async (input: {
      instruction: string;
      agentId: string;
      projectId: string;
      model: string | null;
      acknowledgedRisks?: UnenforceableProtectionKey[];
    }) => {
      const agentId = input.agentId || previousExecution?.agentId;
      const projectId = input.projectId || previousExecution?.projectId;
      if (!agentId || !projectId)
        throw new Error('대상 Agent·Project 를 찾지 못해 추가 작업을 시작할 수 없습니다.');
      return apiClient.createExecution(requestId, currentUser.id, {
        acknowledgedRisks: input.acknowledgedRisks,
        agentId,
        projectId,
        additionalInstruction: input.instruction,
        followUpInstruction: input.instruction,
        model: input.model,
        ...(inheritedPolicy ? { policy: inheritedPolicy } : {}),
      });
    },
    onSuccess: () => {
      setRiskPrompt(null);
      refetch();
    },
    onError: (err: any, input) => {
      if (
        openRiskPromptIfNeeded(err, input.agentId, (keys) =>
          followUpMutation.mutate({ ...input, acknowledgedRisks: keys }),
        )
      )
        return;
      setErrorMessage(err.message);
    },
  });

  if (isLoading || !detail) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-16 text-center text-slate-500">
        요청 상세 정보를 불러오는 중입니다...
      </div>
    );
  }

  const {
    request,
    sender,
    recipient,
    senderTeam,
    recipientTeam,
    currentRevision,
    latestExecution,
    latestResult,
    timeline,
  } = detail;

  // 취소·실패로 끝난 실행이 마지막이면 READY_TO_RUN 은 "다시 실행할 수 있다" 는 뜻이다.
  // 이때 옛 실행의 진행 화면을 계속 보여 주면 재실행할 방법이 없다 (W6d 발견).
  const hasActiveExecution =
    !!latestExecution &&
    (latestExecution.status === 'QUEUED' || latestExecution.status === 'RUNNING');
  const isSender = currentUser.id === request.senderUserId;
  const isRecipient =
    currentUser.id === request.recipientUserId ||
    (request.claimedBy && request.claimedBy.id === currentUser.id);
  const isBroadcastUnclaimed =
    request.recipientUserId === null && !request.claimedAt && !request.claimedBy;
  const showPrepareForm = canPrepareExecution(request.state, hasActiveExecution, !!isRecipient);
  const isMemberOfRecipientTeam = myTeamIds.includes(request.recipientTeamId);
  const canDelegate = canCreateDelegation(request.state, request.recipientTeamId, myTeamIds);
  const isClaimedByOther =
    (request.recipientUserId !== null || request.claimedAt !== null) &&
    request.recipientUserId !== currentUser.id &&
    request.claimedBy?.id !== currentUser.id;

  // CLO-141 폐기 대화상자: 지금 버리려는 결과가 실행자 컴퓨터에 남긴 변경.
  const discardedChangedFiles: string[] = Array.isArray(latestResult?.changedFiles)
    ? (latestResult.changedFiles as string[])
    : [];
  // 폐기한 뒤에도 그 변경은 남아 있다. 마지막 result.discarded 이벤트에서 목록을 읽어
  // 실행 설정 화면 위에 계속 보여 준다 — 다시 실행하기 전에 알아야 할 사실이다.
  const lastDiscarded = [...(timeline ?? [])]
    .reverse()
    .find((event: any) => event.eventType === 'result.discarded');
  const leftoverChangedFiles: string[] = Array.isArray(
    (lastDiscarded?.payload as any)?.changedFiles,
  )
    ? ((lastDiscarded!.payload as any).changedFiles as string[])
    : [];

  // CLO-141: 반려하며 공개된 result.md. 서버가 요청자용 응답에서 artifactIds 를 그 한 건으로
  // 좁혀 주므로(sender-projection), 여기서는 값이 있는지만 본다.
  const disclosedResultArtifactId: string | null =
    isSender && request.state === RequestState.RETURNED
      ? ((latestResult?.artifactIds?.[0] as string | undefined) ?? null)
      : null;

  const senderTeamName = senderTeam?.name || request.senderTeamId || 'backend';
  const recipientTeamName = recipientTeam?.name || request.recipientTeamId || 'infra';

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      {/* 뒤로 가기 */}
      <div className="mb-4">
        <Link
          href="/requests"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-800 transition"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>요청 목록으로 돌아가기</span>
        </Link>
      </div>

      {/* 에러 알림 토스트 / 배너 */}
      {errorMessage && (
        <div className="mb-6 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900 flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-red-600 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button
            onClick={() => setErrorMessage(null)}
            className="text-xs font-bold text-red-700 hover:text-red-900"
          >
            닫기
          </button>
        </div>
      )}

      {/* 상단 메인 헤더 카드 */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 pb-5 mb-5">
          <div>
            <div className="flex items-center gap-2.5 mb-2 flex-wrap">
              <StateBadge state={request.state} />

              {/* 팀 뿌리기 미확정 배지 */}
              {isBroadcastUnclaimed && (
                <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 border border-amber-300 px-2 py-0.5 text-xs font-bold text-amber-800 animate-pulse">
                  <Users className="w-3 h-3" />팀 전체 요청 (미확정)
                </span>
              )}

              <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-mono text-slate-600">
                {request.isFollowup ? `이어서 요청(${request.currentRevisionNo}차)` : `Revision ${request.currentRevisionNo}`}
              </span>
              <span className="text-xs text-slate-400 font-mono">#{request.id}</span>
            </div>
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">{request.title}</h1>
          </div>

          {/* DRAFT 상태일 때 발신자의 [Baton 전송] 버튼 */}
          {request.state === RequestState.DRAFT && isSender && (
            <button
              onClick={() => sendMutation.mutate()}
              disabled={sendMutation.isPending}
              className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 transition"
            >
              <Send className="w-4 h-4" />
              <span>{sendMutation.isPending ? '전송 중...' : 'Baton 전송하기'}</span>
            </button>
          )}
        </div>

        {/* 메타데이터 정보 바 (05 설계: 팀 정보 포함) */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs text-slate-600">
          <div>
            <span className="text-slate-400 block mb-0.5">보낸 곳</span>
            <strong className="text-slate-800 block">{senderTeamName} 팀</strong>
            <span className={isSender ? 'text-indigo-600 font-semibold' : 'text-slate-500'}>
              {sender.displayName} {isSender && '(나)'}
            </span>
          </div>
          <div>
            <span className="text-slate-400 block mb-0.5">받는 곳</span>
            <strong className="text-slate-800 block">{recipientTeamName} 팀</strong>
            {isBroadcastUnclaimed ? (
              <span className="text-amber-700 font-bold">미확정 (팀 전체)</span>
            ) : (
              <span className={isRecipient ? 'text-purple-600 font-semibold' : 'text-slate-500'}>
                {request.claimedBy?.displayName || recipient?.displayName || '수신자'}{' '}
                {isRecipient && '(나)'}
              </span>
            )}
          </div>
          <div>
            <span className="text-slate-400 block mb-0.5">생성 일시</span>
            <span>{new Date(request.createdAt).toLocaleString('ko-KR')}</span>
          </div>
          <div>
            <span className="text-slate-400 block mb-0.5">최종 갱신</span>
            <span>{new Date(request.updatedAt).toLocaleString('ko-KR')}</span>
          </div>
        </div>
      </div>

      <RequestContentCard
        key={`${request.id}:${currentRevision.id}:${request.state}`}
        detail={detail}
      />

      {detail.parent && (
        <section className="mb-6 rounded-xl border border-indigo-200 bg-indigo-50/60 p-4">
          <p className="text-sm font-semibold text-indigo-950">
            원본 요청에서 이어짐:{' '}
            {detail.parent.id ? <Link className="underline hover:text-indigo-700" href={`/requests/${detail.parent.id}`}>{detail.parent.title}</Link> : detail.parent.title}
          </p>
          <details className="mt-2 text-sm text-slate-700">
            <summary className="cursor-pointer text-xs font-semibold text-indigo-800">원본 요청 맥락</summary>
            <div className="mt-3 space-y-3">
              {detail.parent.context?.parentInstruction && <div><h3 className="mb-1 text-xs font-bold text-slate-600">원본 지시</h3><p className="whitespace-pre-wrap">{detail.parent.context.parentInstruction}</p></div>}
              {!!detail.parent.context?.parentResults?.length && <div><h3 className="mb-1 text-xs font-bold text-slate-600">전달된 결과 요약</h3>
                <ul className="list-disc space-y-1 pl-5">{detail.parent.context.parentResults.map((result, index) => <li key={`${result.revisionNo}-${index}`}>{result.revisionNo}차 · {result.summary}</li>)}</ul>
              </div>}
            </div>
          </details>
        </section>
      )}

      {!!detail.children?.length && (
        <section className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-sm font-bold text-slate-900">하위 요청</h2>
          <ul className="space-y-3">
            {detail.children.map((child, index) => <li key={child.id ?? `${child.recipientTeam.id ?? child.recipientTeam.name}-${index}`} className="rounded-lg bg-slate-50 p-3">
              {child.id ? <>
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/requests/${child.id}`} className="font-semibold text-indigo-700 hover:underline">{child.title}</Link>
                  <StateBadge state={child.state} />
                </div>
                <p className="mt-1 text-xs text-slate-600">받는 팀: {child.recipientTeam.name}</p>
                {child.latestApprovedResultSummary && <p className="mt-2 text-sm text-slate-700">승인 결과: {child.latestApprovedResultSummary}</p>}
              </> : <p className="text-sm text-slate-700">{child.recipientTeam.name}팀에 도움을 요청했습니다 · <StateBadge state={child.state} /></p>}
            </li>)}
          </ul>
        </section>
      )}

      {canDelegate && <section className="mb-6">
        {!showDelegation ? <button type="button" onClick={() => setShowDelegation(true)}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700">다른 팀에 도움 요청</button>
          : <DelegationForm detail={detail} userId={currentUser.id} onCancel={() => setShowDelegation(false)}
            onSuccess={(childId) => router.push(`/requests/${childId}`)} />}
      </section>}

      {/* 미확정 팀 뿌리기 수신 안내 및 Claim 배너 */}
      {isBroadcastUnclaimed && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-5 mb-6 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="font-bold text-sm text-amber-950 flex items-center gap-2">
                <Users className="w-4 h-4 text-amber-600" />
                <span>팀 전체({recipientTeamName})에 전달된 미확정 요청입니다</span>
              </h2>
              <p className="text-xs text-amber-800 mt-1">
                팀원 중 누구나 수락하여 본인이 처리할 수 있습니다. 먼저 행동을 취한 구성원에게 배정
                확정(Claim)됩니다.
              </p>
            </div>

            {isMemberOfRecipientTeam ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => claimMutation.mutate()}
                  disabled={claimMutation.isPending}
                  className="flex items-center gap-1.5 rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-amber-700 disabled:opacity-50 transition"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>{claimMutation.isPending ? '배정 중...' : '내가 담당하기 (Claim)'}</span>
                </button>
                <button
                  onClick={() => acceptMutation.mutate()}
                  disabled={acceptMutation.isPending}
                  className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50 transition"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>{acceptMutation.isPending ? '수락 중...' : '즉시 수락하기'}</span>
                </button>
              </div>
            ) : (
              <span className="text-xs text-amber-700 italic">
                (해당 수신 팀의 멤버만 수락할 수 있습니다)
              </span>
            )}
          </div>
        </div>
      )}

      {/* 타인이 이미 Claim했거나 처리한 경우 상태별 안내 바 */}
      {isClaimedByOther &&
        (() => {
          const handlerDisplayName =
            request.claimedBy?.displayName || recipient?.displayName || '담당자';

          if (request.state === RequestState.COMPLETED) {
            return (
              <div className="rounded-xl border border-teal-200 bg-teal-50/80 p-4 mb-6 text-xs text-teal-900 flex items-center justify-between shadow-xs">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-teal-600 shrink-0" />
                  <span>
                    완료됨 · 처리자: <strong>{handlerDisplayName}</strong> (에이전트 실행 및 결과
                    승인 완료)
                  </span>
                </div>
                <span className="text-teal-700 text-[11px] font-medium">최종 처리 완료</span>
              </div>
            );
          }

          if (request.state === RequestState.REJECTED) {
            return (
              <div className="rounded-xl border border-rose-200 bg-rose-50/80 p-4 mb-6 text-xs text-rose-900 flex items-center justify-between shadow-xs">
                <div className="flex items-center gap-2">
                  <XCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>
                    거절됨 · 담당자: <strong>{handlerDisplayName}</strong>
                  </span>
                </div>
                <span className="text-rose-700 text-[11px] font-medium">
                  수신자가 요청을 거절하였습니다.
                </span>
              </div>
            );
          }

          if (request.state === RequestState.RETURNED) {
            return (
              <div className="rounded-xl border border-purple-200 bg-purple-50/80 p-4 mb-6 text-xs text-purple-900 flex items-center justify-between shadow-xs">
                <div className="flex items-center gap-2">
                  <RotateCcw className="w-4 h-4 text-purple-600 shrink-0" />
                  <span>
                    반려됨 · 검토자: <strong>{handlerDisplayName}</strong>
                  </span>
                </div>
                <span className="text-purple-700 text-[11px] font-medium">
                  내용 보완 후 재전송 필요
                </span>
              </div>
            );
          }

          if (request.state === RequestState.FAILED) {
            return (
              <div className="rounded-xl border border-red-200 bg-red-50/80 p-4 mb-6 text-xs text-red-900 flex items-center justify-between shadow-xs">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
                  <span>
                    실행 실패 · 담당자: <strong>{handlerDisplayName}</strong>
                  </span>
                </div>
                <span className="text-red-700 text-[11px] font-medium">에이전트 실행 실패</span>
              </div>
            );
          }

          // 아직 열람·수락 전(SENT/DELIVERED)인데 "수락하여 처리 중" 이라고 하면 사실과 다르다 (W6d).
          // 사람 지정 요청은 처음부터 recipientUserId 가 정해져 있으므로 상태로 구분한다.
          if (request.state === RequestState.SENT || request.state === RequestState.DELIVERED) {
            return (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 mb-6 text-xs text-slate-600 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <UserIcon className="w-4 h-4 text-slate-400 shrink-0" />
                  <span>
                    <strong>{handlerDisplayName}</strong> 님에게 전달되었습니다.{' '}
                    {request.state === RequestState.SENT
                      ? '아직 열람 전입니다.'
                      : '수신자가 확인했습니다 (검토 시작 전).'}
                  </span>
                </div>
                <span className="text-slate-400 text-[11px]">
                  수신자가 검토를 시작하면 상태가 바뀝니다.
                </span>
              </div>
            );
          }

          return (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 mb-6 text-xs text-slate-600 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <UserIcon className="w-4 h-4 text-slate-400 shrink-0" />
                <span>
                  이 요청은 <strong>{handlerDisplayName}</strong> 님이 수락하여 처리 중입니다.
                </span>
              </div>
              <span className="text-slate-400 text-[11px]">
                다른 팀원은 작업을 수정할 수 없습니다.
              </span>
            </div>
          );
        })()}

      {/* 수신자 전용: SENT·DELIVERED 상태 인터랙션.
          서버 startReview 가 SENT 면 DELIVERED 를 거쳐 REVIEWING 으로 보내 주므로(requests.service.ts) 두 상태 모두에서 띄운다.
          real 모드에는 SENT→DELIVERED 를 따로 만드는 경로가 없어 DELIVERED 로만 걸면 검토를 시작할 방법이 사라진다. */}
      {(request.state === RequestState.DELIVERED || request.state === RequestState.SENT) &&
        isRecipient && (
          <div className="rounded-xl border border-cyan-300 bg-cyan-50/70 p-4 mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xs">
            <div>
              <h2 className="font-bold text-sm text-cyan-950 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-cyan-600 animate-ping" />
                <span>내 컴퓨터에 새 Baton 요청이 도착했습니다</span>
              </h2>
              <p className="text-xs text-cyan-800 mt-0.5">내용을 확인하고 검토를 시작하세요.</p>
            </div>
            <button
              onClick={() => startReviewMutation.mutate()}
              disabled={startReviewMutation.isPending}
              className="flex items-center gap-1.5 rounded-lg bg-cyan-700 px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-cyan-800 transition self-start sm:self-auto"
            >
              <Clock className="w-3.5 h-3.5" />
              <span>요청 검토 시작</span>
            </button>
          </div>
        )}

      {/* 수신자 전용 액션 바: REVIEWING 상태 (수락 / 반려 / 거절) */}
      {request.state === RequestState.REVIEWING && isRecipient && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-5 mb-6 shadow-xs">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="font-bold text-sm text-amber-950 flex items-center gap-2">
                <Clock className="w-4 h-4 text-amber-600" />
                <span>요청 검토 단계</span>
              </h2>
              <p className="text-xs text-amber-800 mt-0.5">
                요청서와 첨부파일을 확인하고 수락, 반려, 또는 거절을 선택하세요.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setRejectModalOpen(true)}
                className="flex items-center gap-1.5 rounded-lg border border-rose-300 bg-white px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 transition"
              >
                <XCircle className="w-3.5 h-3.5" />
                <span>거절</span>
              </button>

              <button
                onClick={() => setReturnModalOpen(true)}
                className="flex items-center gap-1.5 rounded-lg border border-purple-300 bg-white px-3 py-2 text-xs font-semibold text-purple-700 hover:bg-purple-50 transition"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>반려 (사유 작성)</span>
              </button>

              <button
                onClick={() => acceptMutation.mutate()}
                disabled={acceptMutation.isPending}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 transition"
              >
                <Check className="w-3.5 h-3.5" />
                <span>요청 수락하기</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CLO-141: 결과를 버려도 실행자 컴퓨터의 변경은 남는다. 다시 실행하기 전에 알아야 할 사실이라
          실행 준비 화면 위에 계속 둔다 — 폐기 대화상자에서 한 번 보여 주고 끝낼 일이 아니다. */}
      {showPrepareForm && isRecipient && leftoverChangedFiles.length > 0 && (
        <div
          data-testid="discarded-leftover-banner"
          className="rounded-xl border border-amber-300 bg-amber-50 p-4 mb-6 text-xs text-amber-950"
        >
          <div className="flex items-center gap-1.5 font-bold mb-1">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            <span>
              버린 회차가 바꾼 파일 {leftoverChangedFiles.length}개가 그대로 남아 있습니다
            </span>
          </div>
          <p className="text-[11px] text-amber-800 mb-2">
            Baton 은 실행자 컴퓨터의 변경을 되돌리지 않습니다. 이 상태에서 다시 실행하면 에이전트가
            바뀐 파일 위에서 시작합니다. 필요하면 먼저 정리하세요(
            <code className="font-mono">git checkout</code> ·{' '}
            <code className="font-mono">git stash</code>).
          </p>
          <ul className="max-h-32 overflow-y-auto font-mono text-[11px] text-amber-900">
            {leftoverChangedFiles.map((file) => (
              <li key={file} className="truncate">
                · {file}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 실행 준비 화면: ACCEPTED·READY_TO_RUN, 실패 후에는 실행자가 설정을 다시 선택한다 */}
      {showPrepareForm && (
        <div className="mb-6">
          {isRecipient ? (
            <ExecutionPrepareForm
              request={request}
              title={request.state === RequestState.FAILED ? '다시 실행' : undefined}
              executorUserId={currentUser.id}
              onSuccess={() => refetch()}
            />
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-slate-600 text-sm">
              수신자({recipient?.displayName || '담당자'})가 요청을 수락했습니다. 로컬 AI 에이전트
              실행 준비를 대기하고 있습니다.
            </div>
          )}
        </div>
      )}

      {/* CLO-108: 위험 승인 하에 실행 중/실행됨 안내 배너 */}
      {latestExecution?.acknowledgedRisks && latestExecution.acknowledgedRisks.length > 0 && (
        <div
          data-testid="request-detail-risk-acknowledged-banner"
          className="rounded-xl border border-amber-300 bg-amber-50/80 p-4 mb-6 text-xs text-amber-950 shadow-2xs"
        >
          <div className="flex items-center gap-2 font-bold text-amber-950 mb-1.5">
            <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0" />
            <span>
              위험 승인 하에 실행됨 ({latestExecution.acknowledgedRisks.length}개 보안 보호 미지원
              승인)
            </span>
          </div>
          <p className="text-[11px] text-amber-800 mb-2.5 leading-relaxed">
            이 실행은 Agent의 보안 등급상 기술적으로 강제할 수 없는 아래 보호 조치들에 대해 작업자가
            위험을 사전에 인지하고 개별 승인한 후 진행되었습니다.
          </p>
          <div className="flex flex-wrap gap-2">
            {latestExecution.acknowledgedRisks.map((risk) => {
              const isCrit = risk.severity === 'critical';
              return (
                <div
                  key={risk.key}
                  className={cn(
                    'flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold shadow-2xs border',
                    isCrit
                      ? 'bg-red-50 text-red-900 border-red-300'
                      : 'bg-white text-amber-900 border-amber-300',
                  )}
                >
                  {isCrit ? (
                    <KeyRound className="w-3.5 h-3.5 text-red-600 shrink-0" />
                  ) : (
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                  )}
                  <span>{risk.title}</span>
                  <span
                    className={cn(
                      'text-[10px] px-1 py-0.2 rounded font-bold uppercase',
                      isCrit ? 'bg-red-200 text-red-900' : 'bg-amber-100 text-amber-800',
                    )}
                  >
                    {risk.severity}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 실행 진행 화면: 아직 끝나지 않은 실행(QUEUED/RUNNING)이 있을 때만 */}
      {(request.state === RequestState.READY_TO_RUN || request.state === RequestState.RUNNING) &&
        hasActiveExecution &&
        latestExecution && (
          <div className="mb-6">
            {API_MODE === 'real' ? (
              <ExecutionProgressLive
                execution={latestExecution}
                canApprove={
                  request.recipientUserId === currentUser.id &&
                  latestExecution.executorUserId === currentUser.id
                }
                timeline={timeline}
                requestState={request.state}
                onCancelled={() => refetch()}
              />
            ) : (
              <ExecutionProgressView
                execution={latestExecution}
                onCompleted={() => refetch()}
                onFailed={() => refetch()}
              />
            )}
          </div>
        )}

      <CancelledResultsView executions={detail.executions} results={detail.results} />

      {/* 결과 검토 화면: RESULT_REVIEW 상태 */}
      {request.state === RequestState.RESULT_REVIEW && latestResult && (
        <div className="mb-6">
          {isRecipient ? (
            <>
              {/* 추가 작업도 같은 정책을 물려받는다. 모달을 열기 전에 알려 준다. */}
              <p data-testid="follow-up-policy-notice" className="mb-2 text-xs text-slate-500">
                {policyNotice}
              </p>
              <ResultReviewView
                result={latestResult}
                results={detail.results?.filter((result) => result.kind !== 'PARTIAL')}
                executions={detail.executions}
                reviewedByUserId={currentUser.id}
                requestState={request.state}
                onApproved={() => refetch()}
                onRequestFollowUp={(input) => {
                  followUpMutation.mutate(input);
                }}
                onReturn={() => setReturnModalOpen(true)}
                onReject={() => setRejectModalOpen(true)}
                onDiscard={() => setDiscardModalOpen(true)}
              />
            </>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-slate-600 text-sm">
              에이전트가 작업을 마쳤습니다. 수신자({recipient?.displayName || '담당자'})가 결과를
              검토하고 승인하기를 기다리는 중입니다.
            </div>
          )}
        </div>
      )}

      {/* 최종 완료 화면: COMPLETED 상태 (회차별 이력 유지 및 승인 완료 표시) */}
      {request.state === RequestState.COMPLETED && latestResult && (
        <div className="mb-6">
          <ResultReviewView
            result={latestResult}
            results={detail.results?.filter((result) => result.kind !== 'PARTIAL')}
            executions={detail.executions}
            reviewedByUserId={currentUser.id}
            requestState={request.state}
            isCompleted={true}
            onApproved={() => refetch()}
            onRequestFollowUp={() => {}}
          />
        </div>
      )}

      {/* 반려 상태 (RETURNED) */}
      {request.state === RequestState.RETURNED && (
        <div className="mb-6">
          {isSender ? (
            <>
              {/* CLO-141: 수신자가 반려하며 공개한 result.md 가 있으면 보완 전에 읽을 수 있게 위에 둔다. */}
              {disclosedResultArtifactId && (
                <DisclosedResultView artifactId={disclosedResultArtifactId} />
              )}
              <ResendForm
                request={request}
                currentRevision={currentRevision}
                senderUserId={currentUser.id}
                onSuccess={() => refetch()}
              />
            </>
          ) : (
            <div className="rounded-xl border border-purple-200 bg-purple-50 p-6 text-center text-purple-900 text-sm">
              <RotateCcw className="w-6 h-6 text-purple-600 mx-auto mb-2" />
              <div className="font-bold">반려 처리되었습니다</div>
              <p className="mt-1 text-xs text-purple-700">
                <span className="whitespace-pre-wrap">
                  사유: &quot;{request.returnReason}&quot;
                </span>
                <br />— 요청자({sender.displayName})의 내용 보완 및 재전송을 기다리고 있습니다.
              </p>
            </div>
          )}
        </div>
      )}

      {/* 거절 상태 (REJECTED) */}
      {request.state === RequestState.REJECTED && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-6 mb-6">
          <div className="flex items-center gap-2 text-rose-900 font-bold text-sm mb-1">
            <XCircle className="w-5 h-5 text-rose-600" />
            <span>요청이 거절되었습니다</span>
          </div>
          <p className="text-xs text-rose-700">
            거절 사유: &quot;{request.returnReason || '사유 미기재'}&quot;
          </p>
        </div>
      )}

      {/* FAILED 상태 */}
      {request.state === RequestState.FAILED && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-6 mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-red-900 font-bold text-sm mb-1">
                <AlertTriangle className="w-5 h-5 text-red-600" />
                <span>에이전트 실행 실패</span>
              </div>
              <p className="text-xs text-red-700">
                실패 원인: {describeFailure(latestExecution?.failureReason)}
              </p>
              {isRecipient && (
                <p className="mt-2 text-xs text-red-800">
                  {failureGuidance(latestExecution?.failureCode)}
                </p>
              )}
              {/* 어떤 권한으로 다시 도는지 누르기 전에 보여 준다. 승계 자체는 안전하지만
                  (강제 불가 보호는 서버가 다시 묻는다) 말없이 물려받으면 그게 이 조사의 주제다. */}
              {isRecipient && (
                <p data-testid="retry-policy-notice" className="mt-2 text-xs text-red-800/80">
                  {policyNotice}
                </p>
              )}
            </div>

            {isRecipient && !hasActiveExecution && (
              <button
                onClick={() => retryMutation.mutate()}
                disabled={retryMutation.isPending}
                className="flex items-center gap-1.5 rounded-lg bg-red-700 px-4 py-2 text-xs font-semibold text-white hover:bg-red-800 transition self-start sm:self-auto"
              >
                <Play className="w-3.5 h-3.5 fill-white" />
                <span>{retryMutation.isPending ? '재실행 큐잉 중...' : '이전 설정으로 재실행'}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {canSendFollowup(request.state, request.senderUserId, currentUser.id) && !hasActiveExecution && (
        <section className="mb-6">
          <button className="rounded-lg bg-indigo-600 px-4 py-2 text-white" onClick={() => setShowFollowup(!showFollowup)}>이어서 요청</button>
          {showFollowup && <ResendForm followup request={request} currentRevision={detail.currentRevision}
            senderUserId={currentUser.id} onSuccess={() => { setShowFollowup(false); refetch(); }} />}
        </section>
      )}
      {request.currentRevisionNo > 1 && (
        <section className="mb-6 space-y-4" aria-label="차수별 대화">
          {detail.revisions.map((revision) => (
            <div key={revision.id} className="rounded-xl border border-slate-200 p-4">
              <h3 className="font-semibold">{revision.revisionNo}차 지시</h3>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{revision.originalInstruction}</ReactMarkdown>
              {(detail.executions ?? []).filter((execution) => execution.requestRevisionId === revision.id).map((execution) => {
                const result = detail.results?.find((item) => item.executionId === execution.id);
                return <div key={execution.id} className="mt-3 border-l-2 border-indigo-200 pl-3 text-sm">
                  {execution.status === 'FAILED' ? `실패: ${describeFailure(execution.failureReason)}`
                    : result?.reviewStatus === 'APPROVED' ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{result.summary}</ReactMarkdown>
                    : '결과 미전달 (진행 상태는 타임라인을 확인하세요)'}
                </div>;
              })}
            </div>
          ))}
        </section>
      )}

      <WithdrawRequest request={request} userId={currentUser.id}
        hasExecutions={!!detail.executions?.length} onSuccess={() => { refetch(); }} />
      <section id="request-timeline" aria-labelledby="request-timeline-title"
        className="rounded-xl border border-slate-200 bg-white p-6 shadow-xs">
        <h2 id="request-timeline-title" className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-900">
          <History className="h-4 w-4" />감사 타임라인 ({timeline.length})
        </h2>
        <TimelineView events={timeline} />
      </section>

      {/* 반려 사유 입력 모달 */}
      {returnModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl border border-slate-200 animate-in fade-in zoom-in duration-150">
            <div className="flex items-center gap-2 text-purple-700 font-bold text-base mb-2">
              <RotateCcw className="w-5 h-5" />
              <span>Baton 요청 반려</span>
            </div>
            <p className="text-xs text-slate-600 mb-4">
              발신자가 요청 내용을 보완할 수 있도록 구체적인 반려 사유를 작성하세요.
            </p>
            <textarea
              value={returnReason}
              onChange={(e) => setReturnReason(e.target.value)}
              rows={3}
              placeholder="반려 사유 입력"
              className="w-full rounded-lg border border-slate-300 p-2.5 text-xs focus:border-purple-500 focus:outline-none mb-4"
            />
            {/* CLO-141: 결과 검토에서 반려할 때만 뜬다. 수락 전 반려에는 보여 줄 결과가 없다. */}
            {request.state === RequestState.RESULT_REVIEW && (
              <label className="mb-4 flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  data-testid="disclose-result"
                  checked={discloseResult}
                  onChange={(e) => setDiscloseResult(e.target.checked)}
                  className="mt-0.5"
                />
                <span className="text-xs text-slate-700">
                  <span className="font-semibold">
                    에이전트 결과(result.md)를 요청자에게 보여 준다
                  </span>
                  <br />
                  <span className="text-[11px] text-slate-500">
                    체크하지 않으면 요청자는 반려 사유만 봅니다. 변경 파일 목록·patch·실행 로그는
                    체크해도 공개되지 않습니다.
                  </span>
                </span>
              </label>
            )}
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setReturnModalOpen(false)}
                className="rounded-lg px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100"
              >
                취소
              </button>
              <button
                onClick={() => returnMutation.mutate()}
                disabled={returnMutation.isPending || !returnReason.trim()}
                className="rounded-lg bg-purple-600 px-4 py-2 text-xs font-semibold text-white hover:bg-purple-700 disabled:opacity-50"
              >
                {returnMutation.isPending ? '처리 중...' : '반려 전송'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 거절 사유 입력 모달 */}
      {rejectModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl border border-slate-200 animate-in fade-in zoom-in duration-150">
            <div className="flex items-center gap-2 text-rose-700 font-bold text-base mb-2">
              <XCircle className="w-5 h-5" />
              <span>Baton 요청 거절</span>
            </div>
            <p className="text-xs text-slate-600 mb-4">
              업무를 거절하는 사유를 입력하세요. 거절된 요청은 최종 종료 상태로 잠금 처리됩니다.
            </p>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
              placeholder="거절 사유 입력"
              className="w-full rounded-lg border border-slate-300 p-2.5 text-xs focus:border-rose-500 focus:outline-none mb-4"
            />
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setRejectModalOpen(false)}
                className="rounded-lg px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100"
              >
                취소
              </button>
              <button
                onClick={() => rejectMutation.mutate()}
                disabled={rejectMutation.isPending || !rejectReason.trim()}
                className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {rejectMutation.isPending ? '처리 중...' : '거절 확정'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CLO-141: 결과 폐기. 요청은 살아 있고 실행 설정부터 다시 한다. */}
      {discardModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl border border-slate-200 animate-in fade-in zoom-in duration-150">
            <div className="flex items-center gap-2 text-amber-700 font-bold text-base mb-2">
              <Trash2 className="w-5 h-5" />
              <span>이 결과를 버리고 다시 실행</span>
            </div>
            <p className="text-xs text-slate-600 mb-3">
              요청은 그대로 살아 있습니다. 실행 설정 화면으로 돌아가 Agent·프로젝트·권한을 다시 고를
              수 있습니다. 요청자에게는 이 결과가 전달되지 않습니다.
            </p>
            {/* 되돌릴 수 없는 것을 정확히 말한다. Baton 은 실행자 컴퓨터를 건드리지 않는다. */}
            <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3">
              <div className="flex items-center gap-1.5 text-xs font-bold text-amber-900 mb-1">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>파일 변경은 그대로 남습니다</span>
              </div>
              <p className="text-[11px] text-amber-800">
                Baton 은 실행자 컴퓨터의 변경을 되돌리지 않습니다. 필요하면 직접 정리하세요 (
                <code className="font-mono">git checkout</code> ·{' '}
                <code className="font-mono">git stash</code>).
              </p>
              {discardedChangedFiles.length > 0 && (
                <ul className="mt-2 max-h-28 overflow-y-auto text-[11px] font-mono text-amber-900">
                  {discardedChangedFiles.map((file) => (
                    <li key={file} className="truncate">
                      · {file}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <textarea
              value={discardReason}
              onChange={(e) => setDiscardReason(e.target.value)}
              rows={2}
              placeholder="폐기 사유 (선택)"
              className="w-full rounded-lg border border-slate-300 p-2.5 text-xs focus:border-amber-500 focus:outline-none mb-4"
            />
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setDiscardModalOpen(false)}
                className="rounded-lg px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100"
              >
                취소
              </button>
              <button
                onClick={() => discardMutation.mutate()}
                disabled={discardMutation.isPending}
                data-testid="discard-confirm"
                className="rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {discardMutation.isPending ? '처리 중...' : '결과 버리고 다시 실행'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 강제할 수 없는 보호 항목 승인 (CLO-108). 실행 준비 화면과 같은 모달을 쓴다. */}
      {riskPrompt && (
        <RiskAcknowledgementModal
          isOpen={true}
          onClose={() => setRiskPrompt(null)}
          onConfirm={(keys) => riskPrompt.retry(keys)}
          protections={riskPrompt.protections}
          agentName={riskAgent?.displayName}
          provider={riskAgent?.provider}
          securityTier={
            riskAgent
              ? effectiveAgentCapabilities(riskAgent.provider, riskAgent.capabilities).securityTier
              : undefined
          }
          isLoading={followUpMutation.isPending || retryMutation.isPending}
        />
      )}
    </div>
  );
}
