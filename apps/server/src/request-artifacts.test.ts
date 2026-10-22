import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestsService } from './requests/requests.service';

test('요청 상세의 artifacts는 발신자·수신자 모두 요청 첨부만 반환한다', async () => {
  const artifacts = [
    { id: 'input', kind: 'REQUEST_ATTACHMENT', filename: '요청 자료.pdf' },
    { id: 'patch', kind: 'PATCH', filename: 'changes.stream.patch' },
    { id: 'stream', kind: 'TEST_OUTPUT', filename: 'stream.jsonl' },
    { id: 'result', kind: 'RESULT_ATTACHMENT', filename: 'result.md' },
  ];
  const row = { id: 'request', artifacts, executions: [], timelineEvents: [], children: [], parent: null };
  const service = new RequestsService({ request: { findUniqueOrThrow: async () => row } } as any);
  (service as any).owned = async () => row;
  for (const senderOnly of [true, false]) {
    (service as any).senderOnly = async () => senderOnly;
    const detail = await service.detail(senderOnly ? 'sender' : 'recipient', row.id);
    assert.deepEqual(detail.artifacts, [artifacts[0]]);
    assert.equal(row.artifacts.length, 4, '원본 결과 목록은 변경하지 않는다');
  }
});
