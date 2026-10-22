import { logger } from '../util/log';

// 프로젝트당 동시 실행 1건 (F3: git baseline 오염 방지). 같은 프로젝트 요청은 순서대로 기다린다.
export class ExecutionQueue {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly active = new Set<string>();

  isBusy(projectKey: string): boolean {
    return this.active.has(projectKey);
  }

  get activeCount(): number {
    return this.active.size;
  }

  run<T>(projectKey: string, executionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(projectKey) ?? Promise.resolve();
    if (this.active.has(projectKey)) logger.info('execution queued (project busy)', { projectKey, executionId });
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        this.active.add(projectKey);
        try {
          return await task();
        } finally {
          this.active.delete(projectKey);
        }
      });
    this.chains.set(
      projectKey,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next;
  }
}
