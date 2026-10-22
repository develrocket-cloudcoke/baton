import { independentlyGatedRunner } from '../execution-gate';
import fs from 'node:fs';
import type { AgentAdapter, AdapterCapabilities } from '../interface';
import { DAEMON_VERSION } from '../../util/version';
import { probeVersion } from '../common/probe';
import { agyModels } from '../common/models';
import { AgyRunner, AgyRunOptions } from './runner';

export class AgyAdapter implements AgentAdapter {
  readonly provider = 'AGY' as const;

  constructor(private readonly options: AgyRunOptions = {}) {}

  async detect() {
    const defaultBinary = fs.existsSync('/opt/homebrew/bin/agy')
      ? '/opt/homebrew/bin/agy'
      : 'agy';
    const binaryPath = this.options.agyPath ?? process.env.BATON_AGY_PATH ?? defaultBinary;

    return probeVersion(binaryPath);
  }

  async listModels() {
    const defaultBinary = fs.existsSync('/opt/homebrew/bin/agy') ? '/opt/homebrew/bin/agy' : 'agy';
    return agyModels(this.options.agyPath ?? process.env.BATON_AGY_PATH ?? defaultBinary);
  }

  getCapabilities(): AdapterCapabilities {
    return {
      provider: this.provider,
      displayName: 'Antigravity',
      version: DAEMON_VERSION,
      supportsResume: true,
      supportsStructuredProgress: true,
      supportsCancel: true,
      supportsLayer1Patch: false,
      securityTier: 'tier_c_unrestricted',
      supportedPolicyEnforcements: {
        toolDeny: false,
        networkDeny: false,
        destructiveCommandDeny: false,
        credentialPathDeny: false
      }
    };
  }

  createRunner() {
    return independentlyGatedRunner(this, new AgyRunner(this.options));
  }
}

export { AgyRunner } from './runner';
export type { AgyRunOptions } from './runner';
