import assert from 'node:assert/strict';
import test from 'node:test';
import { formatFileSize, previewKind } from '../lib/attachment-preview';

test('크기를 KB/MB로 표시한다', () => {
  assert.equal(formatFileSize(0), '0.0 KB');
  assert.equal(formatFileSize(1536), '1.5 KB');
  assert.equal(formatFileSize(1048576), '1.0 MB');
  assert.equal(formatFileSize(-1), '크기 알 수 없음');
});

test('이미지 PDF 텍스트 마크다운만 미리보기하고 활성 문서는 제외한다', () => {
  assert.equal(previewKind('image/png', '사진.png'), 'image');
  assert.equal(previewKind('application/pdf', '보고서.pdf'), 'pdf');
  assert.equal(previewKind('text/plain; charset=utf-8', '결과.md'), 'markdown');
  assert.equal(previewKind('application/octet-stream', 'changes.patch'), 'text');
  assert.equal(previewKind('application/zip', 'archive.zip'), null);
  assert.equal(previewKind('text/html', 'page.html'), null);
  assert.equal(previewKind('image/svg+xml', 'image.svg'), null);
});
