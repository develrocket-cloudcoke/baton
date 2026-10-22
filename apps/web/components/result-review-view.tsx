'use client';

import { ArtifactFile } from '@/components/artifact-file';

import { agentLabel } from '@/lib/agent-label';

import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { apiClient, API_MODE } from '@/lib/api-client';
import { Result, Execution, RequestState } from '@/lib/types';
import {
  DiffViewer,
  SAMPLE_MULTI_FILE_DIFF,
  SAMPLE_FOLLOW_UP_MULTI_FILE_DIFF,
} from '@/components/diff-viewer';
import { cn } from '@/lib/utils';
import { ModelSelect } from '@/components/model-select';
import {
  FileCheck,
  Send,
  RotateCcw,
  Sparkles,
  CheckCircle2,
  FileText,
  Layers,
  X,
  AlertTriangle,
  History,
  ShieldAlert,
  KeyRound,
  Undo2,
  Trash2,
  XCircle,
} from 'lucide-react';

interface ResultReviewViewProps {
  result: Result;
  results?: Result[];
  executions?: Execution[];
  reviewedByUserId: string;
  onApproved: () => void;
  onRequestFollowUp: (input: {
    instruction: string;
    agentId: string;
    projectId: string;
    model: string | null;
  }) => void;
  requestState?: RequestState;
  isCompleted?: boolean;
  /**
   * CLO-141 결과 검토의 출구 셋. 없으면 버튼을 그리지 않는다(COMPLETED 이력 화면 등).
   * 대화상자는 요청 상세 페이지가 이미 갖고 있으므로 여기서는 열기만 한다.
   */
  onReturn?: () => void;
  onReject?: () => void;
  onDiscard?: () => void;
}

export function ResultReviewView({
  result,
  results,
  executions,
  reviewedByUserId,
  onApproved,
  onRequestFollowUp,
  requestState,
  isCompleted = false,
  onReturn,
  onReject,
  onDiscard,
}: ResultReviewViewProps) {
  const searchParams = useSearchParams();
  const [showFollowUpModal, setShowFollowUpModal] = useState<boolean>(
    () => searchParams?.get('modal') === 'followup',
  );
  const [followUpInstruction, setFollowUpInstruction] = useState<string>(
    () => searchParams?.get('followUpText') || '',
  );
  // 추가 작업을 넘길 대상. 기본은 이전 실행과 같은 에이전트(= 세션 이어가기)다.
  const [followUpAgentId, setFollowUpAgentId] = useState<string>('');
  const [followUpProjectId, setFollowUpProjectId] = useState<string>('');
  const [followUpModel, setFollowUpModel] = useState<string>('');

  // URL 쿼리 파라미터(예: ?modal=followup) 변경 시 모달 상태 동기화
  useEffect(() => {
    if (searchParams?.get('modal') === 'followup') {
      setShowFollowUpModal(true);
    }
    const paramText = searchParams?.get('followUpText');
    if (paramText) {
      setFollowUpInstruction(paramText);
    }
  }, [searchParams]);

  // 모든 회차 결과 목록 (최소 1개)
  const allResults = (results && results.length > 0 ? results : [result]).filter(
    (item) => item.kind !== 'PARTIAL',
  );

  const roundParam = searchParams?.get('round');
  const initialRound = roundParam
    ? Math.min(Math.max(0, parseInt(roundParam, 10) - 1), allResults.length - 1)
    : allResults.length - 1;

  // 현재 선택된 회차 인덱스 (기본값: 최신 회차)
  const [selectedRound, setSelectedRound] = useState<number>(initialRound);

  // 결과 목록 길이가 변경되면 최신 회차로 자동 전환 (URL에 round 파라미터가 없을 때)
  useEffect(() => {
    if (!roundParam) {
      setSelectedRound(allResults.length - 1);
    }
  }, [allResults.length, roundParam]);

  const currentResult = allResults[selectedRound] || allResults[allResults.length - 1];

  // 선택된 결과에 대응되는 실행(Execution) 탐색
  const currentExecution =
    executions?.find((e) => e.id === currentResult.executionId) || executions?.[selectedRound];

  // 회차 번호는 **Execution 순서**로 매긴다. 취소·실패한 회차는 승인 대상 목록(allResults)에 없으므로
  // results 배열 index 로 매기면 "취소된 실행 결과 이력"(CancelledResultsView)의 회차 번호와 어긋난다
  // (§11.5-3 로 남아 있던 문제이고 CLO-11 의 취소 회차 때문에 더 자주 드러난다).
  const roundNo = (index: number): number => {
    const target = allResults[index];
    const position = executions?.findIndex((e) => e.id === target?.executionId) ?? -1;
    return position >= 0 ? position + 1 : index + 1;
  };

  // 해당 회차의 추가 지시사항 추출.
  // real 모드(서버)는 Execution 에 followUpInstruction 컬럼을 따로 두지 않고 additionalInstruction 에 이번 회차 지시를 담으므로,
  // "추가 작업 회차인지" 는 previousExecutionId 로 판정한다 (회차 index 로 보면 실패한 실행이 섞였을 때 어긋난다).
  const isFollowUpRound = Boolean(
    (currentExecution as any)?.previousExecutionId || (!currentExecution && selectedRound > 0),
  );
  const currentFollowUpInstruction =
    (currentExecution as any)?.followUpInstruction ||
    (isFollowUpRound || selectedRound > 0 ? currentExecution?.additionalInstruction : null);

  // 서버는 **최신 실행의 결과만** 승인을 허용한다(409 "최신 실행의 결과만 승인할 수 있습니다.").
  // 과거 회차 탭을 보는 중이면 승인 버튼을 막고 이유를 알려 준다.
  const isLatestRound = selectedRound === allResults.length - 1;

  const completed = isCompleted || requestState === RequestState.COMPLETED;

  const approveMutation = useMutation({
    mutationFn: () => apiClient.approveAndSendResult(currentResult.id, reviewedByUserId),
    onSuccess: () => {
      onApproved();
    },
  });

  // real 모드: 데몬이 업로드한 artifact(PATCH, RESULT_ATTACHMENT) 본문을 읽어 실제 diff·result.md 를 보여준다.
  // 추가 작업을 다른 에이전트로 넘길 수 있어야 한다 (결과가 마음에 들지 않을 때).
  const { data: agentsData } = useQuery({
    queryKey: ['agents'],
    queryFn: () => apiClient.getAgents(),
    enabled: API_MODE === 'real',
  });
  const { data: projectsData } = useQuery({
    queryKey: ['projects'],
    queryFn: () => apiClient.getProjects(),
    enabled: API_MODE === 'real',
  });
  // 비활성(DISABLED) 에이전트는 고를 수 없다. 앱을 다시 설치하거나 재-pairing 하면
  // 예전 Agent 가 비활성으로 남는데, 그것도 목록에 보여 주면 고른 뒤에야 서버가
  // "자신의 활성 Agent와 Project만 선택할 수 있습니다" 로 거절한다 (2026-09-21).
  const followUpAgents = (agentsData ?? []).filter((a: any) => a.status !== 'DISABLED');
  const followUpProjects = (projectsData ?? []).filter((p: any) => p.agentId === followUpAgentId);
  const previousExecAgentId = (currentExecution as any)?.agentId ?? '';
  const previousExecProjectId = (currentExecution as any)?.projectId ?? '';
  // 이전 실행의 에이전트가 아직 살아 있을 때만 기본값으로 쓴다.
  const previousAgentId = followUpAgents.some((a: any) => a.id === previousExecAgentId)
    ? previousExecAgentId
    : (followUpAgents[0]?.id ?? '');
  const previousProjectId = (projectsData ?? []).some(
    (p: any) => p.id === previousExecProjectId && p.agentId === previousAgentId,
  )
    ? previousExecProjectId
    : ((projectsData ?? []).find((p: any) => p.agentId === previousAgentId)?.id ?? '');
  const switchedAgent = !!followUpAgentId && followUpAgentId !== previousExecAgentId;

  // 모달을 열 때마다 이전 실행과 같은 대상으로 맞춰 둔다.
  useEffect(() => {
    if (!showFollowUpModal) return;
    setFollowUpAgentId(previousAgentId);
    setFollowUpProjectId(previousProjectId);
    setFollowUpModel('');
  }, [showFollowUpModal, previousAgentId, previousProjectId]);

  const artifactsQuery = useQuery({
    queryKey: ['result-artifacts', currentResult.id, ...(currentResult.artifactIds ?? [])],
    queryFn: async () =>
      Promise.all((currentResult.artifactIds ?? []).map((id) => apiClient.getArtifactText(id))),
    enabled: API_MODE === 'real' && (currentResult.artifactIds ?? []).length > 0,
  });
  const patchText = artifactsQuery.data?.find((a) => a.artifact.kind === 'PATCH')?.text || '';
  const resultMdText =
    artifactsQuery.data?.find((a) => a.artifact.kind === 'RESULT_ATTACHMENT')?.text || '';

  return (
    <div
      className={cn(
        'rounded-xl bg-white p-6 shadow-sm border transition',
        completed ? 'border-teal-300' : 'border-amber-300',
      )}
    >
      {/* 헤더 */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4 mb-5">
        <div className="flex items-center gap-2.5">
          <div
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-lg text-white shadow-xs',
              completed ? 'bg-teal-600' : 'bg-amber-500',
            )}
          >
            {completed ? <CheckCircle2 className="w-5 h-5" /> : <FileCheck className="w-5 h-5" />}
          </div>
          <div>
            <h3 className="font-bold text-base text-slate-900 flex items-center gap-2">
              <span>
                {completed
                  ? '에이전트 작업 완료 및 결과 확인'
                  : '에이전트 작업 결과 검토'}
              </span>
              <span
                className={cn(
                  'rounded text-xs px-2 py-0.5 border font-mono font-semibold',
                  completed
                    ? 'bg-teal-100 text-teal-800 border-teal-300'
                    : 'bg-amber-100 text-amber-800 border-amber-300',
                )}
              >
                {completed ? 'COMPLETED' : 'RESULT_REVIEW'}
              </span>
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {completed
                ? '수신자가 검토 및 승인한 최종 작업 결과와 회차별 상세 이력입니다.'
                : `${agentLabel(currentExecution?.agent?.provider)}의 파일 변경 및 테스트 결과를 확인한 뒤 승인하여 전달하거나 추가 작업을 요청하세요.`}
            </p>
          </div>
        </div>

        {/* 액션 버튼 그룹: RESULT_REVIEW 상태에서만 표시, COMPLETED 후에는 숨김 */}
        {!completed ? (
          <div className="flex flex-wrap items-center gap-2">
            {/* CLO-141: 결과 검토가 막다른 길이었다. "전달"과 "다시 돌리기" 말고도
                되돌려 보내거나(반려), 끝내거나(거절), 결과만 버릴(폐기) 수 있어야 한다. */}
            {onReturn && (
              <button
                type="button"
                onClick={onReturn}
                data-testid="result-return"
                className="flex items-center gap-1.5 rounded-lg border border-purple-200 bg-purple-50 px-3 py-2 text-xs font-semibold text-purple-700 hover:bg-purple-100 transition"
              >
                <Undo2 className="w-3.5 h-3.5" />
                <span>요청자에게 반려</span>
              </button>
            )}
            {onReject && (
              <button
                type="button"
                onClick={onReject}
                data-testid="result-reject"
                className="flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100 transition"
              >
                <XCircle className="w-3.5 h-3.5" />
                <span>거절</span>
              </button>
            )}
            {onDiscard && (
              <button
                type="button"
                onClick={onDiscard}
                data-testid="result-discard"
                className="flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 hover:bg-amber-100 transition"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>결과 폐기</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowFollowUpModal(true)}
              className="flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3.5 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 shadow-2xs transition"
            >
              <RotateCcw className="w-3.5 h-3.5 text-indigo-600" />
              <span>Agent에게 추가 작업 요청</span>
            </button>

            <button
              type="button"
              onClick={() => approveMutation.mutate()}
              disabled={approveMutation.isPending || !isLatestRound}
              title={
                isLatestRound
                  ? undefined
                  : `과거 회차(${roundNo(selectedRound)}차) 결과는 승인할 수 없습니다. 최신 회차(${roundNo(allResults.length - 1)}차)를 선택하세요.`
              }
              className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Send className="w-3.5 h-3.5" />
              <span>
                {approveMutation.isPending ? '전달 처리 중...' : '결과 승인 및 A에게 전달'}
              </span>
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 rounded-lg bg-teal-50 border border-teal-200 px-3 py-1.5 text-xs font-semibold text-teal-800">
            <CheckCircle2 className="w-4 h-4 text-teal-600" />
            <span>승인 및 업무 인계 완료</span>
          </div>
        )}
      </div>

      {/* 승인 실패 안내: 서버가 과거 회차 결과 승인을 409 로 막는다(최신 실행의 결과만 승인 가능). */}
      {approveMutation.isError && (
        <div className="mb-5 rounded-lg border border-rose-300 bg-rose-50 p-4 text-xs text-rose-900 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-bold mb-0.5">결과를 승인하지 못했습니다.</p>
            <p className="text-rose-800">
              {(approveMutation.error as Error)?.message || '알 수 없는 오류가 발생했습니다.'}
            </p>
            {(approveMutation.error as { status?: number })?.status === 409 && (
              <p className="text-rose-700 mt-1">
                다른 회차가 새로 실행되었거나 이미 처리된 결과입니다. 화면을 새로고침해 최신 회차를
                확인한 뒤 다시 승인해 주세요.
              </p>
            )}
          </div>
        </div>
      )}

      {/* 과거 회차를 보는 중: 승인 대상은 언제나 최신 회차다 (서버 계약) */}
      {!completed && !isLatestRound && allResults.length > 1 && (
        <div className="mb-5 rounded-lg border border-slate-300 bg-slate-50 p-3 text-xs text-slate-700 flex items-center gap-2">
          <History className="w-3.5 h-3.5 text-slate-500 shrink-0" />
          <span>
            지금 보고 있는 <strong>{roundNo(selectedRound)}차</strong> 는 과거 회차라 승인할 수
            없습니다. 승인은 최신 회차(<strong>{allResults.length}차</strong>)만 가능합니다.
          </span>
        </div>
      )}

      {/* 결과 회차 이력 탭 UI (회차가 2개 이상일 때 표시) */}
      {allResults.length > 1 && (
        <div className="mb-5 flex flex-wrap items-center gap-2 border-b border-slate-100 pb-3">
          <div className="flex items-center gap-1 text-xs font-bold text-slate-500 mr-2">
            <Layers className="w-3.5 h-3.5 text-slate-400" />
            <span>실행 회차 이력:</span>
          </div>
          <div className="flex items-center gap-1.5">
            {allResults.map((r, idx) => {
              const isCurrent = selectedRound === idx;
              const isLatest = idx === allResults.length - 1;
              return (
                <button
                  key={r.id || idx}
                  type="button"
                  onClick={() => setSelectedRound(idx)}
                  className={cn(
                    'rounded-lg px-3 py-1.5 text-xs font-semibold transition flex items-center gap-1.5',
                    isCurrent
                      ? 'bg-amber-600 text-white shadow-xs'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200 border border-slate-200',
                  )}
                >
                  <span>{roundNo(idx)}차 결과</span>
                  {isLatest && (
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.2 text-[10px] font-bold',
                        isCurrent ? 'bg-amber-700 text-white' : 'bg-amber-100 text-amber-800',
                      )}
                    >
                      최신
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* CLO-108: 위험 승인 하에 실행됨 안내 배너 */}
      {currentExecution?.acknowledgedRisks && currentExecution.acknowledgedRisks.length > 0 && (
        <div
          data-testid="execution-risk-acknowledged-banner"
          className="mb-5 rounded-xl border border-amber-300 bg-amber-50/70 p-4 text-xs text-amber-900 shadow-2xs"
        >
          <div className="flex items-center gap-2 font-bold text-amber-950 mb-1.5">
            <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0" />
            <span>
              보안 위험 승인 하에 실행됨 ({currentExecution.acknowledgedRisks.length}개 보호 미지원
              승인)
            </span>
          </div>
          <p className="text-[11px] text-amber-800 mb-3 leading-relaxed">
            이 실행은 Agent의 보안 등급상 기술적으로 강제할 수 없는 아래 보호 조치들에 대해 작업자가
            위험을 사전에 인지하고 개별 승인하여 진행되었습니다.
          </p>
          <div className="flex flex-wrap gap-2">
            {currentExecution.acknowledgedRisks.map((risk) => {
              const isCrit = risk.severity === 'critical';
              return (
                <div
                  key={risk.key}
                  className={cn(
                    'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold shadow-2xs border',
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

      {/* 회차별 추가 작업 지시사항 배너 */}
      {selectedRound > 0 && currentFollowUpInstruction && (
        <div className="mb-5 rounded-lg bg-indigo-50/90 border border-indigo-200 p-4 shadow-2xs">
          <div className="flex items-center gap-1.5 text-xs font-bold text-indigo-900 mb-1.5">
            <RotateCcw className="w-3.5 h-3.5 text-indigo-600" />
            <span>{roundNo(selectedRound)}차 추가 작업 지시사항 (Follow-up Instruction)</span>
          </div>
          <p className="text-xs text-indigo-950 font-medium whitespace-pre-wrap leading-relaxed">
            {currentFollowUpInstruction}
          </p>
        </div>
      )}
      {selectedRound === 0 && allResults.length > 1 && (
        <div className="mb-5 rounded-lg bg-slate-50 border border-slate-200 p-3 flex items-center justify-between text-xs text-slate-600">
          <div className="flex items-center gap-1.5 font-medium">
            <CheckCircle2 className="w-3.5 h-3.5 text-slate-400" />
            <span>1차 최초 실행 (Original Instruction 기준)</span>
          </div>
          <span className="text-[11px] text-slate-400 font-mono">baseline</span>
        </div>
      )}

      {/* 작업 요약 카드 */}
      <div
        className={cn(
          'mb-6 rounded-lg p-4 border',
          completed ? 'bg-teal-50/50 border-teal-200' : 'bg-amber-50/50 border-amber-200',
        )}
      >
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900">
            <Sparkles className="w-4 h-4 text-amber-600" />
            <span>에이전트 요약 (Agent Summary) · {roundNo(selectedRound)}차 실행 결과</span>
          </div>
          {/* 어떤 에이전트·모델이 낸 결과인지. 품질을 비교하려면 이게 보여야 한다. */}
          {(currentExecution as any)?.model && (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-mono text-slate-600">
              {(currentExecution as any).model}
            </span>
          )}
          {currentResult.createdAt && (
            <span className="text-[11px] text-slate-400">
              {new Date(currentResult.createdAt).toLocaleTimeString('ko-KR', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          )}
        </div>
        {/* 요약도 에이전트가 markdown 으로 쓴다. 그대로 찍으면 `**강조**` 같은 기호가 노출된다 */}
        <div className="markdown-body text-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{currentResult.summary}</ReactMarkdown>
        </div>

        {currentResult.testSummary && (
          <div className="mt-3 flex items-center gap-2 rounded bg-white px-3 py-1.5 border border-emerald-200 text-xs text-emerald-800">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>
              테스트 결과: <strong>{currentResult.testSummary}</strong>
            </span>
          </div>
        )}
      </div>

      {/* 변경 파일 목록 및 Unified Diff */}
      <div className="mb-6">
        <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider mb-2 flex items-center gap-1.5">
          <FileText className="w-4 h-4 text-slate-600" />
          <span>
            변경 파일 및 Unified Diff ({currentResult.changedFiles.length}개 파일) ·{' '}
            {roundNo(selectedRound)}차
          </span>
        </h4>
        {API_MODE === 'real' ? (
          artifactsQuery.isLoading ? (
            <div className="text-xs text-slate-500">artifact 를 불러오는 중…</div>
          ) : patchText ? (
            <DiffViewer
              filename={currentResult.changedFiles[0] || 'changes.patch'}
              diffText={patchText}
            />
          ) : (
            <div className="rounded-lg border border-dashed border-slate-300 p-3 text-xs text-slate-500">
              업로드된 patch artifact 가 없습니다. 변경 파일:{' '}
              {currentResult.changedFiles.join(', ') || '(없음)'}
            </div>
          )
        ) : (
          <DiffViewer
            filename={currentResult.changedFiles[0] || 'k8s/deployment.yaml'}
            diffText={selectedRound > 0 ? SAMPLE_FOLLOW_UP_MULTI_FILE_DIFF : SAMPLE_MULTI_FILE_DIFF}
          />
        )}
      </div>

      {/* 결과 문서 result.md (real 모드: RESULT_ATTACHMENT artifact) */}
      {API_MODE === 'real' && resultMdText && (
        <div className="mb-6">
          <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <FileText className="w-4 h-4 text-slate-600" />
            <span>결과 문서 (result.md)</span>
          </h4>
          <div className="markdown-body rounded-lg border border-slate-200 bg-slate-50 p-4">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{resultMdText}</ReactMarkdown>
          </div>
        </div>
      )}

      {API_MODE === 'real' && (currentResult.artifactIds ?? []).length > 0 && (
        <section className="mb-6 space-y-2" aria-label="결과 첨부 파일">
          {(currentResult.artifactIds ?? []).map((id) => (
            <ArtifactFile key={id} artifactId={id} file={artifactsQuery.data?.find((item) => item.artifact.id === id)?.artifact} />
          ))}
        </section>
      )}

      {/* 추가 작업 요청 모달 (window.confirm 금지, 인라인 대화상자) */}
      {showFollowUpModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl border border-slate-200 animate-in fade-in zoom-in duration-150">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-indigo-700 font-bold text-base">
                <RotateCcw className="w-5 h-5 text-indigo-600" />
                <span>AI 에이전트에게 추가 작업 요청</span>
              </div>
              <button
                type="button"
                onClick={() => setShowFollowUpModal(false)}
                className="text-slate-400 hover:text-slate-600 rounded-lg p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-600 mb-4 leading-relaxed">
              요청 즉시 새로운 Execution이 생성되고 진행 화면으로 전환됩니다.
            </p>

            {API_MODE === 'real' && (
              <div className="mb-4 space-y-3">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-slate-700">
                    실행 대상 Agent
                  </label>
                  <select
                    data-testid="follow-up-agent-select"
                    value={followUpAgentId}
                    onChange={(e) => {
                      setFollowUpAgentId(e.target.value);
                      const first = (projectsData ?? []).find(
                        (p: any) => p.agentId === e.target.value,
                      );
                      setFollowUpProjectId(first ? first.id : '');
                      setFollowUpModel('');
                    }}
                    className="w-full rounded-lg border border-slate-300 bg-white p-2.5 text-sm focus:border-indigo-500 focus:outline-none"
                  >
                    {followUpAgents.length === 0 ? (
                      <option value="">연결된 에이전트가 없습니다</option>
                    ) : (
                      followUpAgents.map((a: any) => (
                        <option key={a.id} value={a.id}>
                          {a.status === 'ONLINE' || a.status === 'BUSY' ? '● 온라인' : '○ 오프라인'}{' '}
                          — {a.displayName} ({a.provider})
                          {a.id === previousAgentId ? ' — 이전 실행' : ''}
                        </option>
                      ))
                    )}
                  </select>
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-slate-700">
                    실행 프로젝트
                  </label>
                  <select
                    data-testid="follow-up-project-select"
                    value={followUpProjectId}
                    onChange={(e) => setFollowUpProjectId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white p-2.5 text-sm focus:border-indigo-500 focus:outline-none"
                  >
                    {followUpProjects.length === 0 ? (
                      <option value="">등록된 프로젝트가 없습니다</option>
                    ) : (
                      followUpProjects.map((p: any) => (
                        <option key={p.id} value={p.id}>
                          {p.localPathHint
                            ? `${p.displayName} (${p.localPathHint})`
                            : p.displayName}
                        </option>
                      ))
                    )}
                  </select>
                </div>

                <ModelSelect
                  agent={followUpAgents.find((a: any) => a.id === followUpAgentId)}
                  value={followUpModel}
                  onChange={setFollowUpModel}
                />

                <p
                  className={cn(
                    'rounded-lg border p-2.5 text-xs leading-relaxed',
                    switchedAgent
                      ? 'border-amber-300 bg-amber-50 text-amber-900'
                      : 'border-slate-200 bg-slate-50 text-slate-600',
                  )}
                >
                  {switchedAgent
                    ? '다른 에이전트로 넘깁니다. 이전 세션을 이어갈 수 없으므로 원본 요청과 첨부, 그리고 이전 에이전트가 쓴 결과 문서를 함께 전달합니다.'
                    : '이전 실행의 세션과 git baseline 을 그대로 이어갑니다. 추가 지시만 전달됩니다.'}
                </p>
              </div>
            )}

            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              추가 작업 지시사항 <span className="text-rose-500">*</span>
            </label>
            <textarea
              value={followUpInstruction}
              onChange={(e) => setFollowUpInstruction(e.target.value)}
              rows={4}
              placeholder="예: verify.sh 외에 curl 기반 엔드포인트 헬스체크 및 로그인 API 테스트 케이스도 추가해줘."
              className="w-full rounded-lg border border-slate-300 p-3 text-xs focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none mb-4 bg-slate-50/50"
            />

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowFollowUpModal(false)}
                className="rounded-lg px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 transition"
              >
                취소
              </button>
              <button
                type="button"
                disabled={
                  !followUpInstruction.trim() ||
                  (API_MODE === 'real' && (!followUpAgentId || !followUpProjectId))
                }
                onClick={() => {
                  if (followUpInstruction.trim()) {
                    onRequestFollowUp({
                      instruction: followUpInstruction.trim(),
                      agentId: followUpAgentId,
                      projectId: followUpProjectId,
                      model: followUpModel.trim() || null,
                    });
                    setShowFollowUpModal(false);
                    setFollowUpInstruction('');
                  }
                }}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 transition disabled:opacity-50 flex items-center gap-1.5"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>추가 작업 실행</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
