'use client';

import React from 'react';
import { FileText, Paperclip } from 'lucide-react';

export interface PickedAttachment {
  filename: string;
  sizeBytes: number;
  mimeType: string;
  content: string;
}

/** 텍스트로 읽어 보낼 수 있는 크기 상한. 넘으면 사람에게 알리고 거른다. */
const MAX_BYTES = 1024 * 1024;

/**
 * 참고 파일 첨부.
 *
 * 예전에는 **파일명만 타이핑**하게 해 놓고, 업로드 시점에 클라이언트가 가짜 Redis 에러
 * 로그를 만들어 올렸다. 사람은 `server.log` 를 붙였다고 믿는데 AI 에이전트는 지어낸
 * 스택트레이스를 받았다(2026-09-21 전수조사 결함 1·2). 실제 파일을 읽어 보낸다.
 *
 * 내용을 텍스트로 싣는 구조라 바이너리는 받지 않는다. Baton 의 첨부는 로그·설정처럼
 * 사람이 읽는 파일을 전제로 한다.
 */
export function AttachmentPicker({
  attachments,
  onChange,
}: {
  attachments: PickedAttachment[];
  onChange: (next: PickedAttachment[]) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [error, setError] = React.useState<string | null>(null);

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    const picked: PickedAttachment[] = [];
    const rejected: string[] = [];
    for (const file of Array.from(files)) {
      if (file.size > MAX_BYTES) {
        rejected.push(`${file.name} (${Math.round(file.size / 1024)}KB — 1MB 초과)`);
        continue;
      }
      const content = await file.text();
      // 널 바이트가 있으면 텍스트가 아니다. 그대로 보내면 에이전트가 받는 내용이 깨진다.
      if (content.includes('\u0000')) {
        rejected.push(`${file.name} (텍스트 파일이 아님)`);
        continue;
      }
      picked.push({
        filename: file.name,
        sizeBytes: file.size,
        mimeType: file.type || 'text/plain',
        content,
      });
    }
    if (rejected.length) setError(`첨부하지 못한 파일: ${rejected.join(', ')}`);
    if (picked.length) onChange([...attachments, ...picked]);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div>
      {attachments.length > 0 && (
        <div className="mb-3 space-y-2">
          {attachments.map((att, idx) => (
            <div
              key={`${att.filename}-${idx}`}
              className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs"
            >
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-slate-500" />
                <span className="font-semibold text-slate-800">{att.filename}</span>
                <span className="text-slate-400">({att.sizeBytes.toLocaleString()} bytes)</span>
              </div>
              <button
                type="button"
                onClick={() => onChange(attachments.filter((_, i) => i !== idx))}
                className="text-slate-400 transition hover:text-rose-600"
              >
                삭제
              </button>
            </div>
          ))}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        multiple
        data-testid="attachment-input"
        onChange={(e) => void handleFiles(e.target.files)}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
      >
        <Paperclip className="h-3.5 w-3.5" />
        <span>파일 선택</span>
      </button>
      <p className="mt-1.5 text-xs text-slate-500">
        고른 파일의 내용이 그대로 에이전트에게 전달됩니다. 텍스트 파일만, 1MB 까지.
      </p>
      {error && <p className="mt-1.5 text-xs font-semibold text-rose-700">{error}</p>}
    </div>
  );
}
