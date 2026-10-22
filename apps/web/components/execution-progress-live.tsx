'use client';

import { agentLabel } from '@/lib/agent-label';

import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Execution, TimelineEvent } from '@/lib/types';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { Bot, CheckCircle2, AlertTriangle, Loader2, Terminal, Ban } from 'lucide-react';

import { ExecutionApprovals } from './execution-approvals';

interface ExecutionProgressLiveProps {
  execution: Execution;
  timeline: TimelineEvent[];
  requestState: string;
  canApprove?: boolean;
  onCancelled?: () => void;
}

// 02 §4.2 의 phase → 화면 라벨
const PHASE_LABEL: Record<string, string> = {
  started: '작업 시작',
  reading_input: '입력 확인',
  exploring: '코드 탐색',
  editing: '코드 수정',
  command: '명령 실행',
  testing: '테스트 실행',
  test_passed: '테스트 통과',
  test_failed: '테스트 실패',
  blocked: '정책 차단',
  note: '메모',
  warning: '경고',
  writing_result: '결과 정리',
  finished: '작업 완료',
  finished_partial: '부분 완료',
  failed: '실패',
  cancelled: '중단',
};

// 실서버 모드: 데몬이 보고한 timeline 이벤트(execution.started / execution.progress_reported)를 그대로 표시한다.
export function ExecutionProgressLive({
  execution,
  timeline,
  requestState,
  onCancelled,
  canApprove = false,
}: ExecutionProgressLiveProps) {
  const [cancelSupported, setCancelSupported] = useState<boolean | null>(null);
  // W6d: window.confirm/alert 은 렌더러를 통째로 멈춰(실행 중 2초 폴링과 겹치면 클릭 자체가 먹지 않는다)
  // 취소 버튼을 사실상 못 누르게 만들었다. 앱의 다른 화면과 같은 인라인 확인·안내로 바꾼다.
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelNotice, setCancelNotice] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const cancelMutation = useMutation({
    mutationFn: () => apiClient.cancelExecution(execution.id),
    onSuccess: () => {
      setConfirmingCancel(false);
      setCancelNotice({
        type: 'success',
        text: '실행을 취소했습니다. 요청이 다시 실행 대기 상태로 돌아갑니다.',
      });
      onCancelled?.();
    },
    onError: (err: any) => {
      setConfirmingCancel(false);
      // W6a 미배포 상태 감지 (404 Not Found 등)
      if (err?.message?.includes('404') || err?.message?.includes('not found')) {
        setCancelSupported(false);
        setCancelNotice({
          type: 'error',
          text: '서버에서 실행 취소 API(POST /v1/executions/{id}/cancel)가 아직 지원되지 않습니다.',
        });
      } else {
        setCancelNotice({
          type: 'error',
          text: `실행 취소 실패: ${err?.message || '알 수 없는 오류'}`,
        });
      }
    },
  });

  const events = timeline.filter(
    (e) =>
      e.executionId === execution.id &&
      (e.eventType === 'execution.started' ||
        e.eventType === 'execution.progress_reported' ||
        e.eventType === 'execution.queued' ||
        e.eventType === 'execution.failed' ||
        e.eventType === 'execution.finished'),
  );
  const last = events[events.length - 1];
  const lastPhase =
    last?.eventType === 'execution.progress_reported'
      ? String(last.payload?.phase ?? '')
      : last?.eventType === 'execution.started'
        ? 'started'
        : 'queued';
  const waiting = requestState === 'READY_TO_RUN';
  const reached = new Set(
    events.map((e) =>
      e.eventType === 'execution.progress_reported'
        ? String(e.payload?.phase)
        : e.eventType === 'execution.started'
          ? 'started'
          : '',
    ),
  );
  const steps = [
    'started',
    'reading_input',
    'exploring',
    'editing',
    'testing',
    'test_passed',
    'writing_result',
    'finished',
  ];

  const isTerminated = requestState === 'COMPLETED' || requestState === 'FAILED';

  return (
    <div className="rounded-xl border border-blue-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4 mb-5">
        <div className="flex items-center gap-2.5">
          <div
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-lg text-white shadow-xs',
              waiting ? 'bg-slate-500' : 'bg-blue-600 animate-pulse',
            )}
          >
            <Bot className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-bold text-base text-slate-900 flex items-center gap-2">
              <span>로컬 에이전트 실행 {waiting ? '대기' : '진행'} 중</span>
              <span className="rounded bg-blue-50 text-blue-700 text-xs px-2 py-0.5 border border-blue-200 font-mono">
                {requestState}
              </span>
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {waiting
                ? `${agentLabel(execution.agent?.provider)} 실행이 시작되면 여기에 진행 상태가 표시됩니다.`
                : `${agentLabel(execution.agent?.provider)} 실행 중입니다. 받은 사람의 Mac에서 작업을 수행하고 있습니다. 2초마다 갱신됩니다.`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>현재 단계: {PHASE_LABEL[lastPhase] ?? lastPhase}</span>
          </div>

          {/* 실행 취소 (W6a: POST /v1/executions/{id}/cancel). 확인은 인라인으로 받는다. */}
          {confirmingCancel ? (
            <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5">
              <span className="text-xs font-semibold text-red-700">
                진행 중인 실행을 취소할까요?
              </span>
              <button
                type="button"
                onClick={() => cancelMutation.mutate()}
                disabled={cancelMutation.isPending}
                className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {cancelMutation.isPending ? '취소 중...' : '네, 취소합니다'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingCancel(false)}
                className="rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-white"
              >
                아니오
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingCancel(true)}
              disabled={cancelMutation.isPending || isTerminated || cancelSupported === false}
              className="flex items-center gap-1 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 transition border border-red-200 disabled:opacity-50 disabled:cursor-not-allowed shadow-xs"
              title={
                cancelSupported === false
                  ? '서버에서 실행 취소 API(POST /v1/executions/{id}/cancel)가 지원되지 않습니다.'
                  : '진행 중인 에이전트 실행을 중단하고 취소합니다.'
              }
            >
              <Ban className="w-3.5 h-3.5" />
              <span>실행 취소</span>
            </button>
          )}
        </div>
      </div>

      {cancelNotice && (
        <div
          className={cn(
            'mb-4 rounded-lg border p-2.5 text-xs',
            cancelNotice.type === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-red-200 bg-red-50 text-red-800',
          )}
        >
          {cancelNotice.text}
        </div>
      )}

      {canApprove && <ExecutionApprovals key={execution.id} executionId={execution.id} />}

      {/* 단계 표시 (02 §4.2 순서) */}
      <div className="grid grid-cols-4 sm:grid-cols-8 gap-2 mb-5">
        {steps.map((s) => (
          <div
            key={s}
            className={cn(
              'rounded-lg border px-2 py-1.5 text-center text-[11px] font-semibold',
              reached.has(s)
                ? 'border-blue-300 bg-blue-50 text-blue-700'
                : 'border-slate-200 bg-slate-50 text-slate-400',
            )}
          >
            {reached.has(s) ? <CheckCircle2 className="w-3.5 h-3.5 inline mr-1" /> : null}
            {PHASE_LABEL[s]}
          </div>
        ))}
      </div>

      {/* 실시간 로그 */}
      <div className="rounded-lg bg-slate-900 text-slate-100 p-3 font-mono text-[11px] max-h-64 overflow-auto">
        <div className="flex items-center gap-1.5 text-slate-400 mb-2">
          <Terminal className="w-3.5 h-3.5" />
          <span>데몬 보고 ({events.length}건)</span>
        </div>
        {events.length === 0 && (
          <div className="text-slate-500">아직 보고된 진행 이벤트가 없습니다.</div>
        )}
        {events.map((e) => {
          const phase =
            e.eventType === 'execution.progress_reported'
              ? String(e.payload?.phase ?? '')
              : e.eventType.replace('execution.', '');
          const message = String(e.payload?.message ?? e.payload?.reason ?? '');
          const isBad = phase === 'failed' || phase === 'blocked' || phase === 'test_failed';
          return (
            <div key={e.id} className={cn('flex gap-2 py-0.5', isBad ? 'text-red-300' : '')}>
              <span className="text-slate-500 shrink-0">
                {new Date(e.occurredAt).toLocaleTimeString()}
              </span>
              <span className="text-blue-300 shrink-0 w-32">{phase}</span>
              <span className="break-all">{message}</span>
              {isBad && <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
