'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { apiClient, API_URL } from '@/lib/api-client';
import { formatFileSize, previewKind } from '@/lib/attachment-preview';

interface FileInfo { id: string; filename: string; mimeType: string; sizeBytes: number }
type Preview = { file: FileInfo; kind: ReturnType<typeof previewKind>; url: string; text?: string };

export function ArtifactFile({ artifactId, file }: { artifactId: string; file?: FileInfo }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, [artifactId]);
  useEffect(() => {
    if (!preview) return;
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreview(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [preview]);

  async function open(download: boolean) {
    const current = ++generation.current;
    setBusy(true);
    setError('');
    try {
      // 클릭할 때마다 권한을 재확인한다. 저장 키로 URL을 직접 만들지 않는다.
      const metadata = await apiClient.getArtifact(artifactId, download ? 'attachment' : 'inline');
      if (!metadata.downloadUrl) throw new Error('파일 다운로드 주소가 없습니다.');
      const kind = previewKind(metadata.mimeType, metadata.filename);
      let url = metadata.downloadUrl.startsWith('http') ? metadata.downloadUrl : `${API_URL}${metadata.downloadUrl}`;
      if (download || !kind) {
        if (!download) {
          const ticket = await apiClient.getArtifact(artifactId, 'attachment');
          if (!ticket.downloadUrl) throw new Error('파일 다운로드 주소가 없습니다.');
          url = ticket.downloadUrl.startsWith('http') ? ticket.downloadUrl : `${API_URL}${ticket.downloadUrl}`;
        }
        if (current === generation.current) window.location.assign(url);
      } else {
        let text: string | undefined;
        if (kind === 'text' || kind === 'markdown') {
          if (metadata.sizeBytes > 2 * 1024 * 1024) throw new Error('2 MB를 넘는 텍스트는 내려받아 확인해 주세요.');
          const response = await fetch(url);
          if (!response.ok) throw new Error('파일을 읽지 못했습니다. 다시 시도해 주세요.');
          text = await response.text();
        }
        if (current === generation.current) setPreview({ file: metadata, kind, url, text });
      }
    } catch (e) {
      if (current === generation.current) setError(e instanceof Error ? e.message : '파일을 열지 못했습니다.');
    } finally { if (current === generation.current) setBusy(false); }
  }

  return <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
    <div className="flex items-center justify-between gap-3">
      <button type="button" onClick={() => open(false)} disabled={busy} className="truncate text-left font-semibold text-indigo-700 hover:underline">
        {file?.filename ?? '결과 첨부 파일 보기'}
      </button>
      <div className="flex shrink-0 items-center gap-3">
        {file && <span className="text-slate-500">{formatFileSize(file.sizeBytes)}</span>}
        <button type="button" disabled={busy} onClick={() => open(true)} className="text-indigo-700">내려받기</button>
      </div>
    </div>
    {busy && <p role="status">파일을 불러오는 중…</p>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
    {preview && <div role="dialog" aria-modal="true" aria-label={preview.file.filename}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-6">
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col rounded-xl bg-white p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="truncate font-semibold">{preview.file.filename}</h2>
          <button type="button" onClick={() => setPreview(null)}>닫기</button>
        </div>
        <div className="overflow-auto">
          {preview.kind === 'image' && <img src={preview.url} alt={preview.file.filename} className="mx-auto max-h-[75vh] max-w-full" />}
          {preview.kind === 'pdf' && <iframe title={preview.file.filename} src={preview.url} sandbox="allow-same-origin" className="h-[70vh] w-full" />}
          {preview.kind === 'text' && <pre className="whitespace-pre-wrap break-words">{preview.text}</pre>}
          {preview.kind === 'markdown' && <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{preview.text ?? ''}</ReactMarkdown></div>}
        </div>
      </div>
    </div>}
  </div>;
}
