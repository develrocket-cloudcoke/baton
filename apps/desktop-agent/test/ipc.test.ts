import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { IpcChannel } from '../src/ipc/channel';
import { decodeLine, encodeLine, Envelope, IPC_PROTOCOL_VERSION } from '../src/ipc/envelope';
import { LineParser } from '../src/ipc/line-parser';

test('봉투 라운드트립: replyTo 생략, payload object, LF 종료', () => {
  const env: Envelope = { v: 1, type: 'request.notify', id: 'd-42', ts: '2026-09-04T08:00:00.123Z', payload: { title: '새 요청', n: 3 } };
  const line = encodeLine(env);
  assert.ok(line.endsWith('\n'));
  assert.ok(!line.includes('replyTo'));
  assert.deepEqual(decodeLine(line.trimEnd()), env);
  const reply = encodeLine({ v: 1, type: 'ack', id: 's-7', ts: 'x', replyTo: 'd-42', payload: {} });
  assert.ok(reply.includes('"replyTo":"d-42"'));
  assert.throws(() => decodeLine('{"v":1,"type":"x","id":"1","ts":"t","payload":[]}'), /invalid_envelope|payload/);
});

test('바이트 파서: 청크 분할·CRLF·빈 줄·malformed·oversize 복구', () => {
  const parser = new LineParser(200);
  const l1 = encodeLine({ v: 1, type: 'a', id: 'd-1', ts: 't', payload: {} });
  const l2 = encodeLine({ v: 1, type: 'b', id: 'd-2', ts: 't', payload: {} });
  const stream = Buffer.from(l1.slice(0, -1) + '\r\n' + '\n' + '{not json}\n' + l2);
  const events = [...parser.feed(stream.subarray(0, 7)), ...parser.feed(stream.subarray(7, stream.length - 3)), ...parser.feed(stream.subarray(stream.length - 3))];
  assert.deepEqual(events.filter((e) => e.kind === 'envelope').map((e) => (e as { envelope: Envelope }).envelope.type), ['a', 'b']);
  assert.equal(events.filter((e) => e.kind === 'malformed').length, 1);
  assert.equal(parser.consecutiveMalformed, 0);
  const oversize = parser.feed(Buffer.concat([Buffer.alloc(500, 0x41), Buffer.from('\n')]));
  assert.ok(oversize.some((e) => e.kind === 'oversize'));
  assert.ok(parser.feed(Buffer.from(l1)).some((e) => e.kind === 'envelope'));
  assert.equal(parser.feed(Buffer.from(l2.slice(0, -1))).length, 0);
  assert.equal(parser.finish().length, 1);
});

test('채널: 요청/응답, 알 수 없는 type 은 error 응답, 셸 요청 처리', async () => {
  const toDaemon = new PassThrough();
  const fromDaemon = new PassThrough();
  const channel = new IpcChannel(toDaemon, fromDaemon);
  const received: Envelope[] = [];
  const parser = new LineParser();
  fromDaemon.on('data', (c: Buffer) => {
    for (const e of parser.feed(c)) if (e.kind === 'envelope') received.push(e.envelope);
  });
  channel.onRequest('pair.start', async () => ({ type: 'pair.result', payload: { ok: true } }));

  const pending = channel.request('token.get', {});
  await new Promise((r) => setTimeout(r, 20));
  const req = received.find((e) => e.type === 'token.get');
  assert.ok(req);
  toDaemon.write(encodeLine({ v: IPC_PROTOCOL_VERSION, type: 'token.value', id: 's-1', ts: 't', replyTo: req!.id, payload: { deviceToken: 'tok' } }));
  const reply = await pending;
  assert.equal(reply.payload.deviceToken, 'tok');

  toDaemon.write(encodeLine({ v: 1, type: 'pair.start', id: 's-2', ts: 't', payload: { pairingCode: 'x' } }));
  toDaemon.write(encodeLine({ v: 1, type: 'bogus.type', id: 's-3', ts: 't', payload: {} }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(received.find((e) => e.replyTo === 's-2')?.type, 'pair.result');
  const err = received.find((e) => e.replyTo === 's-3');
  assert.equal(err?.type, 'error');
  assert.equal(err?.payload.code, 'unknown_type');

  const timeout = channel.request('settings.get', {}, 50);
  await assert.rejects(timeout, /timed out/);
});
