export enum RequestState {
  WITHDRAWN = 'WITHDRAWN',
  DRAFT = 'DRAFT',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  REVIEWING = 'REVIEWING',
  ACCEPTED = 'ACCEPTED',
  RETURNED = 'RETURNED',
  REJECTED = 'REJECTED',
  READY_TO_RUN = 'READY_TO_RUN',
  RUNNING = 'RUNNING',
  RESULT_REVIEW = 'RESULT_REVIEW',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export enum TransitionActor {
  SENDER = 'SENDER',
  RECIPIENT = 'RECIPIENT',
  DESKTOP_AGENT = 'DESKTOP_AGENT',
  SERVER = 'SERVER',
}

type Transition = { to: RequestState; actors: readonly TransitionActor[] };

const transitions: Record<RequestState, readonly Transition[]> = {
  [RequestState.WITHDRAWN]: [],
  [RequestState.DRAFT]: [{ to: RequestState.SENT, actors: [TransitionActor.SENDER] }],
  [RequestState.SENT]: [
    { to: RequestState.WITHDRAWN, actors: [TransitionActor.SENDER] },
    { to: RequestState.DELIVERED, actors: [TransitionActor.SERVER, TransitionActor.RECIPIENT] },
  ],
  [RequestState.DELIVERED]: [{ to: RequestState.WITHDRAWN, actors: [TransitionActor.SENDER] }, { to: RequestState.REVIEWING, actors: [TransitionActor.RECIPIENT] }],
  [RequestState.REVIEWING]: [
    { to: RequestState.WITHDRAWN, actors: [TransitionActor.SENDER] },
    { to: RequestState.ACCEPTED, actors: [TransitionActor.RECIPIENT] },
    { to: RequestState.RETURNED, actors: [TransitionActor.RECIPIENT] },
    { to: RequestState.REJECTED, actors: [TransitionActor.RECIPIENT] },
  ],
  [RequestState.ACCEPTED]: [{ to: RequestState.READY_TO_RUN, actors: [TransitionActor.RECIPIENT] }],
  [RequestState.RETURNED]: [{ to: RequestState.WITHDRAWN, actors: [TransitionActor.SENDER] }, { to: RequestState.SENT, actors: [TransitionActor.SENDER] }],
  [RequestState.REJECTED]: [],
  [RequestState.READY_TO_RUN]: [
    { to: RequestState.READY_TO_RUN, actors: [TransitionActor.RECIPIENT] },
    { to: RequestState.RUNNING, actors: [TransitionActor.DESKTOP_AGENT] },
    { to: RequestState.FAILED, actors: [TransitionActor.DESKTOP_AGENT, TransitionActor.SERVER] },
  ],
  [RequestState.RUNNING]: [
    { to: RequestState.READY_TO_RUN, actors: [TransitionActor.RECIPIENT] },
    { to: RequestState.RESULT_REVIEW, actors: [TransitionActor.DESKTOP_AGENT] },
    { to: RequestState.FAILED, actors: [TransitionActor.DESKTOP_AGENT] },
  ],
  [RequestState.RESULT_REVIEW]: [
    // 최초 실행과 동일하게 QUEUED를 거쳐 데몬 시작 보고 때만 RUNNING으로 전환한다.
    { to: RequestState.READY_TO_RUN, actors: [TransitionActor.RECIPIENT] },
    { to: RequestState.COMPLETED, actors: [TransitionActor.RECIPIENT] },
    // CLO-141: 결과 검토가 막다른 길이었다. 전달하거나 될 때까지 다시 돌리는 두 길밖에 없어서,
    // 일단 수락해 실행하고 나면 "이 일은 우리가 할 게 아니다"를 말할 방법이 없었다(2026-09-21 실사용).
    // 반려는 요청자가 보완해 재전송하면 RETURNED → SENT 로 살아나고, 거절은 종결,
    // 결과 폐기는 요청을 살린 채 실행 설정(ACCEPTED)부터 다시 한다.
    { to: RequestState.RETURNED, actors: [TransitionActor.RECIPIENT] },
    { to: RequestState.REJECTED, actors: [TransitionActor.RECIPIENT] },
    { to: RequestState.ACCEPTED, actors: [TransitionActor.RECIPIENT] },
  ],
  [RequestState.COMPLETED]: [{ to: RequestState.SENT, actors: [TransitionActor.SENDER] }],
  [RequestState.FAILED]: [{ to: RequestState.SENT, actors: [TransitionActor.SENDER] }],
};

export function canTransition(
  from: RequestState,
  to: RequestState,
  actor: TransitionActor,
): boolean {
  return transitions[from].some(
    (transition) => transition.to === to && transition.actors.includes(actor),
  );
}
