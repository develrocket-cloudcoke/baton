export function failureGuidance(code?: string | null): string {
  switch (code) {
    case 'project_not_git':
      return '이 프로젝트 폴더는 git 저장소가 아니라 Codex·Antigravity로 실행할 수 없습니다. Baton 앱 → 프로젝트의 [git 저장소로 만들기]를 누르거나, Claude Code로 다시 실행해 주세요.';
    case 'git_missing':
      return '실행하는 Mac에서 git을 사용할 수 없습니다. Mac 터미널에서 xcode-select --install을 실행하고 설치가 끝나면 다시 실행해 주세요.';
    default:
      return '실패 원인을 확인하고 다시 실행해 보세요.';
  }
}

export function canPrepareExecution(
  state: string,
  hasActiveExecution: boolean,
  isRecipient: boolean,
): boolean {
  if (state === 'FAILED' && !isRecipient) return false;
  return !hasActiveExecution && ['ACCEPTED', 'READY_TO_RUN', 'FAILED'].includes(state);
}
