'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Paperclip } from 'lucide-react';
import { ArtifactFile } from '@/components/artifact-file';
import { DocumentViewer } from '@/components/document-viewer';
import { withSoftBreaks } from '@/components/markdown-editor';
import { requestAttachments, requestContentCollapsed } from '@/lib/request-content';
import type { RequestDetailResponse } from '@/lib/types';

/** 요청·차수·상태가 바뀌면 부모의 key로 기본 펼침 상태를 다시 적용한다. 폴링은 사용자 선택을 유지한다. */
export function RequestContentCard({ detail }: { detail: RequestDetailResponse }) {
  const { request, currentRevision, documents } = detail;
  const [collapsed, setCollapsed] = useState(() => requestContentCollapsed(request.state));
  const artifacts = requestAttachments(detail.artifacts);
  const preview = currentRevision.originalInstruction.trim().split(/\r?\n/, 1)[0];

  return (
    <section aria-labelledby="request-content-title" className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
      <div className="flex items-center justify-between gap-4">
        <h2 id="request-content-title" className="text-sm font-bold text-slate-900">요청 내용</h2>
        <button type="button" aria-expanded={!collapsed} aria-controls="request-content-body"
          onClick={() => setCollapsed((value) => !value)}
          className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50">
          {collapsed ? '펼치기' : '접기'}
        </button>
      </div>
      {collapsed && <p className="mt-2 truncate text-sm text-slate-600">{preview || '지시 내용이 없습니다.'}</p>}
      {/* 숨기기만 하여 문서 버전 비교 선택과 파일 미리보기 상태가 접기 동작으로 사라지지 않게 한다. */}
      <div id="request-content-body" hidden={collapsed}>
        <div className="mt-4 space-y-6">
          <div className="markdown-body text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {withSoftBreaks(currentRevision.originalInstruction)}
            </ReactMarkdown>
          </div>
          {documents.map((doc) => (
            <DocumentViewer key={doc.currentVersion?.id ?? doc.document.id}
              document={doc.document} versions={doc.versions}
              currentVersion={doc.currentVersion} rawContent={doc.rawContent} />
          ))}
          {artifacts.length > 0 && (
            <div className="rounded-xl border border-slate-200 p-5">
              <h3 className="mb-3 flex items-center gap-1.5 text-xs font-bold text-slate-500">
                <Paperclip className="h-4 w-4 text-slate-400" />
                참고 첨부 파일 ({artifacts.length}건)
              </h3>
              <div className="space-y-2">
                {artifacts.map((artifact) => <ArtifactFile key={artifact.id} artifactId={artifact.id} file={artifact} />)}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
