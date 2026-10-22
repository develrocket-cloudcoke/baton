'use client';

import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { truncateApprovalDetail } from '@baton/shared';
import { apiClient } from '@/lib/api-client';
import { ExecutionApproval } from '@/lib/types';

const STATUS_LABEL = {
  PENDING: '승인 대기',
  ALLOWED: '허용됨',
  DENIED: '거부됨',
  EXPIRED: '만료됨',
};

export function ApprovalCard({
  approval,
  now,
  busy,
  onDecision,
}: {
  approval: ExecutionApproval;
  now: number;
  busy: boolean;
  onDecision: (decision: 'ALLOWED' | 'DENIED') => void;
}) {
  const remaining = Math.max(0, Math.ceil((Date.parse(approval.expiresAt) - now) / 1000));
  const pending = approval.status === 'PENDING' && remaining > 0;
  const status = approval.status === 'PENDING' && !pending ? 'EXPIRED' : approval.status;
  return (
    <section
      className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-4"
      aria-label="실행 중 도구 승인"
    >
      <div className="flex flex-wrap justify-between gap-2 text-sm font-semibold">
        <h4>
          {approval.toolName} · {STATUS_LABEL[status]}
        </h4>
        {pending && <span>남은 시간 {remaining}초</span>}
      </div>
      {pending ? (
        <>
          <p className="mt-2 text-xs text-amber-900">
            에이전트가 요청한 명령·경로입니다. 내용은 신뢰할 수 없으니 확인 후 이 호출 한 번만
            허용하세요.
          </p>
          <pre className="my-3 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-white p-3 text-xs font-mono">
            {truncateApprovalDetail(approval.detail)}
          </pre>
          <p className="text-xs whitespace-pre-wrap break-all">
            정책 사유: {approval.reason.slice(0, 500)}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => onDecision('ALLOWED')}
              className="rounded bg-blue-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              이 호출 허용
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onDecision('DENIED')}
              className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50"
            >
              거부
            </button>
          </div>
        </>
      ) : (
        <p className="mt-2 text-xs">
          {status === 'EXPIRED'
            ? '마감되었거나 실행이 종료되어 허용할 수 없습니다.'
            : '결정이 기록되었습니다.'}
        </p>
      )}
    </section>
  );
}

export function ExecutionApprovals({ executionId }: { executionId: string }) {
  const queryClient = useQueryClient();
  const [now, setNow] = useState(Date.now);
  const [notice, setNotice] = useState<string | null>(null);
  const queryKey = ['execution-approvals', executionId];
  const approvals = useQuery({
    queryKey,
    queryFn: () => apiClient.getExecutionApprovals(executionId),
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const deadlines = (approvals.data ?? [])
      .filter((a) => a.status === 'PENDING')
      .map((a) => Date.parse(a.expiresAt))
      .filter(Number.isFinite);
    if (!deadlines.length) return;
    const timer = setTimeout(
      () => {
        void approvals.refetch();
      },
      Math.max(0, Math.min(...deadlines) - Date.now()) + 50,
    );
    return () => clearTimeout(timer);
  }, [approvals.data, approvals.refetch]);
  const decision = useMutation({
    mutationFn: ({ id, value }: { id: string; value: 'ALLOWED' | 'DENIED' }) =>
      apiClient.decideExecutionApproval(id, value),
    onSuccess: (result, variables) => {
      queryClient.setQueryData<ExecutionApproval[]>(queryKey, (rows) =>
        rows?.map((row) => (row.id === variables.id ? { ...row, status: result.status } : row)),
      );
      setNotice(null);
    },
    onError: (error: Error) => setNotice(`결정을 저장하지 못했습니다: ${error.message}`),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: ['request'] });
    },
  });
  return (
    <div>
      {approvals.isPending && <p className="mb-3 text-xs text-slate-500">승인 요청 확인 중...</p>}
      {approvals.isError && (
        <p role="alert" className="mb-3 text-sm text-red-700">
          승인 요청을 불러오지 못했습니다.{' '}
          <button type="button" className="underline" onClick={() => approvals.refetch()}>
            다시 시도
          </button>
        </p>
      )}
      {notice && (
        <p role="alert" className="mb-3 text-sm text-red-700">
          {notice}
        </p>
      )}
      {approvals.data?.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          now={now}
          busy={decision.isPending || approvals.isError}
          onDecision={(value) => decision.mutate({ id: approval.id, value })}
        />
      ))}
    </div>
  );
}
