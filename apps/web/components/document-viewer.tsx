'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Document, DocumentVersion } from '@/lib/types';
import { apiClient } from '@/lib/api-client';
import { computeDocumentDiff } from '@/lib/diff-utils';
import { AlertModal } from '@/components/ui/modal';
import {
  FileText,
  History,
  Clock,
  Columns2,
  Rows3,
  GitCompare,
  Plus,
  Minus,
  Check
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface DocumentViewerProps {
  document: Document;
  versions: DocumentVersion[];
  currentVersion: DocumentVersion | null;
  rawContent?: string;
  className?: string;
  initialMode?: 'single' | 'diff';
}

export function DocumentViewer({
  document,
  versions = [],
  currentVersion,
  rawContent,
  className,
  initialMode
}: DocumentViewerProps) {
  // 뷰 모드: 'single'(단일 문서 보기) vs 'diff'(버전 비교)
  const [viewMode, setViewMode] = useState<'single' | 'diff'>(() => {
    if (initialMode) return initialMode;
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('docMode') === 'diff') return 'diff';
    }
    return 'single';
  });

  // 단일 문서 보기 시 선택된 버전
  const [selectedVersionId, setSelectedVersionId] = useState<string>(
    currentVersion?.id || versions[versions.length - 1]?.id || ''
  );

  // 버전 비교 시 기준 버전(Base/v1) 및 대상 버전(Target/v2)
  const defaultBaseId = versions.length > 1 ? versions[0].id : (versions[0]?.id || '');
  const defaultTargetId = versions.length > 1 ? versions[versions.length - 1].id : (versions[0]?.id || '');
  const [baseVersionId, setBaseVersionId] = useState<string>(defaultBaseId);
  const [targetVersionId, setTargetVersionId] = useState<string>(defaultTargetId);

  // 비교 방식: 'side-by-side'(좌우 비교) vs 'unified'(통합 비교)
  const [diffFormat, setDiffFormat] = useState<'side-by-side' | 'unified'>(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('docDiffFormat') === 'unified') return 'unified';
    }
    return 'side-by-side';
  });

  // 안내 모달 상태 (window.alert 대체)
  const [alertMessage, setAlertMessage] = useState<string | null>(null);

  // URL 쿼리 파라미터(?modal=docAlert) 연동
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('modal') === 'docAlert') {
        setAlertMessage('비교할 이전 버전이 존재하지 않습니다 (버전 2개 이상 필요).');
      }
    }
  }, []);

  // 버전 내용 쿼리 (필요 시 API 조회)
  const baseQuery = useQuery({
    queryKey: ['document-version', baseVersionId],
    queryFn: () => apiClient.getDocumentVersion(baseVersionId),
    enabled: Boolean(baseVersionId) && viewMode === 'diff'
  });

  const targetQuery = useQuery({
    queryKey: ['document-version', targetVersionId],
    queryFn: () => apiClient.getDocumentVersion(targetVersionId),
    enabled: Boolean(targetVersionId) && viewMode === 'diff'
  });

  const singleQuery = useQuery({
    queryKey: ['document-version', selectedVersionId],
    queryFn: () => apiClient.getDocumentVersion(selectedVersionId),
    enabled: Boolean(selectedVersionId) && viewMode === 'single'
  });

  // 단일 문서 활성 버전
  const activeVersion =
    versions.find((v) => v.id === selectedVersionId) || currentVersion || versions[0];

  // 단일 문서 내용
  const resolveContent = (ver?: DocumentVersion, fetchedContent?: string) => {
    if (fetchedContent) return fetchedContent;
    if (!ver) return rawContent || '';
    if ((ver as any).content) return (ver as any).content;
    if (ver.contentRef && !ver.contentRef.startsWith('inline://') && !ver.contentRef.startsWith('s3://')) {
      return ver.contentRef;
    }
    if (ver.id === currentVersion?.id && rawContent) {
      return rawContent;
    }
    return rawContent || '(문서 본문을 불러오지 못했습니다)';
  };

  const contentToRender = resolveContent(activeVersion, singleQuery.data?.content);

  // diff용 내용 추출
  const baseVer = versions.find((v) => v.id === baseVersionId) || versions[0];
  const targetVer = versions.find((v) => v.id === targetVersionId) || versions[versions.length - 1] || versions[0];

  const baseText = resolveContent(baseVer, baseQuery.data?.content);
  const targetText = resolveContent(targetVer, targetQuery.data?.content);

  // 줄 단위 LCS Diff 계산
  const diffResult = useMemo(() => {
    if (viewMode !== 'diff') return null;
    return computeDocumentDiff(baseText, targetText);
  }, [viewMode, baseText, targetText]);

  const canCompare = versions.length >= 2;

  return (
    <div id="document-viewer" className={cn('rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden', className)}>
      {/* 상단 탭 및 문서 타이틀 */}
      <div className="flex flex-wrap items-center justify-between border-b border-slate-200 bg-slate-50/90 px-4 py-3 gap-3">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-indigo-600 shrink-0" />
          <span className="font-bold text-sm text-slate-800 tracking-tight">{document.name}</span>
          <span className="rounded bg-slate-200/80 px-1.5 py-0.5 text-[11px] font-mono text-slate-600">
            {document.mimeType}
          </span>
        </div>

        {/* 뷰 모드 전환 토글 (단일 문서 vs 버전 비교) */}
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg bg-slate-200/70 p-0.5 text-xs font-semibold">
            <button
              type="button"
              onClick={() => setViewMode('single')}
              className={cn(
                'flex items-center gap-1 px-2.5 py-1 rounded-md transition',
                viewMode === 'single'
                  ? 'bg-white text-indigo-700 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              )}
            >
              <FileText className="w-3.5 h-3.5" />
              <span>단일 문서</span>
            </button>
            <button
              type="button"
              onClick={() => {
                if (canCompare) {
                  setViewMode('diff');
                } else {
                  setAlertMessage('비교할 이전 버전이 존재하지 않습니다 (버전 2개 이상 필요).');
                }
              }}
              className={cn(
                'flex items-center gap-1 px-2.5 py-1 rounded-md transition',
                viewMode === 'diff'
                  ? 'bg-white text-indigo-700 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900',
                !canCompare && 'opacity-50 cursor-not-allowed'
              )}
              title={!canCompare ? '비교할 이전 버전이 없습니다.' : '문서 버전 비교 (Diff)'}
            >
              <GitCompare className="w-3.5 h-3.5" />
              <span>버전 비교 (Diff)</span>
              {versions.length > 1 && (
                <span className="ml-0.5 rounded-full bg-indigo-100 text-indigo-700 px-1.5 text-[10px]">
                  {versions.length}
                </span>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* 모드 1: 단일 문서 보기 버전 탭 및 메타데이터 */}
      {viewMode === 'single' && (
        <>
          <div className="flex flex-wrap items-center justify-between border-b border-slate-100 bg-slate-50/40 px-4 py-2 gap-2 text-xs">
            {versions.length > 0 && (
              <div className="flex items-center gap-1.5">
                <History className="w-3.5 h-3.5 text-slate-500" />
                <span className="text-[11px] font-medium text-slate-500 mr-1">버전 선택:</span>
                {versions.map((ver) => {
                  const isSelected = ver.id === selectedVersionId;
                  return (
                    <button
                      key={ver.id}
                      onClick={() => setSelectedVersionId(ver.id)}
                      className={cn(
                        'px-2 py-0.5 rounded text-xs font-semibold transition',
                        isSelected
                          ? 'bg-indigo-600 text-white shadow-xs'
                          : 'text-slate-600 hover:text-slate-900 bg-slate-200/60 hover:bg-slate-200'
                      )}
                    >
                      v{ver.versionNo}
                      {ver.id === currentVersion?.id && (
                        <span className="ml-1 text-[10px] font-normal opacity-80">(최신)</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {activeVersion && (
              <div className="flex items-center gap-2 text-slate-500">
                <Clock className="w-3.5 h-3.5" />
                <span>
                  v{activeVersion.versionNo} • {new Date(activeVersion.createdAt).toLocaleString('ko-KR')}
                </span>
                {activeVersion.changeNote && (
                  <span className="italic text-slate-600">({activeVersion.changeNote})</span>
                )}
              </div>
            )}
          </div>

          {/* 마크다운 렌더링 바디 */}
          <div className="p-6 max-h-[520px] overflow-y-auto">
            <div className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{contentToRender}</ReactMarkdown>
            </div>
          </div>
        </>
      )}

      {/* 모드 2: 버전 비교 (Diff) 컨트롤 바 및 Diff 본문 */}
      {viewMode === 'diff' && diffResult && (
        <div>
          {/* 비교 컨트롤 서브 바 */}
          <div className="flex flex-wrap items-center justify-between border-b border-slate-200 bg-slate-100/70 px-4 py-2.5 gap-3 text-xs">
            {/* 버전 선택 셀렉터 */}
            <div className="flex items-center gap-2">
              <span className="text-slate-500 font-medium">비교:</span>
              <div className="flex items-center gap-1.5">
                <select
                  value={baseVersionId}
                  onChange={(e) => setBaseVersionId(e.target.value)}
                  className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-800 shadow-xs focus:border-indigo-500 focus:outline-none"
                >
                  {versions.map((ver) => (
                    <option key={ver.id} value={ver.id}>
                      v{ver.versionNo} {ver.id === currentVersion?.id ? '(최신)' : ''}
                    </option>
                  ))}
                </select>
                <span className="text-slate-400 font-bold">→</span>
                <select
                  value={targetVersionId}
                  onChange={(e) => setTargetVersionId(e.target.value)}
                  className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-800 shadow-xs focus:border-indigo-500 focus:outline-none"
                >
                  {versions.map((ver) => (
                    <option key={ver.id} value={ver.id}>
                      v{ver.versionNo} {ver.id === currentVersion?.id ? '(최신)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              {/* 추가/삭제 통계 배지 */}
              <div className="flex items-center gap-1.5 ml-2 font-mono">
                <span className="inline-flex items-center gap-0.5 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800">
                  <Plus className="w-3 h-3" />
                  {diffResult.stats.additions} 줄 추가
                </span>
                <span className="inline-flex items-center gap-0.5 rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-800">
                  <Minus className="w-3 h-3" />
                  {diffResult.stats.deletions} 줄 삭제
                </span>
              </div>
            </div>

            {/* diff 출력 모드 (좌우 비교 vs 통합 비교) */}
            <div className="flex items-center gap-1">
              <div className="inline-flex rounded-lg bg-slate-200 p-0.5 text-xs font-semibold">
                <button
                  type="button"
                  onClick={() => setDiffFormat('side-by-side')}
                  className={cn(
                    'flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition',
                    diffFormat === 'side-by-side'
                      ? 'bg-white text-indigo-700 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  )}
                >
                  <Columns2 className="w-3 h-3" />
                  <span>좌우 비교 (Side-by-Side)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setDiffFormat('unified')}
                  className={cn(
                    'flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition',
                    diffFormat === 'unified'
                      ? 'bg-white text-indigo-700 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  )}
                >
                  <Rows3 className="w-3 h-3" />
                  <span>통합 비교 (Unified)</span>
                </button>
              </div>
            </div>
          </div>

          {/* Diff 뷰 본문 */}
          {diffFormat === 'unified' ? (
            /* 통합 Diff 뷰 */
            <div className="p-3 bg-slate-950 font-mono text-xs text-slate-100 max-h-[520px] overflow-auto leading-5">
              {diffResult.unified.map((line, idx) => {
                const isAdd = line.type === 'add';
                const isDel = line.type === 'delete';

                return (
                  <div
                    key={idx}
                    className={cn('flex items-start px-2 py-0.5 rounded-sm', {
                      'bg-emerald-950/70 text-emerald-300 font-medium': isAdd,
                      'bg-rose-950/70 text-rose-300 font-medium line-through decoration-rose-500/50': isDel,
                      'text-slate-300': !isAdd && !isDel
                    })}
                  >
                    <span className="w-8 select-none text-slate-500 text-right pr-2 shrink-0">
                      {line.oldLineNo ?? ''}
                    </span>
                    <span className="w-8 select-none text-slate-500 text-right pr-3 shrink-0">
                      {line.newLineNo ?? ''}
                    </span>
                    <span
                      className={cn('w-4 select-none text-center font-bold shrink-0', {
                        'text-emerald-400': isAdd,
                        'text-rose-400': isDel,
                        'text-slate-600': !isAdd && !isDel
                      })}
                    >
                      {isAdd ? '+' : isDel ? '-' : ' '}
                    </span>
                    <span className="flex-1 whitespace-pre pl-1">{line.value}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            /* 좌우(Side-by-Side) Diff 뷰 */
            <div className="bg-slate-950 font-mono text-xs text-slate-100 max-h-[520px] overflow-auto">
              {/* 좌우 헤더 */}
              <div className="grid grid-cols-2 border-b border-slate-800 bg-slate-900/90 text-[11px] font-semibold text-slate-400 px-4 py-2 sticky top-0 z-10">
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-200">v{baseVer?.versionNo ?? 1} (이전 버전)</span>
                  {baseVer?.changeNote && (
                    <span className="text-slate-500 truncate font-normal">
                      - {baseVer.changeNote}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 pl-4 border-l border-slate-800">
                  <span className="text-emerald-400">v{targetVer?.versionNo ?? 2} (비교 대상)</span>
                  {targetVer?.changeNote && (
                    <span className="text-slate-500 truncate font-normal">
                      - {targetVer.changeNote}
                    </span>
                  )}
                </div>
              </div>

              {/* 좌우 내용 행 */}
              <div className="divide-y divide-slate-900/60 leading-5">
                {diffResult.sideBySide.map((row, rIdx) => {
                  const leftType = row.left?.type ?? 'empty';
                  const rightType = row.right?.type ?? 'empty';

                  return (
                    <div key={rIdx} className="grid grid-cols-2">
                      {/* 왼쪽 컬럼 (이전 버전) */}
                      <div
                        className={cn('flex items-start px-3 py-0.5 border-r border-slate-900 overflow-x-auto', {
                          'bg-rose-950/60 text-rose-300 font-medium line-through decoration-rose-500/50':
                            leftType === 'delete',
                          'bg-slate-950 text-slate-300': leftType === 'equal',
                          'bg-slate-900/20 text-transparent': leftType === 'empty'
                        })}
                      >
                        <span className="w-8 select-none text-slate-500 text-right pr-2 shrink-0">
                          {row.left?.lineNo ?? ''}
                        </span>
                        <span className="w-3 select-none text-center shrink-0 font-bold text-rose-400">
                          {leftType === 'delete' ? '-' : ' '}
                        </span>
                        <span className="flex-1 whitespace-pre pl-1">{row.left?.text ?? ''}</span>
                      </div>

                      {/* 오른쪽 컬럼 (변경 버전) */}
                      <div
                        className={cn('flex items-start px-3 py-0.5 overflow-x-auto', {
                          'bg-emerald-950/60 text-emerald-300 font-medium': rightType === 'add',
                          'bg-slate-950 text-slate-300': rightType === 'equal',
                          'bg-slate-900/20 text-transparent': rightType === 'empty'
                        })}
                      >
                        <span className="w-8 select-none text-slate-500 text-right pr-2 shrink-0">
                          {row.right?.lineNo ?? ''}
                        </span>
                        <span className="w-3 select-none text-center shrink-0 font-bold text-emerald-400">
                          {rightType === 'add' ? '+' : ' '}
                        </span>
                        <span className="flex-1 whitespace-pre pl-1">{row.right?.text ?? ''}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 버전 비교 불가 안내 모달 (window.alert 대체) */}
      <AlertModal
        isOpen={Boolean(alertMessage)}
        onClose={() => setAlertMessage(null)}
        title="버전 비교 불가"
        message={alertMessage || ''}
      />
    </div>
  );
}
