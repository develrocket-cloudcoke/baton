import { ClaudeCodeAdapter } from './claude-code/adapter';
import type { RunOptions } from './claude-code/runner';
import { CodexAdapter } from './codex';
import { AgyAdapter } from './agy';
import { AgentAdapterRegistry } from './registry';

// 현재 제품 기본 provider는 그대로 두고 구체 구현 선택은 이 조립 지점에만 둔다.
export function createDefaultAdapterRegistry(
  options: RunOptions & { codexPath?: string; agyPath?: string }
): AgentAdapterRegistry {
  return new AgentAdapterRegistry([
    new ClaudeCodeAdapter(options),
    new CodexAdapter({ home: options.home, downloader: options.downloader, codexPath: options.codexPath }),
    new AgyAdapter({ home: options.home, downloader: options.downloader, agyPath: options.agyPath })
  ]);
}
export { AgyAdapter } from './agy';
