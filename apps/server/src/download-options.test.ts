import assert from 'node:assert/strict';
import test from 'node:test';
import { contentDisposition, downloadHeaders } from './storage/download-options';
import { LocalDiskStorage } from './storage/storage.service';

test('한글·이모지 파일명은 RFC 5987로 보존하고 헤더 제어 문자는 제거한다', () => {
  const name = '결과 파일🙂 (최종).md';
  const value = contentDisposition(name, 'attachment');
  assert.ok(value.startsWith('attachment;'));
  assert.equal(decodeURIComponent(value.split("filename*=UTF-8''")[1]), name);
  assert.doesNotMatch(contentDisposition('a\r\nX-Evil: yes.md', 'inline'), /[\r\n]/);
  assert.match(contentDisposition("a'b.txt", 'attachment'), /a%27b.txt/);
});

test('안전한 형식만 inline으로 내보낸다', () => {
  assert.match(downloadHeaders({ filename: 'a.pdf', mimeType: 'application/pdf', disposition: 'inline' }).disposition, /^inline;/);
  for (const mimeType of ['text/html', 'image/svg+xml']) {
    const headers = downloadHeaders({ filename: 'a', mimeType, disposition: 'inline' });
    assert.match(headers.disposition, /^attachment;/);
    assert.equal(headers.contentType, 'application/octet-stream');
  }
});

test('로컬 다운로드 URL은 파일·파일명·표시 방식·만료를 서명한다', async () => {
  const store = new LocalDiskStorage();
  const url = new URL(await store.issueGet('artifacts/key', { filename: '결과.md', disposition: 'inline', mimeType: 'text/markdown' }), 'http://local');
  const q = Object.fromEntries(url.searchParams);
  assert.equal(store.validGet('artifacts/key', q.expires, q.disposition, q.contentType, q.token), true);
  assert.equal(store.validGet('artifacts/other', q.expires, q.disposition, q.contentType, q.token), false);
  assert.equal(store.validGet('artifacts/key', q.expires, 'inline', q.contentType, q.token), false);
  assert.equal(store.validGet('artifacts/key', '0', q.disposition, q.contentType, q.token), false);
  assert.equal(store.validGet('artifacts/key', q.expires, q.disposition, q.contentType, ''), false);
});
