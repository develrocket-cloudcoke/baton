import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { OUTBOX_REPLAY_WINDOW_MS } from './outbox-events';

const DAY_MS = 24 * 60 * 60 * 1000;
export const OUTBOX_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const OUTBOX_CLEANUP_BATCH_SIZE = 500;

export function outboxRetentionDays(raw = process.env.BATON_OUTBOX_RETENTION_DAYS): number {
  if (raw === undefined) return 30;
  const days = Number(raw);
  if (
    !raw.trim() ||
    !Number.isSafeInteger(days) ||
    days * DAY_MS < OUTBOX_REPLAY_WINDOW_MS ||
    days * DAY_MS > 8.64e15
  ) {
    throw new Error(
      'BATON_OUTBOX_RETENTION_DAYS는 재생 창(24시간) 이상의 양의 정수 일수여야 하며 날짜 범위를 넘을 수 없습니다.',
    );
  }
  return days;
}

@Injectable()
export class OutboxRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRetentionService.name);
  private retentionDays = 30;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = false;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.retentionDays = outboxRetentionDays();
    this.timer = setInterval(() => void this.runOnce(), OUTBOX_CLEANUP_INTERVAL_MS);
    this.timer.unref();
    // 큰 초기 적체가 있어도 API 기동은 기다리지 않는다. 중복 주기는 같은 작업을 공유한다.
    void this.runOnce();
  }

  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    await this.running;
  }

  runOnce(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.running) return this.running;
    const cutoff = new Date(Date.now() - this.retentionDays * DAY_MS);
    this.running = this.removeExpired(cutoff)
      .catch((error: unknown) => {
        this.logger.error(
          'outbox.cleanup_failed: 다음 주기에 다시 시도합니다.',
          error instanceof Error ? error.stack : String(error),
        );
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async removeExpired(cutoff: Date) {
    let deleted = 0;
    while (!this.stopping) {
      const rows = await this.prisma.outboxEvent.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: OUTBOX_CLEANUP_BATCH_SIZE,
      });
      if (!rows.length || this.stopping) break;
      // 하나의 큰 트랜잭션으로 묶지 않는다. 각 DELETE는 PK 최대 500개만 잠근 뒤 커밋한다.
      // 다른 서버가 같은 배치를 먼저 지웠더라도 count=0일 뿐이며 다음 조회로 진행한다.
      const result = await this.prisma.outboxEvent.deleteMany({
        where: { id: { in: rows.map((row) => row.id) }, createdAt: { lt: cutoff } },
      });
      deleted += result.count;
      if (rows.length < OUTBOX_CLEANUP_BATCH_SIZE) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (deleted)
      this.logger.log(`outbox.cleanup_completed: ${deleted}건 삭제, 기준 ${cutoff.toISOString()}`);
  }
}
