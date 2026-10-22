'use client';

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Edit3, Eye } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Markdown 입력 + 미리보기 탭.
 *
 * 요청 본문은 평문 textarea 였는데 상세 화면에서는 줄바꿈까지 뭉개져 보였다.
 * markdown 으로 쓰게 하려면 **쓰는 화면에서 결과를 볼 수 있어야** 한다 —
 * 미리보기 없이 markdown 만 켜면 쓴 것과 보이는 것이 달라진다.
 */

/**
 * markdown 은 **줄 하나짜리 줄바꿈을 무시한다** (같은 문단으로 이어 붙인다).
 * 요청 본문은 평범한 글처럼 엔터로 줄을 나눠 쓰는 사람이 대부분이라, 그대로 두면
 * 줄바꿈이 다시 공백으로 뭉개진다(2026-09-21 에 고쳤던 그 증상).
 *
 * 그래서 문단 안의 줄 끝에 markdown 의 강제 줄바꿈(공백 2개)을 붙인다.
 * 코드 펜스(```) 안은 내용 그대로여야 하므로 건드리지 않는다.
 * (remark-breaks 플러그인을 쓰면 더 깔끔하지만 의존성을 늘리지 않았다)
 */
export function withSoftBreaks(text: string): string {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      if (!line.trim()) return line;
      if (/\s{2,}$/.test(line)) return line;
      return line + '  ';
    })
    .join('\n');
}

export function MarkdownEditor({
  value,
  onChange,
  rows = 6,
  placeholder,
  label,
  required = false,
  testId,
}: {
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  placeholder?: string;
  label?: string;
  required?: boolean;
  testId?: string;
}) {
  const [tab, setTab] = React.useState<'write' | 'preview'>('write');

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        {label ? (
          <label className="text-xs font-semibold text-slate-700">
            {label}
            {required && <span className="ml-0.5 text-rose-500">*</span>}
          </label>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setTab('write')}
            className={cn(
              'flex items-center gap-1 rounded-md px-2.5 py-1 font-semibold transition',
              tab === 'write' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-600',
            )}
          >
            <Edit3 className="h-3.5 w-3.5" />
            <span>작성</span>
          </button>
          <button
            type="button"
            onClick={() => setTab('preview')}
            className={cn(
              'flex items-center gap-1 rounded-md px-2.5 py-1 font-semibold transition',
              tab === 'preview' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-600',
            )}
          >
            <Eye className="h-3.5 w-3.5" />
            <span>미리보기</span>
          </button>
        </div>
      </div>

      {tab === 'write' ? (
        <textarea
          data-testid={testId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          placeholder={placeholder}
          className="w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-indigo-500 focus:outline-none"
        />
      ) : (
        <div
          className="overflow-y-auto rounded-lg border border-slate-200 bg-slate-50/50 p-3"
          // 탭을 오갈 때 높이가 튀지 않게 textarea 와 비슷한 크기를 잡는다
          style={{ minHeight: `${rows * 1.6 + 1.5}rem` }}
        >
          <div className="markdown-body text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {value.trim() ? withSoftBreaks(value) : '_미리볼 내용이 없습니다._'}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}
