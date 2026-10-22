import { independentlyGatedRunner } from '../execution-gate';
import type { AgentAdapter, AdapterCapabilities } from '../interface';
import { DAEMON_VERSION } from '../../util/version';
import { probeVersion } from '../common/probe';
import { codexModels } from '../common/models';
import { CodexRunner, CodexRunOptions } from './runner';

export class CodexAdapter implements AgentAdapter {
  readonly provider = 'CODEX' as const;
  constructor(private readonly options: CodexRunOptions = {}) {}
  async detect() {
    const binaryPath = this.options.codexPath ?? process.env.BATON_CODEX_PATH ?? 'codex';
    return probeVersion(binaryPath);
  }
  async listModels() {
    return codexModels(this.options.codexPath ?? process.env.BATON_CODEX_PATH ?? 'codex');
  }

  getCapabilities(): AdapterCapabilities {
    return { provider: this.provider, displayName: 'Codex', version: DAEMON_VERSION,
      supportsResume: true, supportsStructuredProgress: true, supportsCancel: true, supportsLayer1Patch: false,
      securityTier: 'tier_b_sandboxed',
      supportedPolicyEnforcements: { toolDeny: false, networkDeny: true, destructiveCommandDeny: false, credentialPathDeny: false } };
  }
  createRunner() { return independentlyGatedRunner(this, new CodexRunner(this.options)); }
}
export { CodexRunner } from './runner';
