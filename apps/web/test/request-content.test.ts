import assert from 'node:assert/strict';
import test from 'node:test';
import { requestAttachments, requestContentCollapsed } from '../lib/request-content';

test('검토·종결 상태의 요청 내용은 접고, 읽고 수행할 상태에서는 펼친다', () => {
  for (const state of ['RESULT_REVIEW', 'COMPLETED', 'FAILED', 'RETURNED', 'REJECTED', 'WITHDRAWN']) {
    assert.equal(requestContentCollapsed(state), true, state);
  }
  for (const state of ['DRAFT', 'SENT', 'DELIVERED', 'REVIEWING', 'ACCEPTED', 'READY_TO_RUN', 'RUNNING']) {
    assert.equal(requestContentCollapsed(state), false, state);
  }
});

test('서버가 실행 파일을 함께 보내더라도 참고 첨부에는 요청자 파일만 남긴다', () => {
  const files = [
    { kind: 'REQUEST_ATTACHMENT', filename: '요청 자료.pdf' },
    { kind: 'PATCH', filename: 'changes.stream.patch' },
    { kind: 'TEST_OUTPUT', filename: 'stream.jsonl' },
    { kind: 'RESULT_ATTACHMENT', filename: 'result.md' },
  ];
  assert.deepEqual(requestAttachments(files), [files[0]]);
  assert.equal(files.length, 4);
});
