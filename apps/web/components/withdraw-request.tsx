'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { canTransition, RequestState, TransitionActor } from '@baton/shared';
import { apiClient } from '@/lib/api-client';
import { RequestEntity } from '@/lib/types';
import { ConfirmModal } from './ui/modal';

export function WithdrawRequest({ request, userId, hasExecutions, onSuccess }: {
  request: RequestEntity; userId: string; hasExecutions: boolean; onSuccess: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => apiClient.withdrawRequest(request.id, reason.trim() || undefined),
    onSuccess: () => {
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ['requests'] });
      onSuccess();
    },
  });
  if (request.senderUserId !== userId || request.acceptedAt || hasExecutions ||
    !canTransition(request.state, RequestState.WITHDRAWN, TransitionActor.SENDER)) return null;
  return <div className="mb-6">
    <button className="rounded-lg border border-red-300 px-4 py-2 text-sm text-red-700"
      onClick={() => { mutation.reset(); setOpen(true); }}>요청 철회</button>
    <ConfirmModal isOpen={open} onClose={() => { if (!mutation.isPending) setOpen(false); }}
      onConfirm={() => mutation.mutate()} title="요청을 철회할까요?" confirmLabel="요청 철회"
      isLoading={mutation.isPending} description={<div className="space-y-3">
        <p>철회한 요청은 다시 실행할 수 없습니다. 기록은 남고 받는 사람에게 알립니다.</p>
        <label className="block">사유 (선택, 최대 500자)
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500}
            className="mt-1 w-full rounded border p-2" rows={3} />
        </label>
        {mutation.error && <p role="alert" className="text-red-700">{mutation.error.message}</p>}
      </div>} />
  </div>;
}
