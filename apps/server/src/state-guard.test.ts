import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestState, TransitionActor, canTransition } from '@baton/shared';

test('서버는 shared 상태 전이 규칙을 그대로 사용한다', () => {
  assert.equal(
    canTransition(RequestState.ACCEPTED, RequestState.READY_TO_RUN, TransitionActor.RECIPIENT),
    true,
  );
  assert.equal(
    canTransition(RequestState.ACCEPTED, RequestState.READY_TO_RUN, TransitionActor.SENDER),
    false,
  );
});

test('발신자·수신자·에이전트별 상태 전이 표를 엄격히 적용한다', () => {
  const cases: Array<[RequestState, RequestState, TransitionActor, boolean]> = [
    [RequestState.DRAFT, RequestState.SENT, TransitionActor.SENDER, true],
    [RequestState.DRAFT, RequestState.SENT, TransitionActor.RECIPIENT, false],
    [RequestState.SENT, RequestState.DELIVERED, TransitionActor.RECIPIENT, true],
    [RequestState.DELIVERED, RequestState.REVIEWING, TransitionActor.RECIPIENT, true],
    [RequestState.REVIEWING, RequestState.RETURNED, TransitionActor.RECIPIENT, true],
    [RequestState.RETURNED, RequestState.SENT, TransitionActor.SENDER, true],
    [RequestState.REVIEWING, RequestState.ACCEPTED, TransitionActor.SENDER, false],
    [RequestState.READY_TO_RUN, RequestState.RUNNING, TransitionActor.DESKTOP_AGENT, true],
    [RequestState.RUNNING, RequestState.RESULT_REVIEW, TransitionActor.DESKTOP_AGENT, true],
    [RequestState.RESULT_REVIEW, RequestState.COMPLETED, TransitionActor.RECIPIENT, true],
    [RequestState.REJECTED, RequestState.SENT, TransitionActor.SENDER, false],
  ];
  for (const [from, to, actor, expected] of cases)
    assert.equal(canTransition(from, to, actor), expected, `${from} -> ${to} (${actor})`);
});

test('수신자 취소만 실행 준비 상태로 되돌릴 수 있다', () => {
  for (const from of [RequestState.RUNNING, RequestState.READY_TO_RUN]) {
    assert.equal(canTransition(from, RequestState.READY_TO_RUN, TransitionActor.RECIPIENT), true);
    assert.equal(canTransition(from, RequestState.READY_TO_RUN, TransitionActor.SENDER), false);
    assert.equal(
      canTransition(from, RequestState.READY_TO_RUN, TransitionActor.DESKTOP_AGENT),
      false,
    );
  }
});
