/** 검토·종결 상태에서는 결과와 후속 동작을 먼저 확인할 수 있게 본문을 접어 둔다. */
export function requestContentCollapsed(state: string): boolean {
  return ['RESULT_REVIEW', 'COMPLETED', 'FAILED', 'RETURNED', 'REJECTED', 'WITHDRAWN'].includes(state);
}

/** 이전 서버 응답에도 실행 산출물이 참고 첨부로 섞이지 않도록 웹에서도 종류를 확인한다. */
export function requestAttachments<T extends { kind: string }>(artifacts: T[]): T[] {
  return artifacts.filter((artifact) => artifact.kind === 'REQUEST_ATTACHMENT');
}
