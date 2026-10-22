import { independentlyGatedRunner } from '../execution-gate';
import { probeVersion } from '../common/probe';
import { claudeCodeModels } from '../common/models';
import type { AgentAdapter, AgentRunner, AdapterCapabilities, ExecutionContext, ExecutionRunResult, RunnerCallbacks } from '../interface';
import { DAEMON_VERSION } from '../../util/version';
import { ClaudeRunner, findClaude, RunOptions } from './runner';

// 기존 실행 루프에 위임해 정책·파싱·수집·resume·취소 순서와 판정을 그대로 유지한다.
export class ClaudeCodeRunner implements AgentRunner {
  private readonly runner = new ClaudeRunner();

  constructor(private readonly options: RunOptions) {}

  get isCancelled(): boolean { return this.runner.isCancelled; }
  cancel(graceMs?: number): void { this.runner.cancel(graceMs); }
  interrupt(): void { this.runner.interrupt(); }

  run(ctx: ExecutionContext, callbacks: RunnerCallbacks): Promise<ExecutionRunResult> {
    return this.runner.run(ctx, { ...this.options, ...callbacks });
  }
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly provider = 'CLAUDE_CODE' as const;

  constructor(private readonly options: RunOptions) {}

  // 탐지는 명시적으로 호출할 때만 수행한다. 연결 시 새 인증 호출이나 실행 게이트를 추가하지 않는다.
  async detect(): Promise<{ available: boolean; binaryPath?: string; version?: string; reason?: string }> {
    const binaryPath = this.options.claudePath ?? findClaude();
    if (!binaryPath) return { available: false, reason: 'claude 실행 파일을 찾을 수 없음' };
    return probeVersion(binaryPath);
  }

  async listModels() {
    return claudeCodeModels(this.options.claudePath ?? findClaude() ?? 'claude');
  }

  getCapabilities(): AdapterCapabilities {
    return {
      provider: this.provider,
      displayName: 'Claude Code',
      version: DAEMON_VERSION,
      supportsResume: true,
      supportsStructuredProgress: true,
      supportsCancel: true,
      supportsLayer1Patch: true,
      securityTier: 'tier_a_hardened',
      supportedPolicyEnforcements: { toolDeny: true, networkDeny: true, destructiveCommandDeny: true, credentialPathDeny: true }
    };
  }

  createRunner(): AgentRunner { return independentlyGatedRunner(this, new ClaudeCodeRunner(this.options)); }
}
