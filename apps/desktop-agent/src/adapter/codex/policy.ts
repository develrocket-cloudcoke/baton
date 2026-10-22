import type { ExecutionContext } from '../interface';
import type { ExecDir } from '../claude-code/exec-dir';
import { renderSystemContract } from '../common/contract';

// 실행 위험 집합은 공통 어댑터 게이트에서 독립 검증한다. 여기서는 CLI 입력 제약만 검사한다.
export function codexPolicyError(ctx: ExecutionContext): string | null {
  if (ctx.resumeSessionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ctx.resumeSessionId)) return 'Codex resume에는 명시적 UUID 세션 ID가 필요합니다';
  if (ctx.maxTurns !== undefined || ctx.maxBudgetUsd !== undefined) return 'Codex exec는 maxTurns/maxBudgetUsd 제한을 제공하지 않습니다';
  return null;
}

// Codex 는 result.md 를 CLI 가 -o 로 저장하므로 모델에게 파일 쓰기를 시키지 않는다.
export function codexContract(ctx: ExecutionContext, dir: ExecDir): string {
  return renderSystemContract({
    policy: ctx.policy,
    projectRoot: ctx.projectRoot,
    inputDir: dir.inputDir,
    outputDir: dir.outputDir,
    resultPath: dir.resultMdPath,
    writesResultFile: false
  });
}

/**
 * 웹에서 고른 모델은 `<slug>` 또는 `<slug>:<추론강도>` 다 (common/models.ts 가 그렇게 싣는다).
 * 알 수 없는 강도는 버리고 모델만 쓴다 — CLI 가 거부하면 실행 전체가 실패하기 때문이다.
 */
const CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export function splitCodexModel(model?: string): { slug: string | null; effort: string | null } {
  const raw = model?.trim();
  if (!raw) return { slug: null, effort: null };
  const at = raw.lastIndexOf(':');
  if (at <= 0) return { slug: raw, effort: null };
  const slug = raw.slice(0, at);
  const effort = raw.slice(at + 1);
  return CODEX_EFFORTS.has(effort) ? { slug, effort } : { slug: raw, effort: null };
}

export function buildCodexArgs(ctx: ExecutionContext, dir: ExecDir): string[] {
  const { slug: modelSlug, effort: reasoningEffort } = splitCodexModel(ctx.model);
  // resume 하위 명령은 -s/-C/--add-dir를 받지 않으므로 부모 exec 옵션으로 둔다.
  const args = ['exec', '--ignore-user-config', '--ignore-rules', '-s', 'workspace-write', '-C', ctx.projectRoot,
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
    '-c', `sandbox_workspace_write.network_access=${ctx.policy.network_outbound === 'allow'}`,
    '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
    // 추론 강도는 더 이상 고정하지 않는다. 예전에는 항상 "low" 로 못 박혀 있어서
    // 어떤 모델을 골라도 가장 얕게 돌았다. 사람이 고른 강도가 있으면 그것을 쓰고,
    // 없으면 인자를 아예 넣지 않아 모델 자신의 기본 강도로 돈다.
    ...(reasoningEffort ? ['-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`] : []),
    // CLO-110 H-4: Baton 규약을 시스템 계층으로 올린다. 실측(codex-cli 0.154.0) 결과 이 키는 prompt input 의
    // **최상단 developer 메시지**로 들어간다(`codex debug prompt-input` 으로 확인). --strict-config 를 주지 않으므로
    // 이 키를 모르는 버전에서는 무음 무시되는데, 그 경우에도 프롬프트 최상단 고정 규약 구획이 남는다(common/prompt.ts).
    // 값은 TOML 로 파싱되므로 JSON.stringify 로 basic string 이스케이프를 맞춘다.
    '-c', `developer_instructions=${JSON.stringify(codexContract(ctx, dir))}`];
  if (modelSlug) args.push('-m', modelSlug);
  if (ctx.resumeSessionId) args.push('resume', ctx.resumeSessionId);
  args.push('--json', '-o', dir.resultMdPath, '-');
  return args;
}
