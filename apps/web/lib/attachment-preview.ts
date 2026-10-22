export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '크기 알 수 없음';
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function previewKind(mimeType: string, filename: string): 'image' | 'pdf' | 'text' | 'markdown' | null {
  const mime = mimeType.split(';')[0].trim().toLowerCase();
  if (/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(mime)) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/html' || mime === 'image/svg+xml') return null;
  if (mime === 'text/markdown' || /\.(md|markdown)$/i.test(filename)) return 'markdown';
  if (mime.startsWith('text/') || ['application/json', 'application/xml'].includes(mime) || /\.(txt|log|patch|diff|json|yaml|yml)$/i.test(filename)) return 'text';
  return null;
}
