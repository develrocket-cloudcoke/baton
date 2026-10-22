'use client';

import { agentLabel } from '@/lib/agent-label';

import React, { useState, useEffect } from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import { Execution, ExecutionProgressPhase } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  Bot,
  Terminal,
  CheckCircle2,
  AlertTriangle,
  Play,
  RotateCw,
  FastForward,
  Loader2,
  Ban,
} from 'lucide-react';

interface ExecutionProgressViewProps {
  execution: Execution;
  onCompleted: () => void;
  onFailed: () => void;
}

const PHASES_LIST: Array<{ key: ExecutionProgressPhase; label: string; desc: string }> = [
  { key: 'starting', label: '세션 초기화', desc: 'SessionStart canary hook 확인 (canary.ok)' },
  { key: 'reading_input', label: '입력 확인', desc: '요청서(api-error-analysis.md) 및 로그 분석' },
  { key: 'exploring', label: '코드 탐색', desc: '프로젝트 구조 확인 및 deployment.yaml 위치 탐색' },
  { key: 'editing', label: '코드 수정', desc: 'deployment.yaml 내 REDIS_HOST 오타 수정' },
  { key: 'testing', label: '테스트 실행', desc: 'verify.sh 스크립트 실행' },
  { key: 'test_passed', label: '테스트 통과', desc: 'DEPLOYMENT_VERIFIED_SUCCESS 검증' },
  { key: 'writing_result', label: '결과 정리', desc: 'unified patch 및 result.md 생성' },
  { key: 'completed', label: '완료', desc: '3계층 결과 수집 완료 및 데몬 보고' },
];

export function ExecutionProgressView({
  execution,
  onCompleted,
  onFailed,
}: ExecutionProgressViewProps) {
  const [currentPhase, setCurrentPhase] = useState<ExecutionProgressPhase>('starting');
  const [logMessages, setLogMessages] = useState<string[]>([]);
  const [isAutoPlaying, setIsAutoPlaying] = useState<boolean>(false);

  const stepMutation = useMutation({
    mutationFn: (forceFail?: boolean) => apiClient.simulateExecutionStep(execution.id, forceFail),
    onSuccess: (data) => {
      setCurrentPhase(data.phase);
      setLogMessages((prev) => [...prev, `[${data.phase}] ${data.message}`]);
      if (data.isDone) {
        setIsAutoPlaying(false);
        if (data.isFailed) {
          onFailed();
        } else {
          onCompleted();
        }
      }
    },
  });

  // 취소 확인은 인라인으로 받는다 (window.confirm 은 렌더러를 멈춘다)
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  // 에이전트 실행 취소 뮤테이션 (POST /v1/executions/{id}/cancel)
  const cancelMutation = useMutation({
    mutationFn: () => apiClient.cancelExecution(execution.id),
    onSuccess: () => {
      setIsAutoPlaying(false);
      setCurrentPhase('failed');
      setLogMessages((prev) => [
        ...prev,
        '[cancelled] 사용자에 의해 에이전트 실행이 취소되었습니다.',
      ]);
      onFailed();
    },
    onError: (err: Error) => {
      // W6d: 렌더러를 막는 alert 대신 로그 줄로 남긴다 (execution-progress-live 와 같은 방침)
      setLogMessages((prev) => [...prev, `[error] 실행 취소 실패: ${err.message}`]);
    },
  });

  // Auto-play 타이머
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (isAutoPlaying && currentPhase !== 'completed' && currentPhase !== 'failed') {
      timer = setTimeout(() => {
        stepMutation.mutate(false);
      }, 1200);
    }
    return () => clearTimeout(timer);
  }, [isAutoPlaying, currentPhase, stepMutation]);

  const currentStepIndex = PHASES_LIST.findIndex((p) => p.key === currentPhase);
  const progressPercent = Math.min(
    100,
    Math.round(((Math.max(0, currentStepIndex) + 1) / PHASES_LIST.length) * 100),
  );

  return (
    <div className="rounded-xl border border-blue-200 bg-white p-6 shadow-sm">
      {/* 상단 헤더 */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4 mb-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-white shadow-xs animate-pulse">
            <Bot className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-bold text-base text-slate-900 flex items-center gap-2">
              <span>로컬 에이전트 실행 진행 중</span>
              <span className="rounded bg-blue-50 text-blue-700 text-xs px-2 py-0.5 border border-blue-200 font-mono">
                RUNNING
              </span>
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {agentLabel(execution.agent?.provider)} 실행 중입니다. 받은 사람의 Mac에서 작업을 수행하고 있습니다.
            </p>
          </div>
        </div>

        {/* Mock 시뮬레이션 컨트롤 버튼들 */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsAutoPlaying(!isAutoPlaying)}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold shadow-xs transition',
              isAutoPlaying
                ? 'bg-amber-100 text-amber-800 border border-amber-300'
                : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200',
            )}
          >
            {isAutoPlaying ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>일시 정지</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                <span>자동 진행 (1.2s)</span>
              </>
            )}
          </button>

          <button
            onClick={() => stepMutation.mutate(false)}
            disabled={stepMutation.isPending || currentPhase === 'completed'}
            className="flex items-center gap-1 rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-200 transition border border-slate-200 disabled:opacity-50"
          >
            <FastForward className="w-3.5 h-3.5" />
            <span>다음 단계</span>
          </button>

          <button
            onClick={() => stepMutation.mutate(true)}
            disabled={
              stepMutation.isPending || currentPhase === 'completed' || currentPhase === 'failed'
            }
            className="flex items-center gap-1 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100 transition border border-rose-200 disabled:opacity-50"
            title="D4 재실행 시나리오 테스트용"
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>실패 유발</span>
          </button>

          {confirmingCancel ? (
            <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5">
              <span className="text-xs font-semibold text-red-700">실행을 취소할까요?</span>
              <button
                onClick={() => {
                  setConfirmingCancel(false);
                  cancelMutation.mutate();
                }}
                disabled={cancelMutation.isPending}
                className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {cancelMutation.isPending ? '취소 중...' : '네'}
              </button>
              <button
                onClick={() => setConfirmingCancel(false)}
                className="rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-white"
              >
                아니오
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmingCancel(true)}
              disabled={
                cancelMutation.isPending ||
                currentPhase === 'completed' ||
                currentPhase === 'failed'
              }
              className="flex items-center gap-1 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 transition border border-red-200 disabled:opacity-50 disabled:cursor-not-allowed shadow-xs"
              title="진행 중인 에이전트 실행을 중단하고 취소합니다 (POST /v1/executions/{id}/cancel)"
            >
              <Ban className="w-3.5 h-3.5" />
              <span>실행 취소</span>
            </button>
          )}
        </div>
      </div>

      {/* 진행 상태 프로그레스 바 */}
      <div className="mb-6">
        <div className="flex justify-between text-xs font-semibold text-slate-600 mb-2">
          <span>
            진행 단계: {PHASES_LIST[Math.max(0, currentStepIndex)]?.label || currentPhase}
          </span>
          <span>{progressPercent}%</span>
        </div>
        <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden border border-slate-200">
          <div
            className="h-full bg-gradient-to-r from-blue-500 to-indigo-600 transition-all duration-300"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      {/* 단계별 체크포인트 리스트 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-6">
        {PHASES_LIST.map((step, idx) => {
          const isPassed = idx < currentStepIndex;
          const isCurrent = idx === currentStepIndex;
          return (
            <div
              key={step.key}
              className={cn('rounded-lg border p-2 text-xs transition', {
                'border-emerald-300 bg-emerald-50/60 text-emerald-800': isPassed,
                'border-blue-400 bg-blue-50/80 text-blue-900 font-bold shadow-xs': isCurrent,
                'border-slate-200 bg-slate-50/50 text-slate-400': !isPassed && !isCurrent,
              })}
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                {isPassed ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                ) : isCurrent ? (
                  <Loader2 className="w-3.5 h-3.5 text-blue-600 animate-spin shrink-0" />
                ) : (
                  <span className="w-3.5 h-3.5 rounded-full border border-slate-300 inline-block shrink-0" />
                )}
                <span className="truncate">{step.label}</span>
              </div>
              <p className="text-[10px] text-slate-500 truncate">{step.desc}</p>
            </div>
          );
        })}
      </div>

      {/* 실시간 콘솔 로그 창 */}
      <div className="rounded-lg border border-slate-800 bg-slate-950 p-4 font-mono text-xs text-slate-200 shadow-inner">
        <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-3 text-slate-400 text-[11px]">
          <div className="flex items-center gap-2">
            <Terminal className="w-3.5 h-3.5" />
            <span>Desktop Agent Stream Log (NDJSON 매핑)</span>
          </div>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>Live</span>
          </span>
        </div>
        <div className="space-y-1.5 max-h-48 overflow-y-auto font-mono text-[11px] leading-5">
          {logMessages.map((msg, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="text-slate-600 select-none">&gt;</span>
              <span className="text-slate-300">{msg}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
