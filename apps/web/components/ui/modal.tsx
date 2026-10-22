'use client';

import React from 'react';
import { AlertTriangle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: React.ReactNode;
  warningText?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'primary';
  isLoading?: boolean;
}

/**
 * 확인 모달 컴포넌트 (window.confirm 대체)
 * 실행 취소, 연결 해제, 삭제 등 사용자 확인이 필요한 작업에 사용합니다.
 */
export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  warningText,
  confirmLabel = '확인',
  cancelLabel = '취소',
  variant = 'danger',
  isLoading = false,
}: ConfirmModalProps) {
  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4 animate-in fade-in duration-150"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl border border-slate-200 animate-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            {variant === 'danger' && (
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-100 text-red-600">
                <AlertTriangle className="h-5 w-5" />
              </div>
            )}
            {variant === 'warning' && (
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-100 text-amber-600">
                <AlertTriangle className="h-5 w-5" />
              </div>
            )}
            {variant === 'primary' && (
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600">
                <Info className="h-5 w-5" />
              </div>
            )}
            <h3 className="text-base font-bold text-slate-900">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 rounded-lg p-1 transition"
            title="닫기"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="text-xs text-slate-600 leading-relaxed mb-4">
          {typeof description === 'string' ? <p>{description}</p> : description}
          {warningText && (
            <p className="mt-2.5 text-xs text-red-600 bg-red-50 p-2.5 rounded-lg border border-red-100 font-medium">
              {warningText}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isLoading}
            className={cn(
              'rounded-lg px-4 py-2 text-xs font-semibold text-white shadow-xs transition disabled:opacity-50',
              variant === 'danger' && 'bg-red-600 hover:bg-red-700',
              variant === 'warning' && 'bg-amber-600 hover:bg-amber-700',
              variant === 'primary' && 'bg-indigo-600 hover:bg-indigo-700',
            )}
          >
            {isLoading ? '처리 중...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface AlertModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  message: string;
  buttonLabel?: string;
}

/**
 * 단순 알림 모달 컴포넌트 (window.alert 대체)
 * 렌더러를 멈추지 않고 사용자에게 상태나 제약사항을 안내합니다.
 */
export function AlertModal({
  isOpen,
  onClose,
  title,
  message,
  buttonLabel = '확인',
}: AlertModalProps) {
  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4 animate-in fade-in duration-150"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl border border-slate-200 animate-in zoom-in-95 duration-150">
        <div className="flex items-center gap-2.5 text-indigo-700 font-bold text-base mb-3">
          <Info className="w-5 h-5 text-indigo-600" />
          <span>{title}</span>
        </div>
        <p className="text-xs text-slate-600 mb-5 leading-relaxed">{message}</p>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 transition shadow-xs"
          >
            {buttonLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
