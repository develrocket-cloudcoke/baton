import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Policy } from '../../transport/events';
import { ExecDir } from './exec-dir';

// hook(baton hook pretool) 이 읽는 정책 파일
export const APPROVAL_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Read', 'Grep', 'Glob'] as const;
export interface HookPolicy {
  approvalMode?: 'ask';
  writableRoots: string[];
  allowOutsideWrite: boolean;
  denyReadPaths: string[];
  denyCommandPatterns: string[];
  hardDenyCommandPatterns?: string[];
  readOnlyShell: boolean;
  hookLog: string;
  canaryPath: string;
}

export interface HookCommand {
  // hook 진입점: 이 패키지의 CLI (`node <cli.js> hook ...`)
  node: string;
  cli: string;
}

const DEPLOY_PATTERNS = [
  '(^|[\\s;&|])kubectl\\s+(apply|delete|patch|edit|scale|rollout|create|replace|label|annotate|cordon|drain|taint|exec|port-forward)\\b',
  '(^|[\\s;&|])helm\\s+(install|upgrade|uninstall|rollback)\\b',
  '(^|[\\s;&|])terraform\\s+(apply|destroy)\\b',
  '(^|[\\s;&|])aws\\s',
  '(^|[\\s;&|])gcloud\\s',
  '(^|[\\s;&|])az\\s'
];
// 전역 옵션(-C/-c/--git-dir 등) 앞뒤도 잡는다. 셸 파서가 아니므로 인자의 단어도 보수적으로 차단할 수 있다.
const GIT_PREFIX = String.raw`\bgit\s+(?:[^\n;&|]*?\s+)?`;
export const GIT_LOCAL_PATTERNS = [GIT_PREFIX + String.raw`(add|commit|branch|tag|checkout|switch|merge|rebase|cherry-pick|revert|reset|restore|rm|mv|clean|am|stash|update-ref|symbolic-ref)\b`];
export const GIT_REMOTE_PATTERNS = [GIT_PREFIX + String.raw`push\b`, String.raw`\bgh\s+(?:[^\n;&|]*?\s+)?pr\s+(?:[^\n;&|]*?\s+)?create\b`];
const WRITE_SHELL_PATTERNS = ['(^|[\\s;&|])(rm|mv|cp|touch|tee|sed\\s+-i|chmod|chown|mkdir|npm\\s+install|pnpm\\s+(add|install)|pip\\s+install)\\b', '>\\s*[^&]'];

// Baton 홈(~/.baton 또는 BATON_HOME) 안에서 **비밀이 든 파일만** 막는다.
// 홈 디렉터리를 통째로 막으면 안 된다 — 실행 디렉터리가 그 안(<home>/executions/<id>/)에 있어서,
// 에이전트가 자기 첨부(input/docs)를 못 읽고 결과 문서(output/result.md)도 못 쓴다(2026-09-14 실측 회귀).
export function batonSecretPaths(home = os.homedir()): string[] {
  const defaultBaton = path.join(home, '.baton');
  const batonDir = process.env.BATON_HOME || defaultBaton;
  const dirs = batonDir === defaultBaton ? [batonDir] : [batonDir, defaultBaton];
  // device-token: 디바이스 토큰 자체. config.json: deviceId·agentId·userId 와 서버 주소.
  // H-3 체인(인젝션 → 토큰 탈취 → capability 과대 선언)은 device-token 만 막아도 끊기지만,
  // 식별자까지 함께 가려 두는 편이 정찰 비용을 올린다.
  return dirs.flatMap((d) => [path.join(d, 'device-token'), path.join(d, 'config.json')]);
}

// 자격증명 파일: sandbox.credentials 는 Bash 만 막으므로 Read(//경로) deny 도 세트로 넣는다 (F2)
// H-3-1: Baton 디바이스 토큰도 자격증명 경로에 포함해 프롬프트 인젝션에 의한 토큰 탈취를 막는다.
export function credentialPaths(home = os.homedir()): string[] {
  return [
    path.join(home, '.aws'),
    path.join(home, '.aws', 'credentials'),
    path.join(home, '.aws', 'config'),
    path.join(home, '.ssh'),
    path.join(home, '.kube'),
    path.join(home, '.kube', 'config'),
    path.join(home, '.netrc'),
    path.join(home, '.docker'),
    path.join(home, '.docker', 'config.json'),
    ...batonSecretPaths(home)
  ];
}

// macOS 의 /var → /private/var 처럼 심볼릭 링크 경로가 섞이면 경로 비교가 틀어지므로 실제 경로로 정규화한다.
// 파일/디렉터리가 아직 디스크에 없어도 존재하는 상위 디렉터리의 심볼릭 링크를 정규화한다.
export function realPath(p: string): string {
  const abs = path.resolve(p);
  let dir = abs;
  const rest: string[] = [];
  while (!fs.existsSync(dir) && dir !== path.dirname(dir)) {
    rest.unshift(path.basename(dir));
    dir = path.dirname(dir);
  }
  try {
    return path.join(fs.realpathSync(dir), ...rest);
  } catch {
    return abs;
  }
}

export function buildHookPolicy(policy: Policy, dir: ExecDir, projectRoot: string, home = os.homedir()): HookPolicy {
  // Git 단계는 실행 시작의 위험 승인 범위다. 실행 중 ask로 원격 전송 승인을 우회하지 않는다.
  const gitWrite = policy.repository_edit === 'deny' || policy.shell_execution !== 'allow' ? 'deny' : (policy.git_write ?? 'deny');
  const hardDenyCommandPatterns = gitWrite === 'push' ? [] : gitWrite === 'local' ? [...GIT_REMOTE_PATTERNS] : [...GIT_LOCAL_PATTERNS, ...GIT_REMOTE_PATTERNS];
  const denyCommandPatterns: string[] = [...hardDenyCommandPatterns];
  if (policy.deployment_apply === 'deny') denyCommandPatterns.push(...DEPLOY_PATTERNS);
  if (policy.approval_mode === 'ask' && policy.shell_execution === 'deny') denyCommandPatterns.push('^');
  if (policy.shell_execution === 'read_only') denyCommandPatterns.push(...WRITE_SHELL_PATTERNS);
  return {
    ...(policy.approval_mode === 'ask' ? { approvalMode: 'ask' as const } : {}),
    writableRoots: (policy.repository_edit === 'allow' ? [projectRoot, dir.outputDir] : [dir.outputDir]).map(realPath),
    allowOutsideWrite: policy.outside_write === 'allow' && !(policy.approval_mode === 'ask' && policy.repository_edit === 'deny'),
    denyReadPaths: credentialPaths(home).flatMap((p) => {
      const rp = realPath(p);
      return rp !== p ? [p, rp] : [p];
    }),
    denyCommandPatterns,
    hardDenyCommandPatterns,
    readOnlyShell: policy.shell_execution === 'read_only',
    hookLog: dir.hookEventsPath,
    canaryPath: dir.canaryPath
  };
}

// 02 §6.4 claude-settings.json. 스키마에 어긋난 키가 하나라도 있으면 파일 전체가 무음 무시되므로(F1) 실측된 키만 쓴다.
export function buildClaudeSettings(policy: Policy, dir: ExecDir, hook: HookCommand, home = os.homedir()): Record<string, unknown> {
  const hookCmd = (sub: string) => `"${hook.node}" "${hook.cli}" hook ${sub} --policy "${dir.policyPath}"`;
  const readDeny = credentialPaths(home).flatMap((p) => {
    const rp = realPath(p);
    return rp !== p ? [`Read(//${p})`, `Read(//${rp})`] : [`Read(//${p})`];
  });
  const deny: string[] = [...readDeny];
  if (policy.network_outbound === 'deny') deny.push('WebFetch', 'WebSearch');
  if (policy.approval_mode !== 'ask' && policy.deployment_apply === 'deny') deny.push('Bash(aws *)', 'Bash(terraform apply *)', 'Bash(helm install *)', 'Bash(helm upgrade *)');
  if (policy.approval_mode !== 'ask' && policy.repository_edit === 'deny') deny.push('Edit', 'Write', 'NotebookEdit');
  if (policy.approval_mode !== 'ask' && policy.shell_execution === 'deny') deny.push('Bash');
  const settings: Record<string, unknown> = {
    permissions: {
      deny,
      // 정규식 번역 금지: hook 취소/allow 때도 모든 대상이 MCP를 거치도록 도구 전체를 묻는다.
      ...(policy.approval_mode === 'ask' ? { ask: [...APPROVAL_TOOLS] } : {}),
      disableBypassPermissionsMode: 'disable',
      additionalDirectories: [dir.inputDir, dir.outputDir]
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      failIfUnavailable: process.platform === 'darwin',
      network: policy.network_outbound === 'deny' ? { strictAllowlist: true, allowedDomains: [] } : {},
      filesystem: {
        // Baton 홈을 통째로 넣지 않는다 — 실행 디렉터리(<home>/executions/…)가 그 안에 있어
        // 첨부 읽기와 result.md 쓰기가 같이 막힌다. 비밀 파일은 credentialPaths() 가 이미 담고 있다.
        denyRead: Array.from(
          new Set([...credentialPaths(home), path.join(home, '.ssh'), path.join(home, '.aws')]),
        ),
      },
      credentials: {
        files: credentialPaths(home)
          .filter((p) => !p.endsWith('.ssh'))
          .map((p) => ({ path: p, mode: 'deny' }))
      }
    },
    hooks: {
      // SessionStart canary: 이 hook 이 canary.ok 를 만들지 않으면 settings 가 통째로 무시된 것 (F1)
      SessionStart: [{ hooks: [{ type: 'command', command: hookCmd('canary') }] }],
      PreToolUse: [{ matcher: 'Bash|Edit|Write|NotebookEdit|MultiEdit|Read|Grep|Glob', hooks: [{ type: 'command', command: hookCmd('pretool') }] }],
      PostToolUse: [{ matcher: 'Edit|Write|NotebookEdit|MultiEdit|Bash', hooks: [{ type: 'command', command: hookCmd('posttool') }] }]
    }
  };
  return settings;
}

// claude -p 인자 (02 §2.4)
/**
 * 웹에서 고른 값은 `<별칭>` 또는 `<별칭>:<강도>` 다 (common/models.ts 가 그렇게 싣는다).
 * 알 수 없는 강도는 버리고 모델만 쓴다 — 잘못된 인자는 claude 를 통째로 죽인다.
 */
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
export function splitClaudeModel(model: string): { model: string; effort: string | null } {
  const at = model.lastIndexOf(':');
  if (at <= 0) return { model, effort: null };
  const effort = model.slice(at + 1);
  return CLAUDE_EFFORTS.has(effort) ? { model: model.slice(0, at), effort } : { model, effort: null };
}

export function buildClaudeArgs(policy: Policy, dir: ExecDir, options: { sessionId: string; maxTurns: number; model: string; maxBudgetUsd?: number; resume?: boolean }): string[] {
  const allowed = ['Read', 'Glob', 'Grep'];
  if (policy.repository_edit === 'allow') allowed.push('Edit', 'Write');
  if (policy.shell_execution !== 'deny') allowed.push('Bash');
  const disallowed = ['Task', 'WebFetch', 'WebSearch'];
  if (policy.approval_mode !== 'ask' && policy.shell_execution === 'deny') disallowed.push('Bash');
  const { model: modelAlias, effort } = splitClaudeModel(options.model);
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-hook-events',
    '--max-turns',
    String(options.maxTurns),
    '--model',
    modelAlias,
    // 강도를 고르지 않으면 인자를 넣지 않는다. `--effort` 를 모르는 예전 claude 에서도
    // 기본 경로는 그대로 돈다 (알 수 없는 옵션이면 claude 가 exit 1 로 죽는다).
    ...(effort ? ['--effort', effort] : []),
    '--permission-mode',
    policy.approval_mode === 'ask' ? 'default' : policy.repository_edit === 'allow' ? 'acceptEdits' : 'default',
    '--permission-prompts',
    policy.approval_mode === 'ask' ? 'host' : 'none',
    '--settings',
    dir.settingsPath,
    '--append-system-prompt-file',
    dir.systemAppendPath,
    '--add-dir',
    dir.inputDir,
    dir.outputDir,
    ...(policy.approval_mode === 'ask' ? [] : ['--allowedTools', ...allowed]),
    '--disallowedTools',
    ...disallowed
  ];
  if (policy.approval_mode === 'ask') args.push('--permission-prompt-tool', 'mcp__baton_approval__approve', '--mcp-config', path.join(dir.root, 'approval-mcp.json'), '--strict-mcp-config');
  if (options.maxBudgetUsd) args.push('--max-budget-usd', String(options.maxBudgetUsd));
  args.push(options.resume ? '--resume' : '--session-id', options.sessionId);
  return args;
}
