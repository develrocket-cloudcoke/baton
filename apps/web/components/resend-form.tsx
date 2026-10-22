'use client';

import React, { useState, useEffect } from 'react';
import { AttachmentPicker, PickedAttachment } from '@/components/attachment-picker';
import { MarkdownEditor } from '@/components/markdown-editor';
import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import { RequestEntity, RequestRevision } from '@/lib/types';
import {
  RotateCcw,
  AlertTriangle,
  Send,
  FileText,
  Paperclip,
  Users,
  User,
  Sparkles,
  HelpCircle
} from 'lucide-react';

interface ResendFormProps {
  followup?: boolean;
  request: RequestEntity;
  currentRevision: RequestRevision;
  senderUserId: string;
  onSuccess: () => void;
}

export function ResendForm({
  followup = false,
  request,
  currentRevision,
  senderUserId,
  onSuccess
}: ResendFormProps) {
  const nextRevisionNo = (request.currentRevisionNo || 1) + 1;

  // 팀 뿌리기 요청이었는지 여부 (CLO-19: 팀 뿌리기였던 요청에서만 재뿌리기 선택지 노출)
  const isOriginallyBroadcast = Boolean(
    request.isBroadcast || request.claimedAt || request.recipientUserId === null
  );

  const [reassignOption, setReassignOption] = useState<'same' | 'team'>('same');

  // URL 파라미터로 선택지 강제 및 초기 선택 지원 (?reassign=team 또는 ?showReassign=true)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const p = new URLSearchParams(window.location.search);
      if (p.get('reassign') === 'team') {
        setReassignOption('team');
      }
    }
  }, []);

  const [instruction, setInstruction] = useState<string>(
    followup ? '' : currentRevision.originalInstruction || ''
  );
  // 데모 기본값을 채워 두지 않는다. 지우지 않으면 보완본 문서로 그대로 전송된다
  // (2026-09-18: 새 요청 화면에서 같은 문제로 엉뚱한 Kubernetes 문서가 딸려 갔다).
  const [documentContent, setDocumentContent] = useState<string>('');
  const [attachments, setAttachments] = useState<PickedAttachment[]>([]);
  // 문서 파일명도 사람이 정한다. 예전에는 'api-error-analysis.v2.md' 를 코드가
  // 지어내서 무슨 요청이든 같은 이름으로 저장됐다 (2026-09-21 전수조사 결함 6).
  const [documentTitle, setDocumentTitle] = useState<string>('');

  const resendMutation = useMutation({
    mutationFn: () =>
      apiClient.resendRequest(request.id, senderUserId, {
        followup,
        originalInstruction: instruction,
        documentTitle: documentTitle.trim(),
        documentContent,
        reassign: isOriginallyBroadcast ? reassignOption : 'same',
        attachments
      }),
    onSuccess: () => {
      onSuccess();
    }
  });

  return (
    <div className="rounded-xl border border-purple-300 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between border-b border-purple-100 pb-3 mb-4">
        <div className="flex items-center gap-2">
          <RotateCcw className="w-5 h-5 text-purple-600" />
          <h3 className="font-bold text-base text-slate-900">
            {followup ? `이어서 요청(${nextRevisionNo}차)` : `반려 사유 보완 및 새 Revision(${nextRevisionNo}) 재전송`}
          </h3>
        </div>
        {!followup && isOriginallyBroadcast && (
          <span className="inline-flex items-center gap-1 rounded-full bg-purple-100 px-2.5 py-0.5 text-xs font-semibold text-purple-800">
            <Sparkles className="w-3 h-3 text-purple-600" />
            팀 전체에 다시 보낼 수 있음
          </span>
        )}
      </div>

      {/* 수신자의 반려 사유 경고 박스 */}
      {!followup && <div className="mb-5 rounded-lg border border-purple-200 bg-purple-50 p-4">
        <div className="flex items-center gap-2 text-xs font-bold text-purple-900 mb-1">
          <AlertTriangle className="w-4 h-4 text-purple-600" />
          <span>수신자(B)의 반려 사유</span>
        </div>
        <p className="text-sm font-semibold text-purple-800">
          &quot;{request.returnReason || '추가 로그 파일 첨부 및 원인 분석 내용 보완이 필요합니다.'}&quot;
        </p>
      </div>}

      {/* CLO-19: 담당자 재배정 옵션 (팀 뿌리기였던 요청에서만 노출) */}
      {!followup && isOriginallyBroadcast && (
        <div className="mb-5 rounded-xl border border-indigo-200 bg-indigo-50/50 p-4">
          <label className="block text-xs font-bold text-slate-800 mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Users className="w-4 h-4 text-indigo-600" />
              재전송 대상 배정 방식 선택
            </span>
            <span className="text-[11px] font-normal text-indigo-700">
              * 팀 전체 요청이었으므로 재배정 대상을 선택할 수 있습니다.
            </span>
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* 1. 같은 담당자에게 (same) */}
            <label
              onClick={() => setReassignOption('same')}
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition ${
                reassignOption === 'same'
                  ? 'border-indigo-500 bg-white shadow-sm ring-1 ring-indigo-500'
                  : 'border-slate-200 bg-white/70 hover:bg-white'
              }`}
            >
              <input
                type="radio"
                name="reassign"
                value="same"
                checked={reassignOption === 'same'}
                onChange={() => setReassignOption('same')}
                className="mt-0.5 h-4 w-4 text-indigo-600 focus:ring-indigo-500"
              />
              <div className="flex-1">
                <div className="flex items-center gap-1.5">
                  <User className="w-3.5 h-3.5 text-slate-600" />
                  <span className="text-xs font-bold text-slate-900">
                    기존 담당자에게 다시 보내기
                  </span>
                </div>
                <p className="text-[11px] text-slate-600 mt-1 leading-relaxed">
                  반려 의견을 전달했던 담당자({request.claimedBy?.displayName || '기존 담당자'})에게 보완 내용을 바로 다시 전달합니다.
                </p>
              </div>
            </label>

            {/* 2. 팀 전체에 다시 (team) */}
            <label
              onClick={() => setReassignOption('team')}
              data-testid="reassign-team-option"
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition ${
                reassignOption === 'team'
                  ? 'border-indigo-600 bg-white shadow-sm ring-2 ring-indigo-500'
                  : 'border-slate-200 bg-white/70 hover:bg-white'
              }`}
            >
              <input
                type="radio"
                name="reassign"
                value="team"
                checked={reassignOption === 'team'}
                onChange={() => setReassignOption('team')}
                className="mt-0.5 h-4 w-4 text-indigo-600 focus:ring-indigo-500"
              />
              <div className="flex-1">
                <div className="flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5 text-indigo-600" />
                  <span className="text-xs font-bold text-indigo-950">
                    팀 전체에 다시 뿌리기 (미확정)
                  </span>
                  <span className="rounded bg-amber-100 px-1.5 py-0.2 text-[10px] font-bold text-amber-800">
                    재뿌리기
                  </span>
                </div>
                <p className="text-[11px] text-slate-600 mt-1 leading-relaxed">
                  담당자 지정을 해제하고 수신 팀 전체에 <span className="font-semibold text-amber-700">미확정</span> 상태로 다시 공개하여 수신 팀 누구나 선점(Claim)할 수 있게 합니다.
                </p>
              </div>
            </label>
          </div>
        </div>
      )}

      {/* 요청 지시사항 보완 */}
      <div className="mb-4">
        <MarkdownEditor
          label={followup ? "추가 요청 지시사항" : "보완된 요청 지시사항"}
          value={instruction}
          onChange={setInstruction}
          rows={6}
          testId="resend-instruction"
        />
      </div>

      {/* Markdown 문서 v2 작성 */}
      <div className="mb-4">
        <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1.5">
          <FileText className="w-4 h-4 text-purple-600" />
          <span>보완 문서 (새 버전 v{nextRevisionNo})</span>
        </label>
        <input
          type="text"
          value={documentTitle}
          onChange={(e) => setDocumentTitle(e.target.value)}
          placeholder="문서 파일명 (예: api-error-analysis.md)"
          className="mb-2 w-full rounded-lg border border-slate-300 p-2 text-xs font-mono focus:border-purple-500 focus:outline-none"
        />
        <MarkdownEditor value={documentContent} onChange={setDocumentContent} rows={6} />
        {documentContent.trim() && !documentTitle.trim() && (
          <p className="mt-1.5 text-xs font-semibold text-rose-700">
            문서 파일명을 적어 주세요. 이름 없이 보내면 코드가 지어낸 이름으로 저장됩니다.
          </p>
        )}
      </div>

      {/* 추가 첨부파일 */}
      <div className="mb-6">
        <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1.5">
          <Paperclip className="w-4 h-4 text-purple-600" />
          <span>추가 첨부 파일</span>
        </label>
        <AttachmentPicker attachments={attachments} onChange={setAttachments} />
      </div>

      {followup && <p className="mb-4 text-sm text-slate-600">원래 받는 사람 또는 팀에 보내며, 다시 수락해야 실행됩니다. 실행 권한도 다시 확인합니다.</p>}
      {resendMutation.error && <p role="alert" className="mb-4 text-sm text-red-700">{resendMutation.error.message}</p>}
      {/* 재전송 버튼 */}
      <div className="flex items-center justify-end gap-3">
        <button
          onClick={() => resendMutation.mutate()}
          disabled={resendMutation.isPending || !instruction.trim() || (!!documentContent.trim() && !documentTitle.trim())}
          data-testid="resend-submit-btn"
          className="flex items-center gap-2 rounded-lg bg-purple-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-purple-700 transition disabled:opacity-50"
        >
          <Send className="w-4 h-4" />
          <span>
            {resendMutation.isPending
              ? '재전송 중...'
              : followup ? `이어서 요청 보내기 (${nextRevisionNo}차)`
              : isOriginallyBroadcast && reassignOption === 'team'
                ? `Revision ${nextRevisionNo}로 팀 전체에 다시 뿌리기`
                : `Revision ${nextRevisionNo}로 보완하여 재전송`}
          </span>
        </button>
      </div>
    </div>
  );
}
