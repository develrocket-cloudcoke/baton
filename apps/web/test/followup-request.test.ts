import assert from 'node:assert/strict';
import test from 'node:test';
import { canSendFollowup } from '../lib/followup-request';

test('완료·실패 요청의 보낸 사람 본인에게만 이어서 요청을 보인다', () => {
  for (const state of ['COMPLETED', 'FAILED']) {
    assert.equal(canSendFollowup(state, 'sender', 'sender'), true);
    assert.equal(canSendFollowup(state, 'sender', 'recipient'), false);
    assert.equal(canSendFollowup(state, 'sender', 'teammate'), false);
  }
  for (const state of ['SENT', 'RUNNING', 'RESULT_REVIEW', 'REJECTED'])
    assert.equal(canSendFollowup(state, 'sender', 'sender'), false);
});
