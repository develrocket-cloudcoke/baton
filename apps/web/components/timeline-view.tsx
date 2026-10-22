'use client';

import React from 'react';
import { agentLabel } from '@/lib/agent-label';
import { TimelineEvent, TimelineEventType } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  Send,
  Check,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Play,
  FileCheck,
  Bot,
  User as UserIcon,
  Server,
  FileText,
  AlertTriangle,
  Clock,
  ShieldAlert,
  KeyRound,
  Trash2,
  Eye,
} from 'lucide-react';

interface TimelineViewProps {
  events: TimelineEvent[];
  className?: string;
}

const EVENT_CONFIG: Partial<
  Record<
    TimelineEventType,
    { label: string; icon: React.ComponentType<{ className?: string }>; color: string }
  >
> = {
  [TimelineEventType.REQUEST_CREATED]: {
    label: '요청 생성됨',
    icon: FileText,
    color: 'bg-slate-100 text-slate-700 border-slate-300',
  },
  [TimelineEventType.REQUEST_DELEGATED]: {
    label: '다른 팀에 도움 요청',
    icon: Send,
    color: 'bg-indigo-100 text-indigo-700 border-indigo-300',
  },
  [TimelineEventType.REQUEST_CHILD_COMPLETED]: {
    label: '도움 요청 완료',
    icon: CheckCircle2,
    color: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  },
  [TimelineEventType.REQUEST_SENT]: {
    label: 'Baton 요청 전송',
    icon: Send,
    color: 'bg-sky-100 text-sky-700 border-sky-300',
  },
  [TimelineEventType.REQUEST_DELIVERED]: {
    label: '수신자 컴퓨터에 알림 도착',
    icon: Server,
    color: 'bg-cyan-100 text-cyan-700 border-cyan-300',
  },
  [TimelineEventType.REQUEST_REVIEW_STARTED]: {
    label: '수신자가 요청 검토 시작',
    icon: Clock,
    color: 'bg-amber-100 text-amber-700 border-amber-300',
  },
  [TimelineEventType.REQUEST_ACCEPTED]: {
    label: '요청 수락됨',
    icon: Check,
    color: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  },
  [TimelineEventType.REQUEST_RETURNED]: {
    label: '요청 반려됨',
    icon: RotateCcw,
    color: 'bg-purple-100 text-purple-700 border-purple-300',
  },
  [TimelineEventType.REQUEST_REJECTED]: {
    label: '요청 거절됨',
    icon: XCircle,
    color: 'bg-rose-100 text-rose-700 border-rose-300',
  },
  [TimelineEventType.REQUEST_REVISION_CREATED]: {
    label: '새 Revision 생성',
    icon: FileText,
    color: 'bg-indigo-100 text-indigo-700 border-indigo-300',
  },
  [TimelineEventType.REQUEST_FOLLOWUP_SENT]: {
    label: '이어서 요청 전송',
    icon: Send,
    color: 'bg-blue-100 text-blue-700 border-blue-300',
  },

  [TimelineEventType.REQUEST_WITHDRAWN]: { label: '요청 철회', icon: Send, color: 'bg-slate-100 text-slate-700 border-slate-300' },
  [TimelineEventType.REQUEST_RESENT]: {
    label: '보완 내용으로 재전송',
    icon: Send,
    color: 'bg-blue-100 text-blue-700 border-blue-300',
  },
  [TimelineEventType.REQUEST_VIEWED]: {
    label: '수신자가 요청 열람',
    icon: Clock,
    color: 'bg-cyan-50 text-cyan-700 border-cyan-200',
  },
  [TimelineEventType.DOCUMENT_CREATED]: {
    label: '요청 문서 첨부',
    icon: FileText,
    color: 'bg-slate-100 text-slate-700 border-slate-300',
  },
  [TimelineEventType.DOCUMENT_VERSION_CREATED]: {
    label: '문서 버전 생성',
    icon: FileText,
    color: 'bg-slate-50 text-slate-600 border-slate-200',
  },
  // 추가 작업 요청(§18)은 RESULT_REVIEW → READY_TO_RUN 을 거치므로 이 라벨이 매 회차 등장한다.
  [TimelineEventType.REQUEST_READY_TO_RUN]: {
    label: '실행 준비 완료 (READY_TO_RUN)',
    icon: Play,
    color: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  },
  [TimelineEventType.RESULT_REVIEW_STARTED]: {
    label: '결과 검토 시작',
    icon: FileCheck,
    color: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  [TimelineEventType.EXECUTION_APPROVAL_REQUESTED]: {
    label: '실행 중 도구 승인 요청',
    icon: ShieldAlert,
    color: 'bg-amber-100 text-amber-800 border-amber-300',
  },
  [TimelineEventType.EXECUTION_APPROVAL_DECIDED]: {
    label: '실행 중 도구 승인 결정',
    icon: ShieldAlert,
    color: 'bg-slate-100 text-slate-700 border-slate-300',
  },
  [TimelineEventType.EXECUTION_CANCELLED]: {
    label: '에이전트 실행 취소됨',
    icon: XCircle,
    color: 'bg-slate-100 text-slate-700 border-slate-300',
  },
  [TimelineEventType.EXECUTION_CANCEL_REQUESTED]: {
    label: '데몬에 실행 취소 명령 발행 (SIGTERM→SIGKILL)',
    icon: XCircle,
    color: 'bg-slate-100 text-slate-700 border-slate-300',
  },
  [TimelineEventType.EXECUTION_FOLLOW_UP_REQUESTED]: {
    label: '에이전트에게 추가 작업 요청 (Follow-up)',
    icon: RotateCcw,
    color: 'bg-amber-100 text-amber-800 border-amber-300',
  },
  [TimelineEventType.EXECUTION_RISK_ACKNOWLEDGED]: {
    label: '보안 위험 승인 및 실행 허용',
    icon: ShieldAlert,
    color: 'bg-rose-100 text-rose-800 border-rose-300',
  },
  [TimelineEventType.EXECUTION_QUEUED]: {
    label: '에이전트 실행 대기열 등록',
    icon: Play,
    color: 'bg-indigo-100 text-indigo-700 border-indigo-300',
  },
  [TimelineEventType.EXECUTION_COMMAND_REQUESTED]: {
    label: '데몬에 실행 명령 발행 (F4 Policy 주입)',
    icon: Server,
    color: 'bg-purple-100 text-purple-700 border-purple-300',
  },
  [TimelineEventType.EXECUTION_STARTED]: {
    label: 'AI 에이전트 실행 시작',
    icon: Bot,
    color: 'bg-blue-100 text-blue-700 border-blue-300',
  },
  [TimelineEventType.EXECUTION_PROGRESS_REPORTED]: {
    label: '진행 상태 갱신',
    icon: Bot,
    color: 'bg-blue-50 text-blue-600 border-blue-200',
  },
  [TimelineEventType.EXECUTION_FINISHED]: {
    label: '에이전트 프로세스 종료',
    icon: FileCheck,
    color: 'bg-teal-100 text-teal-700 border-teal-300',
  },
  [TimelineEventType.EXECUTION_FAILED]: {
    label: '에이전트 실행 실패',
    icon: AlertTriangle,
    color: 'bg-red-100 text-red-700 border-red-300',
  },
  [TimelineEventType.RESULT_CREATED]: {
    label: '작업 결과 3계층 수집 완료',
    icon: FileCheck,
    color: 'bg-amber-100 text-amber-700 border-amber-300',
  },
  [TimelineEventType.RESULT_PARTIAL_REPORTED]: {
    label: '취소된 회차의 부분 결과 도착 (승인 대상 아님)',
    icon: XCircle,
    color: 'bg-slate-100 text-slate-700 border-slate-300',
  },
  [TimelineEventType.RESULT_APPROVED]: {
    label: '수신자가 결과 승인',
    icon: CheckCircle2,
    color: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  },
  // CLO-141 결과 검토의 출구들. 라벨이 없으면 eventType 원문이 그대로 화면에 찍힌다.
  [TimelineEventType.RESULT_DISCARDED]: {
    label: '수신자가 결과 폐기 (다시 실행)',
    icon: Trash2,
    color: 'bg-amber-100 text-amber-800 border-amber-300',
  },
  [TimelineEventType.RESULT_DISCLOSED_TO_SENDER]: {
    label: '수신자가 결과 문서를 요청자에게 공개',
    icon: Eye,
    color: 'bg-sky-100 text-sky-700 border-sky-300',
  },
  [TimelineEventType.RESULT_SENT]: {
    label: '요청자에게 결과 전달',
    icon: Send,
    color: 'bg-teal-100 text-teal-700 border-teal-300',
  },
  [TimelineEventType.REQUEST_COMPLETED]: {
    label: '업무 인계 최종 완료',
    icon: CheckCircle2,
    color: 'bg-emerald-100 text-emerald-700 border-emerald-400 font-bold',
  },
};

export function TimelineView({ events, className }: TimelineViewProps) {
  if (!events || events.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-slate-500 text-sm">
        타임라인 기록이 아직 없습니다.
      </div>
    );
  }

  return (
    <div className={cn('flow-root', className)}>
      <ul role="list" className="-mb-8">
        {events.map((event, idx) => {
          const isLast = idx === events.length - 1;
          const config = EVENT_CONFIG[event.eventType] || {
            label: event.eventType,
            icon: Clock,
            color: 'bg-slate-100 text-slate-700 border-slate-300',
          };
          const Icon = config.icon;

          return (
            <li key={event.id}>
              <div className="relative pb-8">
                {!isLast && (
                  <span
                    className="absolute left-4 top-4 -ml-px h-full w-0.5 bg-slate-200"
                    aria-hidden="true"
                  />
                )}
                <div className="relative flex items-start space-x-3">
                  {/* 이벤트 아이콘 */}
                  <div className="relative">
                    <div
                      className={cn(
                        'flex h-8 w-8 items-center justify-center rounded-full border shadow-xs',
                        config.color,
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </div>
                  </div>

                  {/* 이벤트 상세 내용 */}
                  <div className="min-w-0 flex-1 pt-0.5">
                    <div className="flex flex-wrap items-center justify-between gap-1">
                      <p className="text-sm font-semibold text-slate-900">{event.eventType === TimelineEventType.EXECUTION_STARTED ? `${agentLabel(event.agentProvider)} 실행 시작` : config.label}</p>
                      <time className="text-xs text-slate-400">
                        {new Date(event.occurredAt).toLocaleTimeString('ko-KR', {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </time>
                    </div>

                    {/* 주체 뱃지 */}
                    <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                      <span className="flex items-center gap-1">
                        {event.actorType === 'HUMAN' && (
                          <UserIcon className="w-3 h-3 text-slate-400" />
                        )}
                        {event.actorType === 'DESKTOP_AGENT' && (
                          <Bot className="w-3 h-3 text-blue-500" />
                        )}
                        {event.actorType === 'SERVER' && (
                          <Server className="w-3 h-3 text-emerald-500" />
                        )}
                        <span>
                          {event.actorType === 'DESKTOP_AGENT' ? agentLabel(event.agentProvider) : event.actorType === 'HUMAN' ? '사용자' : 'Baton 서버'}
                        </span>
                      </span>

                      {/* 페이로드 추가 정보 (사유, 단계, 파일 등) */}
                      {event.eventType === TimelineEventType.EXECUTION_APPROVAL_DECIDED && (
                        <div className="text-xs">
                          {String(event.payload?.toolName ?? '')} ·{' '}
                          {(
                            { ALLOWED: '허용됨', DENIED: '거부됨', EXPIRED: '만료됨' } as Record<
                              string,
                              string
                            >
                          )[String(event.payload?.status)] ?? '결정됨'}
                        </div>
                      )}
                      {Boolean(event.payload?.reason) && (
                        <span className="rounded bg-rose-50 border border-rose-200 text-rose-700 px-1.5 py-0.5 text-[11px] font-medium">
                          사유: {String(event.payload?.reason)}
                        </span>
                      )}
                      {Boolean(event.payload?.phase) && (
                        <span className="rounded bg-blue-50 border border-blue-200 text-blue-700 px-1.5 py-0.5 text-[11px] font-mono">
                          {String(event.payload?.phase)}: {String(event.payload?.message || '')}
                        </span>
                      )}
                      {Boolean(event.payload?.revisionNo) && (
                        <span className="rounded bg-indigo-50 border border-indigo-200 text-indigo-700 px-1.5 py-0.5 text-[11px]">
                          Revision {String(event.payload?.revisionNo)}
                        </span>
                      )}
                      {Boolean(event.payload?.followUpInstruction) && (
                        <span className="rounded bg-amber-50 border border-amber-200 text-amber-800 px-1.5 py-0.5 text-[11px] font-medium max-w-xs truncate">
                          추가 지시: {String(event.payload?.followUpInstruction)}
                        </span>
                      )}

                      {/* CLO-108: 위험 승인 이벤트 상세 */}
                      {event.eventType === TimelineEventType.EXECUTION_RISK_ACKNOWLEDGED && (
                        <div className="mt-1.5 flex flex-col gap-1.5 w-full">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {Boolean(event.payload?.agentProvider) && (
                              <span className="rounded bg-slate-100 border border-slate-300 text-slate-700 px-1.5 py-0.5 text-[10px] font-semibold">
                                Provider: {String(event.payload?.agentProvider)}
                              </span>
                            )}
                            {Boolean(event.payload?.securityTier) && (
                              <span className="rounded bg-blue-50 border border-blue-200 text-blue-800 px-1.5 py-0.5 text-[10px] font-semibold">
                                {String(event.payload?.securityTier)}
                              </span>
                            )}
                          </div>
                          {Array.isArray(event.payload?.protections) && (
                            <div className="flex flex-wrap gap-1">
                              {(event.payload.protections as any[]).map((p: any) => {
                                const isCrit = p.severity === 'critical';
                                return (
                                  <span
                                    key={p.key}
                                    className={cn(
                                      'inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium border',
                                      isCrit
                                        ? 'bg-red-50 text-red-800 border-red-200'
                                        : 'bg-amber-50 text-amber-800 border-amber-200',
                                    )}
                                  >
                                    {isCrit && <KeyRound className="w-3 h-3 text-red-600" />}
                                    <span>{p.title}</span>
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
