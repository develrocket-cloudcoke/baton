import React from 'react';
import { RequestState } from '@/lib/types';
import { cn } from '@/lib/utils';

// 상태 색 원칙(2026-09-30): 수락됨·완료됨처럼 같은 색 계열이라 헷갈리던 쌍을 없앤다.
// 끝났거나 지금 도는 상태(실행 중·완료·실패)는 꽉 찬 색, 나머지는 서로 다른 색 계열의 연한 배지.
// 두 상태가 같은 색 계열을 쓰지 않는다(임시저장=점선 흰 배지·철회됨=회색 채움만 예외) — test/state-badge.test.ts 가 확인한다.
export const STATE_LABELS: Record<RequestState, { label: string; className: string; description: string }> = {
  [RequestState.WITHDRAWN]: {
    label: '철회됨',
    className: 'bg-slate-200 text-slate-600 border-slate-300',
    description: '보낸 사람이 요청을 철회했습니다'
  },
  [RequestState.DRAFT]: {
    label: '임시저장',
    className: 'bg-white text-slate-600 border-slate-400 border-dashed',
    description: '작성 중인 요청입니다'
  },
  [RequestState.SENT]: {
    label: '전송됨',
    className: 'bg-sky-50 text-sky-700 border-sky-300',
    description: '수신자에게 전달 중입니다'
  },
  [RequestState.DELIVERED]: {
    label: '도착함',
    className: 'bg-teal-50 text-teal-700 border-teal-300',
    description: '수신자의 컴퓨터에 알림이 전달되었습니다'
  },
  [RequestState.REVIEWING]: {
    label: '검토 중',
    className: 'bg-yellow-50 text-yellow-800 border-yellow-300',
    description: '수신자가 요청 내용을 검토하고 있습니다'
  },
  [RequestState.ACCEPTED]: {
    label: '수락됨',
    className: 'bg-lime-50 text-lime-800 border-lime-400',
    description: '수신자가 요청을 수락했습니다'
  },
  [RequestState.RETURNED]: {
    label: '반려됨',
    className: 'bg-purple-50 text-purple-700 border-purple-300',
    description: '보완이 필요하여 요청자에게 반려되었습니다'
  },
  [RequestState.REJECTED]: {
    label: '거절됨',
    className: 'bg-rose-50 text-rose-700 border-rose-300',
    description: '수신자가 요청을 거절했습니다'
  },
  [RequestState.READY_TO_RUN]: {
    label: '실행 대기',
    className: 'bg-indigo-50 text-indigo-700 border-indigo-300',
    description: '에이전트 데몬으로 실행 명령을 전달 중입니다'
  },
  [RequestState.RUNNING]: {
    label: '실행 중',
    className: 'bg-blue-600 text-white border-blue-600 animate-pulse',
    description: 'AI 에이전트가 받은 사람의 Mac에서 작업 중입니다'
  },
  [RequestState.RESULT_REVIEW]: {
    label: '결과 검토',
    className: 'bg-orange-100 text-orange-800 border-orange-400',
    description: '에이전트 작업 결과를 수신자가 검토 중입니다'
  },
  [RequestState.COMPLETED]: {
    label: '완료됨',
    className: 'bg-emerald-600 text-white border-emerald-600 font-semibold',
    description: '승인되어 요청자에게 최종 전달되었습니다'
  },
  [RequestState.FAILED]: {
    label: '실행 실패',
    className: 'bg-red-600 text-white border-red-600',
    description: '에이전트 실행 중 오류가 발생했습니다'
  }
};

/** 상태 점 색. 꽉 찬 배지(실행 중·완료·실패)는 흰 점으로 배경과 구분한다. */
const STATE_DOTS: Record<RequestState, string> = {
  [RequestState.WITHDRAWN]: 'bg-slate-500',
  [RequestState.DRAFT]: 'bg-slate-400',
  [RequestState.SENT]: 'bg-sky-500',
  [RequestState.DELIVERED]: 'bg-teal-500',
  [RequestState.REVIEWING]: 'bg-yellow-500',
  [RequestState.ACCEPTED]: 'bg-lime-600',
  [RequestState.RETURNED]: 'bg-purple-500',
  [RequestState.REJECTED]: 'bg-rose-500',
  [RequestState.READY_TO_RUN]: 'bg-indigo-500',
  [RequestState.RUNNING]: 'bg-white animate-ping',
  [RequestState.RESULT_REVIEW]: 'bg-orange-500',
  [RequestState.COMPLETED]: 'bg-white',
  [RequestState.FAILED]: 'bg-white',
};

interface StateBadgeProps {
  state: RequestState;
  className?: string;
  showDot?: boolean;
}

export function StateBadge({ state, className, showDot = true }: StateBadgeProps) {
  const info = STATE_LABELS[state] || {
    label: state,
    className: 'bg-gray-100 text-gray-800 border-gray-200',
    description: ''
  };

  return (
    <span
      title={info.description}
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border',
        info.className,
        className
      )}
    >
      {showDot && (
        <span
          className={cn('w-1.5 h-1.5 rounded-full', STATE_DOTS[state] ?? 'bg-gray-400')}
        />
      )}
      {info.label}
    </span>
  );
}
