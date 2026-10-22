import type { ExecutionContext } from '../interface';

// 실행 위험 집합은 공통 어댑터 게이트에서 독립 검증한다. 여기서는 CLI 입력 제약만 검사한다.
export function agyPolicyError(ctx: ExecutionContext): string | null {
  if (
    ctx.resumeSessionId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ctx.resumeSessionId)
  ) {
    return 'Antigravity resume에는 명시적 UUID 세션 ID가 필요합니다';
  }
  if (ctx.maxBudgetUsd !== undefined) {
    return 'Antigravity는 maxBudgetUsd 예산 제한을 제공하지 않습니다';
  }
  return null;
}

export function buildAgyArgs(ctx: ExecutionContext, prompt: string, timeoutMs?: number): string[] {
  const args: string[] = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--dangerously-skip-permissions',
    '--sandbox',
    '--disable-slash-commands'
  ];

  if (ctx.model) {
    args.push('--model', ctx.model);
  }

  if (ctx.resumeSessionId) {
    args.push('--conversation', ctx.resumeSessionId);
  }

  if (timeoutMs) {
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    args.push('--print-timeout', `${seconds}s`);
  }

  return args;
}
