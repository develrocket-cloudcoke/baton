export interface DownloadOptions {
  filename: string;
  disposition: 'inline' | 'attachment';
  mimeType?: string;
}

export function contentDisposition(filename: string, disposition: 'inline' | 'attachment'): string {
  // 헤더 주입·경로 해석을 막고 한글/이모지 파일명은 RFC 5987로 보존한다.
  const safe = Buffer.from(filename).toString('utf8').replace(/[\r\n\x00-\x1f\x7f/\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(safe).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="download"; filename*=UTF-8''${encoded}`;
}

export function downloadHeaders(options?: DownloadOptions) {
  const mime = options?.mimeType?.split(';')[0].trim().toLowerCase() ?? 'application/octet-stream';
  // 같은 출처인 로컬 저장소에서도 HTML/SVG를 활성 문서로 열지 않는다.
  const inlineSafe = /^(image\/(png|jpeg|gif|webp|avif|bmp)|application\/pdf|text\/(plain|markdown))$/.test(mime);
  return {
    disposition: contentDisposition(options?.filename ?? 'download', options?.disposition === 'inline' && inlineSafe ? 'inline' : 'attachment'),
    contentType: inlineSafe ? mime : 'application/octet-stream',
  };
}
