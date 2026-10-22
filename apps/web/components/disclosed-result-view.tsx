'use client';

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { apiClient, API_MODE } from '@/lib/api-client';
import { FileText, Eye } from 'lucide-react';

/**
 * CLO-141: 반려하면서 실행자가 열어 준 에이전트 결과(result.md)를 요청자에게 보여 준다.
 *
 * 승인 전 결과는 요청자에게 나가지 않는 것이 기본값이고(sender-projection),
 * 실행자가 반려 화면에서 체크했을 때만 이 **한 건**이 열린다. 변경 파일 목록·patch·
 * 실행 로그는 여기 오지 않는다 — 실행자 컴퓨터의 경로와 명령이 그대로 들어 있다.
 */
export function DisclosedResultView({ artifactId }: { artifactId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['disclosed-result', artifactId],
    queryFn: () => apiClient.getArtifactText(artifactId),
    enabled: API_MODE === 'real' && !!artifactId,
  });

  return (
    <div
      data-testid="disclosed-result"
      className="rounded-xl border border-slate-200 bg-white p-5 mb-4"
    >
      <div className="flex items-center gap-2 border-b border-slate-100 pb-3 mb-3">
        <Eye className="w-4 h-4 text-slate-500" />
        <span className="text-sm font-bold text-slate-900">수신자가 공개한 작업 결과</span>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">
          result.md
        </span>
      </div>
      <p className="mb-3 text-[11px] text-slate-500">
        수신자가 반려하면서 에이전트가 작성한 결과 문서를 공개했습니다. 변경된 파일 목록과 patch,
        실행 로그는 공개 대상이 아닙니다.
      </p>
      {isLoading && <p className="text-xs text-slate-500">결과 문서를 불러오는 중…</p>}
      {isError && <p className="text-xs text-rose-700">결과 문서를 불러오지 못했습니다.</p>}
      {data?.text ? (
        <div className="prose prose-sm max-w-none text-slate-800">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.text}</ReactMarkdown>
        </div>
      ) : (
        !isLoading &&
        !isError && (
          <p className="flex items-center gap-1.5 text-xs text-slate-500">
            <FileText className="w-3.5 h-3.5" />
            공개된 결과 문서가 비어 있습니다.
          </p>
        )
      )}
    </div>
  );
}
