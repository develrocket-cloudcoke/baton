'use client';

import React, { useState, useEffect } from 'react';
import {
  AlertTriangle,
  ShieldAlert,
  X,
  KeyRound,
  Shield,
  FileWarning,
  CheckCircle2,
} from 'lucide-react';
import { UnenforceableProtection, UnenforceableProtectionKey } from '@/lib/types';
import { cn } from '@/lib/utils';

export interface RiskAcknowledgementModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (acknowledgedKeys: UnenforceableProtectionKey[]) => void;
  protections: UnenforceableProtection[];
  agentName?: string;
  provider?: string;
  securityTier?: string;
  isLoading?: boolean;
}

/**
 * CLO-108: 강제 불가 보호 조치 항목별 승인 모달
 *
 * "강제할 수 없는 보호가 있어도 사람이 무엇을 강제할 수 없는지 정확히 알고 승인하면 실행한다."
 * - 뭉뚱그린 체크 금지: 각 항목의 설명/위험을 고지하고 개별 체크박스 제공
 * - 사전 체크 금지: 모든 항목의 초기 체크 상태는 false
 * - 모든 항목 체크 시에만 실행 버튼 활성화
 * - 자격증명 파일 읽기(credential_path_read)는 critical 심각도로 시각적 특별 강조
 */
export function RiskAcknowledgementModal({
  isOpen,
  onClose,
  onConfirm,
  protections,
  agentName,
  provider,
  securityTier,
  isLoading = false,
}: RiskAcknowledgementModalProps) {
  // 개별 항목 체크 상태 (초기값 전부 false, 사전 체크 금지)
  const [checkedKeys, setCheckedKeys] = useState<Record<string, boolean>>({});

  // 모달이 열릴 때마다 체크박스 상태 초기화
  useEffect(() => {
    if (isOpen) {
      setCheckedKeys({});
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const totalCount = protections.length;
  const checkedCount = protections.filter((p) => checkedKeys[p.key]).length;
  const allChecked = totalCount > 0 && checkedCount === totalCount;

  const handleToggle = (key: UnenforceableProtectionKey) => {
    setCheckedKeys((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleConfirm = () => {
    if (!allChecked || isLoading) return;
    const acknowledgedKeys = protections.map((p) => p.key);
    onConfirm(acknowledgedKeys);
  };

  const formatSecurityTier = (tier?: string) => {
    switch (tier) {
      case 'tier_a_hardened':
        return { label: 'Tier A (Hardened)', bg: 'bg-emerald-100 text-emerald-800' };
      case 'tier_b_sandboxed':
        return { label: 'Tier B (Sandboxed)', bg: 'bg-blue-100 text-blue-800' };
      case 'tier_c_unrestricted':
        return { label: 'Tier C (Unrestricted)', bg: 'bg-amber-100 text-amber-800' };
      default:
        return { label: tier || 'Unknown', bg: 'bg-slate-100 text-slate-700' };
    }
  };

  const tierBadge = formatSecurityTier(securityTier);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto animate-in fade-in duration-150"
    >
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl bg-white shadow-2xl border border-slate-200 animate-in zoom-in-95 duration-150 my-auto">
        {/* 모달 헤더 */}
        <div className="flex items-start justify-between border-b border-slate-200 p-5 bg-amber-50/50 rounded-t-2xl">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-600 border border-amber-200">
              <ShieldAlert className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base font-bold text-slate-900">
                  실행 보안 위험 확인 및 승인
                </h3>
                {provider && (
                  <span className="rounded-md bg-slate-200/80 px-2 py-0.5 text-xs font-semibold text-slate-700">
                    {provider}
                  </span>
                )}
                <span
                  className={cn(
                    'rounded-md px-2 py-0.5 text-xs font-semibold',
                    tierBadge.bg,
                  )}
                >
                  {tierBadge.label}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-600 leading-relaxed">
                선택한 정책의 외부 작업 위험 또는 Agent가 강제할 수 없는 보호가 있습니다.
                각 항목의 위험을 확인하고 개별적으로 승인해야 실행이 진행됩니다.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 rounded-lg p-1.5 transition ml-2 shrink-0"
            title="닫기"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 모달 본문: 스크롤 가능한 위험 항목 리스트 */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-slate-700 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileWarning className="w-4 h-4 text-amber-600" />
              <span className="font-semibold text-slate-800">
                승인 대상 항목 ({checkedCount} / {totalCount} 확인됨)
              </span>
            </div>
            <span className="text-[11px] text-slate-500">
              사전 체크가 금지되어 있으며 모든 항목을 개별 확인해야 합니다.
            </span>
          </div>

          <div className="space-y-3">
            {protections.map((item) => {
              const isCritical = item.severity === 'critical';
              const isChecked = Boolean(checkedKeys[item.key]);

              return (
                <div
                  key={item.key}
                  data-testid={`risk-item-${item.key}`}
                  className={cn(
                    'rounded-xl border p-4 transition-all',
                    isCritical
                      ? 'border-red-200 bg-red-50/40 hover:border-red-300'
                      : 'border-amber-200 bg-amber-50/30 hover:border-amber-300',
                    isChecked && (isCritical ? 'ring-2 ring-red-500/30 bg-red-50/70' : 'ring-2 ring-amber-500/30 bg-amber-50/60'),
                  )}
                >
                  <div className="flex items-start gap-3">
                    <div className="pt-0.5">
                      <input
                        type="checkbox"
                        id={`risk-check-${item.key}`}
                        data-testid={`risk-checkbox-${item.key}`}
                        checked={isChecked}
                        onChange={() => handleToggle(item.key)}
                        className={cn(
                          'h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer',
                          isCritical && 'text-red-600 focus:ring-red-500 accent-red-600',
                        )}
                      />
                    </div>

                    <div className="flex-1 space-y-2">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <label
                          htmlFor={`risk-check-${item.key}`}
                          className="font-bold text-slate-900 cursor-pointer text-sm flex items-center gap-1.5"
                        >
                          {isCritical && (
                            <KeyRound className="w-4 h-4 text-red-600 inline-block shrink-0" />
                          )}
                          <span>{item.title}</span>
                        </label>
                        <span
                          className={cn(
                            'rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                            isCritical
                              ? 'bg-red-600 text-white shadow-xs'
                              : 'bg-amber-100 text-amber-800 border border-amber-200',
                          )}
                        >
                          {isCritical ? 'Critical (치명적 위험)' : 'High (높은 위험)'}
                        </span>
                      </div>

                      {/* 자격증명 노출 특별 강조 박스 */}
                      {isCritical && (
                        <div className="rounded-lg border border-red-300 bg-red-100/70 p-2.5 text-red-900 font-medium text-[11px] leading-relaxed flex items-start gap-2">
                          <AlertTriangle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
                          <div>
                            <span className="font-bold">자격증명 탈취 주의:</span> 에이전트가{' '}
                            <code className="bg-red-200/80 px-1 py-0.5 rounded font-mono text-[10px]">~/.aws</code>,{' '}
                            <code className="bg-red-200/80 px-1 py-0.5 rounded font-mono text-[10px]">~/.ssh</code>,{' '}
                            <code className="bg-red-200/80 px-1 py-0.5 rounded font-mono text-[10px]">~/.kube</code>,{' '}
                            <code className="bg-red-200/80 px-1 py-0.5 rounded font-mono text-[10px]">.env</code> 등
                            호스트의 민감한 자격증명을 무제한 읽을 수 있으며, 프롬프트 인젝션 공격 시 외부로 전달될 수 있습니다.
                          </div>
                        </div>
                      )}

                      {/* 원인 설명 */}
                      <div className="text-slate-700 leading-relaxed text-[11px]">
                        <span className="font-semibold text-slate-800">보호 미지원 원인: </span>
                        {item.description}
                      </div>

                      {/* 수반되는 위험 */}
                      <div className="rounded-md bg-white/80 p-2.5 border border-slate-200 text-slate-800 text-[11px] leading-relaxed">
                        <span className="font-semibold text-rose-700">발생 가능한 위험: </span>
                        {item.risk}
                      </div>

                      <div className="flex items-center gap-3 text-[10px] text-slate-500 pt-1">
                        <span>
                          {item.missingCapability ? <>부족한 역량: <code className="font-mono text-slate-600">{item.missingCapability}</code></> : '명시적으로 허용한 원격 작업의 위험'}
                        </span>
                        {item.policyField && (
                          <span>
                            관련 정책: <code className="font-mono text-slate-600">{item.policyField}</code>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 모달 푸터 */}
        <div className="border-t border-slate-200 p-4 bg-slate-50 rounded-b-2xl flex items-center justify-between gap-3">
          <div className="text-xs">
            {allChecked ? (
              <span className="flex items-center gap-1.5 text-emerald-700 font-semibold">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                모든 위험 항목이 확인되었습니다.
              </span>
            ) : (
              <span className="text-slate-500 text-[11px]">
                남은 확인 항목: <strong className="text-rose-600">{totalCount - checkedCount}개</strong> (모두 체크해야 승인 버튼 활성화)
              </span>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              disabled={isLoading}
              className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition disabled:opacity-50"
            >
              취소
            </button>
            <button
              type="button"
              data-testid="confirm-risk-button"
              onClick={handleConfirm}
              disabled={!allChecked || isLoading}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white shadow-xs transition',
                allChecked
                  ? 'bg-rose-600 hover:bg-rose-700 cursor-pointer shadow-sm'
                  : 'bg-slate-300 text-slate-500 cursor-not-allowed opacity-60',
              )}
            >
              <Shield className="w-3.5 h-3.5" />
              <span>{isLoading ? '승인 및 실행 중...' : '위험을 승인하고 실행'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
