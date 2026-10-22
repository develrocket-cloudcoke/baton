import { approveTool, startApprovalBridge } from './approval-mcp';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ExecutionContext as RunSpec, ExecutionRunResult as RunResult, RunOutcome } from '../interface';
export type { ExecutionContext as RunSpec, ExecutionRunResult as RunResult, RunOutcome } from '../interface';
import { logger } from '../../util/log';
import { CollectedResult, collectAll, gitBaseline } from './collector';
import { attachmentPath, ExecDir, makeExecDir } from './exec-dir';
import { buildClaudeArgs, buildClaudeSettings, buildHookPolicy, realPath } from './policy';
import { renderFollowUpPrompt, renderPrompt, renderSystemAppend } from './prompt';
import { ProgressEvent, StreamMapper } from './stream-mapper';
import { buildChildEnv } from '../env-whitelist';

export interface RunOptions {
  approvalSocket?: string;
  home?: string;
  claudePath?: string;
  hook: { node: string; cli: string };
  downloader?: (url: string, dest: string, sha256?: string) => Promise<void>;
  onProgress?: (ev: ProgressEvent) => void;
  canaryTimeoutMs?: number;
  onLogChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

type Json = Record<string, unknown>;

// 우리가 항상 넘기는 플래그들. claude 버전이 낮아 없는 플래그가 있으면 spawn 이
// exit 1 로 죽고 사유는 "unknown option '--permission-prompts'" 한 줄뿐이라, 받는
// 사람은 무엇을 해야 하는지 알 수 없다 (2026-09-18 테스터 실사용). 미리 확인해
// 조치까지 알려 준다.
//
// 주의: --help 에 안 보이지만 정상 동작하는 플래그가 있다(claude 2.1.263 에서
// --append-system-prompt-file 이 그렇다). 그런 플래그를 여기 넣으면 잘 되는 환경까지
// 전부 막힌다. **동작이 검증된 버전의 --help 에 실제로 보이는 것만** 넣는다.
const REQUIRED_CLAUDE_FLAGS = [
  '--permission-prompts',
  '--permission-mode',
  '--include-hook-events',
  '--settings',
  '--add-dir',
  '--allowedTools',
  '--disallowedTools'
];

let helpCache: { path: string; text: string } | null = null;

/// 이 claude 가 지원하지 않는 플래그 목록. 판정 자체가 실패하면(--help 도 안 되는 경우)
/// 빈 배열을 돌려 기존 경로로 진행한다 — 여기서 실행을 막아 버리면 판정 실패가
/// 곧 기능 정지가 된다.
export async function unsupportedClaudeFlags(claudePath: string): Promise<string[]> {
  if (helpCache?.path !== claudePath) {
    try {
      const { stdout, stderr } = await promisify(execFile)(claudePath, ['--help'], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
      helpCache = { path: claudePath, text: `${stdout}\n${stderr}` };
    } catch (e) {
      logger.warn('claude --help 실패 — 플래그 사전 점검을 건너뜁니다', { message: String(e) });
      return [];
    }
  }
  const text = helpCache!.text;
  return REQUIRED_CLAUDE_FLAGS.filter((flag) => !text.includes(flag));
}

async function claudeVersion(claudePath: string): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)(claudePath, ['--version'], { timeout: 5_000 });
    return stdout.trim() || '알 수 없음';
  } catch {
    return '알 수 없음';
  }
}

/// 설치돼 있는 claude 실행 파일 **전부**. 한 대에 여러 사본이 있는 경우가 흔하다
/// (Homebrew + npm -g). GUI 앱은 PATH 가 빈약해서 앞의 고정 경로들이 사실상 전부다.
export function findClaudeCandidates(): string[] {
  const candidates = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', path.join(os.homedir(), '.local', 'bin', 'claude')];
  for (const p of (process.env.PATH ?? '').split(':')) if (p) candidates.push(path.join(p, 'claude'));
  const seen = new Set<string>();
  return candidates.filter((p) => fs.existsSync(p) && !seen.has(p) && seen.add(p));
}

export function findClaude(): string | null {
  return findClaudeCandidates()[0] ?? null;
}

/// 여러 사본 중 **필요한 플래그를 지원하는** 것을 고른다. 고정 순서로 첫 사본을 집으면,
/// 사용자가 다른 사본을 업데이트해도 데몬은 계속 낡은 것을 실행한다 — 터미널에서는
/// 새 버전이 잡히는데 앱에서만 `unknown option` 으로 죽어 원인을 찾기 어렵다
/// (2026-09-18: 테스터가 claude update 를 한 뒤에도 같은 오류가 반복됐다).
export async function pickClaude(
  candidates: string[]
): Promise<{ path: string } | { error: string }> {
  const report: string[] = [];
  for (const candidate of candidates) {
    const missing = await unsupportedClaudeFlags(candidate);
    if (missing.length === 0) return { path: candidate };
    report.push(`${candidate} (${await claudeVersion(candidate)}) — 미지원: ${missing.join(', ')}`);
  }
  return {
    error:
      `설치된 claude 중 필요한 플래그를 지원하는 것이 없습니다:\n${report.join('\n')}\n` +
      'claude 를 최신으로 업데이트하세요: claude update (또는 npm i -g @anthropic-ai/claude-code). ' +
      '사본이 여러 개면 위에 적힌 경로의 것을 업데이트해야 합니다.'
  };
}

// §18 추가 작업이면 이어가기 프롬프트를 쓴다. 실행 디렉터리는 executionId 마다 따로이므로
// 이전 회차의 prompt.md·result.md·stream.jsonl 은 덮이지 않고 그대로 남는다.
export function isFollowUp(spec: RunSpec): boolean {
  return !!spec.resumeSessionId?.trim();
}

// 실행 준비: 디렉터리·첨부·프롬프트·설정 렌더링 (02 §9.2 의 prepare)
export async function prepare(spec: RunSpec, options: RunOptions): Promise<ExecDir> {
  const dir = makeExecDir(spec.executionId, options.home);
  for (const att of spec.attachments) {
    const dest = attachmentPath(dir, att);
    if (options.downloader) await options.downloader(att.downloadUrl, dest, att.sha256);
  }
  const input = { ...spec, projectRoot: spec.projectRoot };
  fs.writeFileSync(dir.promptPath, isFollowUp(spec) ? renderFollowUpPrompt(input, dir) : renderPrompt(input, dir));
  fs.writeFileSync(dir.systemAppendPath, renderSystemAppend(spec.policy, dir, spec.projectRoot));
  fs.writeFileSync(dir.policyPath, JSON.stringify(buildHookPolicy(spec.policy, dir, spec.projectRoot), null, 2));
  fs.writeFileSync(dir.settingsPath, JSON.stringify(buildClaudeSettings(spec.policy, dir, options.hook), null, 2));
  if (spec.policy.approval_mode === 'ask') {
    if (!options.approvalSocket) throw new Error('ask 실행에는 승인 중계가 필요합니다.');
    fs.writeFileSync(path.join(dir.root, 'approval-mcp.json'), JSON.stringify({ mcpServers: { baton_approval: { command: options.hook.node, args: [options.hook.cli, 'approval-mcp', '--socket', options.approvalSocket] } } }), { mode: 0o600 });
  }
  if (fs.existsSync(dir.canaryPath)) fs.unlinkSync(dir.canaryPath);
  return dir;
}

// claude 프로세스 1회 실행의 원재료 (run() 이 resume 실패 시 한 번 더 부른다)
interface AttemptResult {
  exitCode: number | null;
  rawEvents: Json[];
  resultEvent: Json | null;
  canaryFailed: boolean;
  stderrText: string;
  // stream-json system/init 에서 읽은 세션 id. init 자체가 없으면 null(= 세션을 열지 못함)
  observedSessionId: string | null;
  sawInit: boolean;
}

export class ClaudeRunner {
  private child: ReturnType<typeof spawn> | null = null;
  private cancelled = false;
  private approvalAbort?: AbortController;

  get isCancelled(): boolean {
    return this.cancelled;
  }

  // 실행 취소 (execution.command.cancel_requested): SIGTERM → 유예 후 SIGKILL.
  // 02 §2.3-5: SIGTERM 이면 claude 는 exit 143, 진행 중이던 Bash 는 137 로 죽고 그 턴은 미완으로 남는다.
  cancel(graceMs = Number(process.env.BATON_CANCEL_GRACE_MS ?? 5_000)): void {
    this.cancelled = true;
    this.approvalAbort?.abort();
    const child = this.child;
    if (!child) return;
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        logger.warn('claude 가 SIGTERM 으로 끝나지 않아 SIGKILL', { pid: child.pid });
        child.kill('SIGKILL');
      }
    }, graceMs).unref();
  }

  // 셸 종료(daemon.shutdown, stdin EOF): 04 §3.4 는 자식에게 SIGINT 를 보내라고 정한다.
  interrupt(): void {
    this.cancelled = true;
    this.approvalAbort?.abort();
    this.child?.kill('SIGINT');
    setTimeout(() => this.child?.kill('SIGTERM'), 10_000).unref();
  }

  // claude 1회 실행: spawn → stream-json 파싱 → 진행 이벤트 → 종료. 결과 판정은 run() 이 한다.
  private attempt(spec: RunSpec, options: RunOptions, dir: ExecDir, claude: string, args: string[], emit: (ev: ProgressEvent) => void): Promise<AttemptResult> {
    const env = buildChildEnv('claude-code', process.env);
    // 테스트용 가짜 claude(.mjs/.js) 는 node 로 실행한다
    const isScript = /\.(m?js)$/.test(claude);
    const child = spawn(isScript ? process.execPath : claude, isScript ? [claude, ...args] : args, { cwd: spec.projectRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdin!.end(fs.readFileSync(dir.promptPath));
    logger.info('claude spawned', { executionId: spec.executionId, pid: child.pid, resume: args.includes('--resume') });

    const streamOut = fs.createWriteStream(dir.streamPath, { flags: 'a' });
    const mapper = new StreamMapper({ projectRoot: spec.projectRoot, inputDir: dir.inputDir, outputDir: dir.outputDir });
    const state: AttemptResult = { exitCode: null, rawEvents: [], resultEvent: null, canaryFailed: false, stderrText: '', observedSessionId: null, sawInit: false };
    let canaryChecked = false;
    let buffer = Buffer.alloc(0);

    const handleLine = (line: string) => {
      streamOut.write(line + '\n');
      let ev: Json;
      try {
        ev = JSON.parse(line) as Json;
      } catch {
        return;
      }
      state.rawEvents.push(ev);
      if (ev.type === 'result') state.resultEvent = ev;
      let canaryOk = false;
      if (ev.type === 'system' && ev.subtype === 'init') {
        // 02 §2.4: 세션 id 의 진짜 출처는 init 이벤트다 (--resume 은 우리가 준 id 를 그대로 쓰지 않을 수 있다)
        state.sawInit = true;
        if (typeof ev.session_id === 'string' && ev.session_id) state.observedSessionId = ev.session_id;
        if (!canaryChecked) {
          // F1: SessionStart canary hook 이 canary.ok 를 만들지 않았으면 settings 가 무음 무시된 것 → fail-closed
          canaryChecked = true;
          if (!fs.existsSync(dir.canaryPath)) {
            state.canaryFailed = true;
            logger.error('settings canary 미기록 — --settings 무시 의심, 실행 중단', { executionId: spec.executionId });
            emit({ phase: 'failed', message: 'settings canary 미기록 (보안 정책 미적용) — 실행 중단' });
            child.kill('SIGKILL');
            return;
          }
          canaryOk = true;
        }
      }
      for (const p of mapper.map(ev)) emit(p);
      if (canaryOk) emit({ phase: 'note', message: 'settings canary OK (hooks/sandbox 적용됨)' });
    };
    child.stdout!.on('data', (chunk: Buffer) => {
      options.onLogChunk?.(chunk.toString('utf8'), 'stdout');
      buffer = Buffer.concat([buffer, chunk]);
      let nl: number;
      while ((nl = buffer.indexOf(0x0a)) >= 0) {
        const line = buffer.subarray(0, nl).toString('utf8');
        buffer = buffer.subarray(nl + 1);
        if (line.trim()) handleLine(line);
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      options.onLogChunk?.(chunk.toString('utf8'), 'stderr');
      state.stderrText += chunk.toString('utf8');
      if (state.stderrText.length > 8000) state.stderrText = state.stderrText.slice(-8000);
    });

    return new Promise<AttemptResult>((resolve) => {
      child.on('close', (code) => {
        if (buffer.length) handleLine(buffer.toString('utf8'));
        streamOut.end();
        state.exitCode = code;
        resolve(state);
      });
    });
  }

  async run(input: RunSpec, options: RunOptions): Promise<RunResult> {
    if (input.policy.approval_mode !== 'ask') return this.runInternal(input, options);
    if (!input.approvalRequest) throw new Error('ask 실행에 승인 API가 없습니다.');
    const dir = makeExecDir(input.executionId, options.home);
    const policy = buildHookPolicy(input.policy, dir, input.projectRoot);
    const controller = new AbortController();
    this.approvalAbort = controller;
    if (this.cancelled) controller.abort();
    const bridge = await startApprovalBridge(args => approveTool(policy, input.projectRoot, input.executionId, args, input.approvalRequest, controller.signal));
    try { return await this.runInternal(input, { ...options, approvalSocket: bridge.socket }); }
    finally { controller.abort(); await bridge.close(); this.approvalAbort = undefined; }
  }

  private async runInternal(input: RunSpec, options: RunOptions): Promise<RunResult> {
    // 프로젝트 경로는 실제 경로로 정규화한다 (hook 의 경로 비교, 계층1 필터가 같은 기준을 쓰도록)
    const spec: RunSpec = { ...input, projectRoot: realPath(input.projectRoot) };
    const dir = await prepare(spec, options);
    const claudeCandidates = options.claudePath ? [options.claudePath] : findClaudeCandidates();
    const resumedFrom = isFollowUp(spec) ? spec.resumeSessionId!.trim() : null;
    let sessionId = resumedFrom ?? spec.sessionId ?? randomUUID();
    let resumeFallback = false;
    const startedAt = Date.now();
    const manifest: Json = { executionId: spec.executionId, projectRoot: spec.projectRoot, sessionId, resumedFrom, policy: spec.policy, startedAt: new Date(startedAt).toISOString() };
    const fail = (reason: string, exitCode: number | null): RunResult => {
      manifest.failureReason = reason;
      fs.writeFileSync(dir.manifestPath, JSON.stringify(manifest, null, 2));
      return { outcome: 'failed', exitCode, failureReason: reason, dir, sessionId, resumedFrom, resumeFallback, numTurns: null, costUsd: null, durationMs: Date.now() - startedAt, collected: collectAll(dir, spec.projectRoot, [], null, null), manifest };
    };
    if (claudeCandidates.length === 0) return fail('claude 실행 파일을 찾을 수 없음', null);
    if (!fs.existsSync(spec.projectRoot)) return fail(`프로젝트 경로 없음: ${spec.projectRoot}`, null);
    const picked = await pickClaude(claudeCandidates);
    if ('error' in picked) return fail(picked.error, null);
    const claude = picked.path;
    if (claudeCandidates.length > 1)
      logger.info('claude 사본 여럿 — 플래그를 지원하는 것을 선택', { picked: claude, candidates: claudeCandidates });

    const limits = { maxTurns: spec.maxTurns ?? 60, model: spec.model ?? 'sonnet', maxBudgetUsd: spec.maxBudgetUsd };
    let args = buildClaudeArgs(spec.policy, dir, { ...limits, sessionId, resume: resumedFrom !== null });
    manifest.claudeArgs = args;
    // 계층2 기준점은 **이번 회차 시작 시점**이다. §18 추가 작업이어도 이전 회차 변경이 다시 섞이지 않는다.
    const baseline = gitBaseline(spec.projectRoot, dir.gitIndexPath);
    manifest.gitBaseline = baseline;

    const eventsOut = fs.createWriteStream(dir.eventsPath, { flags: 'a' });
    const progress: ProgressEvent[] = [];
    let seq = 0;
    const emit = (ev: ProgressEvent) => {
      seq += 1;
      eventsOut.write(JSON.stringify({ seq, ts: new Date().toISOString(), ...ev }) + '\n');
      progress.push(ev);
      options.onProgress?.(ev);
    };

    let att = await this.attempt(spec, options, dir, claude, args, emit);
    // 세션 만료·삭제로 --resume 이 실패하면 claude 는 `system/init` 을 내지 않는다. 새 세션으로 원본 맥락을 다시 실어 한 번만 재시도한다.
    // 판정 기준은 **init 부재** 하나뿐이다(실측 2026-09-11): 실제 claude 는 없는 세션을 resume 하면 init 없이
    //   {"type":"result","subtype":"error_during_execution","errors":["No conversation found with session ID: …"]}
    // 를 내보내고 exit 1 로 끝난다. 그래서 "result 이벤트도 없어야 한다" 를 조건에 넣으면 이 경로를 놓친다.
    // 반대로 세션을 열었다면 무슨 오류가 나도 init 이 먼저 오므로, init 이 있으면 폴백하지 않는다.
    if (resumedFrom && !att.sawInit && !att.canaryFailed && !this.cancelled) {
      resumeFallback = true;
      const resultErrors = Array.isArray((att.resultEvent as Json | null)?.errors) ? ((att.resultEvent as Json).errors as unknown[]).map(String) : [];
      const why = (resultErrors[0] || att.stderrText.trim().split('\n').slice(-1)[0] || `exit ${String(att.exitCode)}`).slice(0, 200);
      logger.warn('--resume 실패 — 새 세션으로 원본 맥락을 다시 싣고 재시도', { executionId: spec.executionId, resumedFrom, why });
      emit({ phase: 'warning', message: `이전 세션(${resumedFrom.slice(0, 8)}…)을 이어갈 수 없어(만료·삭제 추정) 원본 요청 맥락을 다시 싣고 새 세션으로 실행합니다: ${why}`, detail: { resumedFrom, reason: why } });
      sessionId = spec.sessionId ?? randomUUID();
      fs.writeFileSync(dir.promptPath, renderPrompt({ ...spec, resumeFailed: true }, dir));
      args = buildClaudeArgs(spec.policy, dir, { ...limits, sessionId, resume: false });
      manifest.resumeFallback = { resumedFrom, reason: why, exitCode: att.exitCode, newSessionId: sessionId, claudeArgs: args };
      if (fs.existsSync(dir.canaryPath)) fs.unlinkSync(dir.canaryPath);
      att = await this.attempt(spec, options, dir, claude, args, emit);
    }
    eventsOut.end();
    if (att.observedSessionId) sessionId = att.observedSessionId;
    manifest.sessionId = sessionId;

    const durationMs = Date.now() - startedAt;
    const r = att.resultEvent as Json | null;
    const finalText = r && typeof r.result === 'string' ? (r.result as string) : null;
    const collected = collectAll(dir, spec.projectRoot, att.rawEvents, baseline, finalText);

    let outcome: RunOutcome;
    let failureReason: string | null = null;
    if (att.canaryFailed) {
      outcome = 'failed';
      failureReason = 'settings canary 미기록: 보안 정책(hooks/sandbox)이 적용되지 않아 실행을 중단함 (F1)';
    } else if (this.cancelled) {
      outcome = 'cancelled';
    } else if (r && r.subtype === 'success') {
      outcome = 'success';
    } else if (r && r.subtype === 'error_max_turns') {
      outcome = 'partial';
    } else if (r) {
      outcome = 'failed';
      failureReason = `claude result ${String(r.subtype)}`;
    } else {
      outcome = 'failed';
      failureReason = `claude 비정상 종료 (exit ${String(att.exitCode)}): ${att.stderrText.trim().slice(-500) || 'result 이벤트 없음'}`;
      if (resumedFrom && !att.sawInit) failureReason = `이전 세션(${resumedFrom}) 이어가기 실패 후 새 세션 실행도 실패함 — ${failureReason}`;
    }
    Object.assign(manifest, {
      endedAt: new Date().toISOString(),
      durationMs,
      exitCode: att.exitCode,
      outcome,
      failureReason,
      stderr: att.stderrText.slice(-4000),
      result: r ? { subtype: r.subtype, num_turns: r.num_turns, total_cost_usd: r.total_cost_usd, usage: r.usage, permission_denials: r.permission_denials } : null,
      layer1: { files: collected.layer1.files, patchBytes: collected.layer1.patch.length },
      layer2: collected.layer2 ? { changed: collected.layer2.changed, patchBytes: collected.layer2.patch.length } : null,
      layer3: collected.resultMd ? { bytes: collected.resultMd.length } : null
    });
    fs.writeFileSync(dir.manifestPath, JSON.stringify(manifest, null, 2));
    return {
      outcome,
      exitCode: att.exitCode,
      failureReason,
      dir,
      sessionId,
      resumedFrom,
      resumeFallback,
      numTurns: r ? Number(r.num_turns ?? 0) : null,
      costUsd: r ? Number(r.total_cost_usd ?? 0) : null,
      durationMs,
      collected,
      manifest
    };
  }
}
