import fs from 'node:fs';
import path from 'node:path';
import { HookPolicy } from './policy';

// `baton hook <canary|pretool|posttool> --policy <policy.json>` 진입점. claude 가 hook 으로 호출한다.
// stdin 으로 hook 입력 JSON 을 받고 stdout 으로 결정 JSON 을 낸다 (02 §6.4). 네트워크를 쓰지 않는다.
export interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  session_id?: string;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

function appendLog(file: string, entry: Record<string, unknown>): void {
  try {
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    // 로그 실패는 판정에 영향을 주지 않는다
  }
}

export function decidePreToolUse(policy: HookPolicy, input: HookInput): { decision: 'allow' | 'deny' | 'pass'; reason?: string; approvalAllowed?: false } {
  const tool = input.tool_name ?? '';
  const ti = input.tool_input ?? {};
  // 파일이 아직 없을 수 있으므로 존재하는 가장 가까운 상위 디렉터리의 실제 경로로 비교한다
  const canonical = (p: string) => {
    const abs = path.resolve(input.cwd ?? process.cwd(), p);
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
  };
  const inside = (p: string) => {
    const r = canonical(p);
    return policy.writableRoots.some((root) => r === root || r.startsWith(root + path.sep));
  };
  if (['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(tool)) {
    const fp = (ti.file_path as string | undefined) ?? (ti.notebook_path as string | undefined);
    if (fp && !policy.allowOutsideWrite && !inside(fp)) return { decision: 'deny', reason: `Baton policy: 프로젝트 밖 쓰기 금지 (${fp})` };
    return { decision: 'pass' };
  }
  if (['Read', 'Grep', 'Glob'].includes(tool)) {
    const fp =
      (ti.file_path as string | undefined) ??
      (ti.path as string | undefined) ??
      (ti.glob as string | undefined) ??
      (tool === 'Glob' && typeof ti.pattern === 'string' && path.isAbsolute(ti.pattern)
        ? ti.pattern
        : '');
    if (fp) {
      const r = canonical(fp);
      if (policy.denyReadPaths.some((d) => r === d || r.startsWith(d + path.sep))) {
        return { decision: 'deny', reason: `Baton policy: 자격증명 경로 읽기 금지 (${fp})` };
      }
    }
    return { decision: 'pass' };
  }
  if (tool === 'Bash') {
    const cmd = String(ti.command ?? '');
    // 인용된 실행 파일/서브명령과 셸 이스케이프도 Git 경계에서 보수적으로 검사한다.
    const gitCommand = cmd.replace(/[\"'\\]/g, '');
    for (const pattern of policy.hardDenyCommandPatterns ?? []) {
      if (new RegExp(pattern).test(gitCommand)) return { decision: 'deny', approvalAllowed: false, reason: 'Baton policy: git_write 단계 또는 셸·저장소 쓰기 제한으로 금지된 Git 작업' };
    }
    for (const pattern of policy.denyCommandPatterns) {
      if (new RegExp(pattern).test(cmd)) return { decision: 'deny', reason: `Baton policy: 차단된 명령 패턴 /${pattern}/` };
    }
    return { decision: 'pass' };
  }
  return { decision: 'pass' };
}

// 자격증명 읽기와 Git 단계는 예외 승인 불가. 나머지 정책 차단은 정적 ask/MCP가 재판정한다.
export function decideHook(policy: HookPolicy, input: HookInput) {
  const result = decidePreToolUse(policy, input);
  if (policy.approvalMode === 'ask' && result.decision === 'deny' && result.approvalAllowed !== false && !['Read', 'Grep', 'Glob'].includes(input.tool_name ?? '')) return { decision: 'pass' as const };
  return result;
}

export async function runHook(sub: string, policyPath: string): Promise<number> {
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as HookPolicy;
  const raw = await readStdin();
  let input: HookInput = {};
  try {
    input = raw ? (JSON.parse(raw) as HookInput) : {};
  } catch {
    input = {};
  }
  if (sub === 'canary') {
    fs.writeFileSync(policy.canaryPath, JSON.stringify({ ok: true, at: new Date().toISOString(), session_id: input.session_id ?? null }) + '\n');
    appendLog(policy.hookLog, { event: 'SessionStart', canary: true });
    process.stdout.write('{}\n');
    return 0;
  }
  if (sub === 'posttool') {
    appendLog(policy.hookLog, { event: 'PostToolUse', tool: input.tool_name, input: input.tool_input });
    process.stdout.write('{}\n');
    return 0;
  }
  if (sub === 'pretool') {
    const result = decideHook(policy, input);
    appendLog(policy.hookLog, { event: 'PreToolUse', tool: input.tool_name, input: input.tool_input, decision: result.decision, reason: result.reason });
    if (result.decision === 'deny') {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } }) + '\n');
    } else {
      process.stdout.write('{}\n');
    }
    return 0;
  }
  process.stderr.write(`unknown hook subcommand: ${sub}\n`);
  return 2;
}
