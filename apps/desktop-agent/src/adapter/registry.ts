import type { AgentProvider } from '@baton/shared';
import type { AgentAdapter } from './interface';

// 중복 등록과 알 수 없는 provider를 조용히 다른 구현으로 대체하지 않는다.
export class AgentAdapterRegistry {
  private readonly adapters = new Map<AgentProvider, AgentAdapter>();

  constructor(adapters: AgentAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.provider)) throw new Error(`Adapter 중복 등록: ${adapter.provider}`);
    this.adapters.set(adapter.provider, adapter);
  }

  get(provider: AgentProvider): AgentAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`등록되지 않은 Adapter: ${provider}`);
    return adapter;
  }
}
