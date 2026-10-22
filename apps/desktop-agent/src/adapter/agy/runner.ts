import { gitPreflight } from '../common/git-preflight';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type {
  AgentRunner,
  ExecutionContext,
  ExecutionRunResult,
  ProgressEvent,
  RunnerCallbacks
} from '../interface';
import { attachmentPath, makeExecDir } from '../claude-code/exec-dir';
import { gitBaseline } from '../claude-code/collector';
import { collectAgy } from './collector';
import { buildAgyArgs, agyPolicyError } from './policy';
import { renderCliPrompt } from '../common/prompt';
import { AgyStreamMapper } from './stream-mapper';
import { buildChildEnv } from '../env-whitelist';

export interface AgyRunOptions {
  home?: string;
  agyPath?: string;
  downloader?: (url: string, dest: string, sha256?: string) => Promise<void>;
  timeoutMs?: number;
}

export class AgyRunner implements AgentRunner {
  private child: ReturnType<typeof spawn> | null = null;
  private cancelled = false;

  get isCancelled(): boolean {
    return this.cancelled;
  }

  // 별도 프로세스 그룹에 SIGTERM→SIGKILL을 보내 도구 자식 프로세스까지 완전 정리한다.
  private signal(signal: NodeJS.Signals): void {
    if (!this.child?.pid) return;
    try {
      process.kill(-this.child.pid, signal);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
    }
  }

  cancel(graceMs = Number(process.env.BATON_CANCEL_GRACE_MS ?? 5_000)): void {
    this.cancelled = true;
    this.signal('SIGTERM');
    const child = this.child;
    setTimeout(() => {
      if (this.child === child) this.signal('SIGKILL');
    }, graceMs).unref();
  }

  interrupt(): void {
    this.cancelled = true;
    this.signal('SIGINT');
    const child = this.child;
    setTimeout(() => {
      if (this.child === child) this.signal('SIGKILL');
    }, 10_000).unref();
  }

  constructor(private readonly options: AgyRunOptions = {}) {}

  async run(input: ExecutionContext, callbacks: RunnerCallbacks): Promise<ExecutionRunResult> {
    const dir = makeExecDir(input.executionId, this.options.home);
    const ctx = { ...input, projectRoot: fs.realpathSync(input.projectRoot) };
    const startedAt = Date.now();
    const gitFailure = gitPreflight(ctx.projectRoot);
    const baseline = gitFailure ? null : gitBaseline(ctx.projectRoot, dir.gitIndexPath);
    let sessionId = '';
    let completed = false;
    let failureReason = agyPolicyError(ctx);
    const failureCode = failureReason ? undefined : gitFailure?.code;
    failureReason ??= gitFailure?.reason ?? null;

    if (!baseline?.tree && !failureReason) {
      failureReason = 'Antigravity 결과 수집에는 Git 작업 트리 스냅샷이 필요합니다';
    }

    let finalText: string | null = null;
    let exitCode: number | null = null;
    let turns = 0;
    let stderr = '';
    let usage: unknown = null;
    let seq = 0;

    const emit = (event: ProgressEvent) => {
      fs.appendFileSync(
        dir.eventsPath,
        JSON.stringify({ seq: ++seq, ts: new Date().toISOString(), ...event }) + '\n'
      );
      callbacks.onProgress(event);
    };

    fs.writeFileSync(dir.policyPath, JSON.stringify(ctx.policy, null, 2));
    fs.writeFileSync(dir.streamPath, '');

    let args: string[] = [];

    if (!failureReason && !this.cancelled) {
      for (const att of ctx.attachments) {
        if (!this.options.downloader) throw new Error('첨부 다운로드 기능이 없습니다');
        await this.options.downloader(att.downloadUrl, attachmentPath(dir, att), att.sha256);
      }

      // CLO-110 H-4: agy CLI 에는 시스템 프롬프트 주입 수단이 없다(--help 실측 1.2.1).
      // 그래서 규약을 프롬프트 최상단 고정 구획으로 넣고, 요청 본문·제목은 경계 표식으로 감싼다.
      const built = renderCliPrompt(ctx, dir, { writesResultFile: true });
      const prompt = built.prompt;
      fs.writeFileSync(dir.promptPath, prompt);
      fs.writeFileSync(dir.systemAppendPath, built.contract);
      if (built.tampered) {
        emit({
          phase: 'warning',
          message: '요청 본문·제목에 신뢰 경계 표식을 흉내 낸 문자열이 있어 무력화했습니다 (프롬프트 인젝션 시도 의심)'
        });
      }

      args = buildAgyArgs(ctx, prompt, this.options.timeoutMs);

      const defaultAgyBinary = fs.existsSync('/opt/homebrew/bin/agy')
        ? '/opt/homebrew/bin/agy'
        : 'agy';
      const binary = this.options.agyPath ?? process.env.BATON_AGY_PATH ?? defaultAgyBinary;
      const script = /\.(m?js)$/.test(binary);
      const env = buildChildEnv('agy', process.env);

      const child = spawn(
        script ? process.execPath : binary,
        script ? [binary, ...args] : args,
        {
          cwd: ctx.projectRoot,
          env,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe']
        }
      );
      this.child = child;

      const decoder = new StringDecoder('utf8');
      const mapper = new AgyStreamMapper();
      let buffer = '';

      const processLine = (text: string) => {
        if (!text.trim()) return;
        fs.appendFileSync(dir.streamPath, text + '\n');
        let event: Record<string, any>;
        try {
          event = JSON.parse(text);
        } catch {
          return;
        }
        if (!event || typeof event !== 'object' || Array.isArray(event)) return;

        if (event.event === 'init' && typeof event.conversation_id === 'string') {
          sessionId = event.conversation_id;
          if (ctx.resumeSessionId && sessionId !== ctx.resumeSessionId) {
            failureReason = 'Antigravity resume가 다른 세션을 반환하여 중단했습니다';
            this.signal('SIGKILL');
          }
        }

        if (event.event === 'result' && event.result) {
          completed = true;
          if (typeof event.result.num_turns === 'number') turns = event.result.num_turns;
          if (event.result.usage) usage = event.result.usage;
          if (typeof event.result.response === 'string') finalText = event.result.response;
          if (event.result.status && event.result.status !== 'SUCCESS') {
            failureReason = String(event.result.error ?? `Antigravity 상태: ${event.result.status}`);
          }
        }

        for (const p of mapper.map(event)) {
          emit(p);
        }
      };

      child.stdout!.on('data', (chunk: Buffer) => {
        callbacks.onLogChunk?.(chunk.toString('utf8'), 'stdout');
        buffer += decoder.write(chunk);
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          processLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      });

      child.stderr!.on('data', (chunk: Buffer) => {
        callbacks.onLogChunk?.(chunk.toString('utf8'), 'stderr');
        stderr = (stderr + chunk.toString('utf8')).slice(-8_000);
      });

      child.stdin!.on('error', () => undefined);

      const timeout = setTimeout(() => {
        failureReason = 'Antigravity 실행 시간 제한 초과';
        this.signal('SIGKILL');
      }, this.options.timeoutMs ?? 10 * 60_000);

      try {
        exitCode = await new Promise<number | null>((resolve) => {
          child.on('error', (e) => {
            failureReason = e.message;
            resolve(null);
          });
          child.on('close', (code) => resolve(code));
          if (this.cancelled) {
            this.signal('SIGTERM');
          }
          child.stdin!.end();
        });
      } finally {
        clearTimeout(timeout);
        buffer += decoder.end();
        if (buffer.trim()) processLine(buffer);
        this.signal('SIGKILL');
        this.child = null;
      }
    }

    if (!this.cancelled && !failureReason && (!completed || exitCode !== 0 || !sessionId)) {
      failureReason = `Antigravity 비정상 종료 (exit ${exitCode}): ${stderr.slice(-1000) || 'result 또는 conversation_id 없음'}`;
    }

    if (finalText) {
      fs.writeFileSync(dir.resultMdPath, finalText);
    }

    const collected = collectAgy(dir, ctx.projectRoot, baseline, finalText);
    const outcome = this.cancelled ? 'cancelled' : failureReason ? 'failed' : 'success';

    emit({
      phase: outcome === 'success' ? 'finished' : outcome === 'cancelled' ? 'cancelled' : 'failed',
      message: failureReason ?? (outcome === 'success' ? 'Antigravity 작업 완료' : 'Antigravity 작업 취소')
    });

    const durationMs = Date.now() - startedAt;
    const manifest = {
      provider: 'AGY',
      executionId: ctx.executionId,
      args,
      projectRoot: ctx.projectRoot,
      outcome,
      exitCode,
      failureReason,
      failureCode,
      sessionId,
      resumedFrom: ctx.resumeSessionId ?? null,
      resumeFallback: false,
      gitBaseline: baseline,
      usage,
      stderr,
      durationMs
    };
    fs.writeFileSync(dir.manifestPath, JSON.stringify(manifest, null, 2));

    return {
      outcome,
      exitCode,
      failureReason,
      failureCode,
      dir,
      sessionId,
      resumedFrom: ctx.resumeSessionId ?? null,
      resumeFallback: false,
      numTurns: turns,
      costUsd: null,
      durationMs,
      collected,
      manifest
    };
  }
}
