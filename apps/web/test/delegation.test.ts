import assert from 'node:assert/strict';
import test from 'node:test';
import { canCreateDelegation } from '../lib/delegation';

test('받는 팀 구성원에게 진행 중 상태에서만 재위임을 허용한다', () => {
  for (const state of ['ACCEPTED', 'READY_TO_RUN', 'RUNNING', 'RESULT_REVIEW']) {
    assert.equal(canCreateDelegation(state, 'team-b', ['team-a', 'team-b']), true);
    assert.equal(canCreateDelegation(state, 'team-b', ['team-a']), false);
  }
  for (const state of ['SENT', 'DELIVERED', 'REVIEWING', 'COMPLETED', 'FAILED'])
    assert.equal(canCreateDelegation(state, 'team-b', ['team-b']), false);
});
