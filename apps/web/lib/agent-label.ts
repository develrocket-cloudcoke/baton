export function agentLabel(provider?: string | null): string {
  switch (provider) {
    case 'CLAUDE_CODE':
      return 'Claude Code';
    case 'CODEX':
      return 'Codex';
    case 'AGY':
      return 'Antigravity';
    default:
      return 'AI 에이전트';
  }
}
