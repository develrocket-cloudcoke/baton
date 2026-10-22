import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Logger } from '@nestjs/common';
import {
  OutboxRetentionService,
  outboxRetentionDays,
  OUTBOX_CLEANUP_BATCH_SIZE,
  OUTBOX_CLEANUP_INTERVAL_MS,
} from './desktop/outbox-retention.service';
import { OUTBOX_REPLAY_WINDOW_MS } from './desktop/outbox-events';

const DAY = 24 * 60 * 60 * 1000;
function fixture(rows: { id: string; createdAt: Date }[]) {
  const queries: any[] = [];
  const deletes: any[] = [];
  const outboxEvent = {
    findMany: async (query: any) => {
      queries.push(query);
      return rows
        .filter((row) => row.createdAt < query.where.createdAt.lt)
        .sort((a, b) => +a.createdAt - +b.createdAt || a.id.localeCompare(b.id))
        .slice(0, query.take)
        .map(({ id }) => ({ id }));
    },
    deleteMany: async (query: any) => {
      deletes.push(query);
      const oldLength = rows.length;
      rows = rows.filter(
        (row) => !(query.where.id.in.includes(row.id) && row.createdAt < query.where.createdAt.lt),
      );
      return { count: oldLength - rows.length };
    },
  };
  return {
    service: new OutboxRetentionService({ outboxEvent } as any),
    outboxEvent,
    queries,
    deletes,
    rows: () => rows,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('보존 기본 30일, 24시간 미만·잘못된 설정·날짜 범위 초과는 거부한다', () => {
  const previous = process.env.BATON_OUTBOX_RETENTION_DAYS;
  try {
    delete process.env.BATON_OUTBOX_RETENTION_DAYS;
    assert.equal(outboxRetentionDays(), 30);
    assert.equal(outboxRetentionDays('1') * DAY, OUTBOX_REPLAY_WINDOW_MS);
    assert.equal(outboxRetentionDays('90'), 90);
    for (const raw of [
      '0',
      '-1',
      '0.5',
      '1.5',
      '',
      ' ',
      'NaN',
      'Infinity',
      'thirty',
      '100000001',
      '9007199254740992',
    ]) {
      assert.throws(() => outboxRetentionDays(raw), /BATON_OUTBOX_RETENTION_DAYS/);
    }
  } finally {
    if (previous === undefined) delete process.env.BATON_OUTBOX_RETENTION_DAYS;
    else process.env.BATON_OUTBOX_RETENTION_DAYS = previous;
  }
});

test('기준보다 오래된 Outbox만 500건씩 삭제하고 경계·재생 창·최근 이벤트는 보존한다', async (t) => {
  const now = new Date('2026-09-22T00:00:00Z').getTime();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Logger.prototype, 'log', () => {});
  const cutoff = new Date(now - 30 * DAY);
  const expired = Array.from({ length: 1001 }, (_, i) => ({
    id: `old-${i}`,
    createdAt: new Date(+cutoff - 1),
  }));
  const retained = [
    { id: 'boundary', createdAt: cutoff },
    { id: 'replay', createdAt: new Date(now - OUTBOX_REPLAY_WINDOW_MS) },
    { id: 'recent', createdAt: new Date(now) },
  ];
  const f = fixture([...expired, ...retained]);
  await f.service.runOnce();
  assert.deepEqual(f.rows(), retained);
  assert.deepEqual(
    f.deletes.map((q) => q.where.id.in.length),
    [500, 500, 1],
  );
  for (const query of f.queries) {
    assert.equal(query.take, OUTBOX_CLEANUP_BATCH_SIZE);
    assert.deepEqual(query.select, { id: true });
    assert.deepEqual(query.orderBy, [{ createdAt: 'asc' }, { id: 'asc' }]);
    assert.equal(+query.where.createdAt.lt, +cutoff);
  }
  for (const query of f.deletes) assert.equal(+query.where.createdAt.lt, +cutoff);
  await f.service.runOnce();
  assert.equal(f.deletes.length, 3);
});

test('기동 즉시 실행하고 설정한 보존 기간과 6시간 주기를 사용하며 종료 때 타이머를 지운다', async (t) => {
  let tick!: () => void;
  let interval: number | undefined;
  let unref = false;
  const timer = {
    unref: () => {
      unref = true;
    },
  } as unknown as NodeJS.Timeout;
  t.mock.method(globalThis, 'setInterval', (callback: () => void, ms?: number) => {
    tick = callback;
    interval = ms;
    return timer;
  });
  const cleared = t.mock.method(globalThis, 'clearInterval', () => {});
  const previous = process.env.BATON_OUTBOX_RETENTION_DAYS;
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  process.env.BATON_OUTBOX_RETENTION_DAYS = '60';
  const f = fixture([]);
  try {
    f.service.onModuleInit();
    await f.service.runOnce();
    assert.equal(f.queries.length, 1);
    assert.equal(+f.queries[0].where.createdAt.lt, now - 60 * DAY);
    assert.equal(interval, OUTBOX_CLEANUP_INTERVAL_MS);
    assert.equal(interval, 6 * 60 * 60 * 1000);
    assert.equal(unref, true);
    tick();
    await f.service.runOnce();
    assert.equal(f.queries.length, 2);
    await f.service.onModuleDestroy();
    assert.equal(cleared.mock.calls[0].arguments[0], timer);
    tick();
    await f.service.runOnce();
    assert.equal(f.queries.length, 2);
  } finally {
    await f.service.onModuleDestroy();
    if (previous === undefined) delete process.env.BATON_OUTBOX_RETENTION_DAYS;
    else process.env.BATON_OUTBOX_RETENTION_DAYS = previous;
  }
});

test('느린 정리는 중복 실행하지 않고 종료가 시작되면 다음 DELETE를 시작하지 않는다', async () => {
  const read = deferred<{ id: string }[]>();
  const f = fixture([]);
  f.outboxEvent.findMany = async () => read.promise;
  const first = f.service.runOnce();
  assert.equal(f.service.runOnce(), first);
  let finished = false;
  const closing = f.service.onModuleDestroy().then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  read.resolve([{ id: 'expired' }]);
  await closing;
  assert.equal(f.deletes.length, 0);
});

test('삭제 중 종료는 현재 배치 완료만 기다리고 다음 배치를 조회하지 않는다', async (t) => {
  t.mock.method(Logger.prototype, 'log', () => {});
  const deletion = deferred<{ count: number }>();
  const started = deferred<void>();
  const f = fixture(
    Array.from({ length: 500 }, (_, i) => ({ id: String(i), createdAt: new Date(0) })),
  );
  f.outboxEvent.deleteMany = async () => {
    started.resolve();
    return deletion.promise;
  };
  const run = f.service.runOnce();
  await started.promise;
  const closing = f.service.onModuleDestroy();
  deletion.resolve({ count: 500 });
  await Promise.all([run, closing]);
  assert.equal(f.queries.length, 1);
});

test('DB 오류는 기록하고 다음 실행에서 재시도하며 다른 인스턴스의 선행 삭제도 허용한다', async (t) => {
  const error = t.mock.method(Logger.prototype, 'error', () => {});
  const f = fixture([{ id: 'expired', createdAt: new Date(0) }]);
  const original = f.outboxEvent.deleteMany;
  f.outboxEvent.deleteMany = async () => {
    throw new Error('temporary DB error');
  };
  await f.service.runOnce();
  assert.equal(error.mock.calls.length, 1);
  assert.equal(f.rows().length, 1);
  f.outboxEvent.deleteMany = async (query) => {
    await original(query);
    return { count: 0 };
  };
  await f.service.runOnce();
  assert.equal(f.rows().length, 0);
});

test('안전하지 않은 보존 설정이면 기동 시 타이머·DB 작업 전에 거부한다', (t) => {
  const previous = process.env.BATON_OUTBOX_RETENTION_DAYS;
  process.env.BATON_OUTBOX_RETENTION_DAYS = '0';
  const timer = t.mock.method(globalThis, 'setInterval', () => {
    throw new Error('타이머 생성 금지');
  });
  const f = fixture([]);
  try {
    assert.throws(() => f.service.onModuleInit(), /BATON_OUTBOX_RETENTION_DAYS/);
    assert.equal(timer.mock.calls.length, 0);
    assert.equal(f.queries.length, 0);
    assert.equal(f.deletes.length, 0);
  } finally {
    if (previous === undefined) delete process.env.BATON_OUTBOX_RETENTION_DAYS;
    else process.env.BATON_OUTBOX_RETENTION_DAYS = previous;
  }
});
