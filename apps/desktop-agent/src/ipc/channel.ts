import { Readable, Writable } from 'node:stream';
import { encodeLine, Envelope, IPC_PROTOCOL_VERSION, IpcError, MessageIdSequence, nowTs } from './envelope';
import { LineParser } from './line-parser';
import { ErrorPayloadSchema, MessageType } from './messages';
import { logger } from '../util/log';

export type RequestHandler = (env: Envelope) => Promise<{ type: string; payload: Record<string, unknown> }>;
export type EventHandler = (env: Envelope) => void;

interface Pending {
  resolve: (env: Envelope) => void;
  reject: (err: IpcError) => void;
  timer: NodeJS.Timeout;
}

// 셸과의 stdin/stdout JSON Lines 채널 (04 §1~§5). 데몬 쪽 구현.
export class IpcChannel {
  private readonly ids = new MessageIdSequence('d');
  private readonly parser = new LineParser();
  private readonly pending = new Map<string, Pending>();
  private requestHandlers = new Map<string, RequestHandler>();
  private eventHandlers = new Map<string, EventHandler>();
  private closed = false;
  onClose: (() => void) | null = null;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable
  ) {
    input.on('data', (chunk: Buffer) => this.handleChunk(chunk));
    input.on('end', () => this.handleEnd());
    input.on('error', () => this.handleEnd());
  }

  onRequest(type: string, handler: RequestHandler): void {
    this.requestHandlers.set(type, handler);
  }

  onEvent(type: string, handler: EventHandler): void {
    this.eventHandlers.set(type, handler);
  }

  // event 전송 (응답 없음)
  send(type: string, payload: Record<string, unknown> = {}, replyTo?: string): string {
    const env: Envelope = { v: IPC_PROTOCOL_VERSION, type, id: this.ids.next(), ts: nowTs(), payload };
    if (replyTo) env.replyTo = replyTo;
    this.write(env);
    return env.id;
  }

  // request 전송. 응답 봉투를 돌려주고, error 응답은 IpcError 로 던진다.
  request(type: string, payload: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<Envelope> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new IpcError('internal', 'ipc channel closed', true));
      const id = this.send(type, payload);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new IpcError('timeout', `${type} timed out after ${timeoutMs}ms`, true));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private write(env: Envelope): void {
    if (this.closed) return;
    this.output.write(encodeLine(env));
  }

  private handleChunk(chunk: Buffer): void {
    for (const event of this.parser.feed(chunk)) {
      if (event.kind === 'oversize') logger.warn('ipc.oversize', { bytes: event.bytes });
      else if (event.kind === 'malformed') logger.warn('ipc.malformed', { consecutive: event.consecutive, preview: event.preview });
      else this.dispatch(event.envelope);
    }
  }

  private handleEnd(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new IpcError('internal', 'ipc channel closed', true));
    }
    this.pending.clear();
    this.onClose?.();
  }

  private dispatch(env: Envelope): void {
    if (env.v !== IPC_PROTOCOL_VERSION) {
      logger.warn('ipc.protocol_mismatch', { v: env.v, type: env.type });
      this.send(MessageType.error, { code: 'protocol_mismatch', message: `daemon protocol ${IPC_PROTOCOL_VERSION}`, retryable: false }, env.id);
      return;
    }
    if (env.replyTo) {
      const p = this.pending.get(env.replyTo);
      if (!p) {
        logger.warn('ipc.unknown_reply', { replyTo: env.replyTo });
        return;
      }
      this.pending.delete(env.replyTo);
      clearTimeout(p.timer);
      if (env.type === MessageType.error) {
        const parsed = ErrorPayloadSchema.safeParse(env.payload);
        const code = parsed.success ? parsed.data.code : 'internal';
        p.reject(new IpcError(code as IpcError['code'], parsed.success ? parsed.data.message : 'error', parsed.success ? parsed.data.retryable ?? false : false));
      } else {
        p.resolve(env);
      }
      return;
    }
    const requestHandler = this.requestHandlers.get(env.type);
    if (requestHandler) {
      requestHandler(env)
        .then((reply) => this.send(reply.type, reply.payload, env.id))
        .catch((err: unknown) => {
          const e = err instanceof IpcError ? err : new IpcError('internal', String(err));
          this.send(MessageType.error, { code: e.code, message: e.message, retryable: e.retryable }, env.id);
        });
      return;
    }
    const eventHandler = this.eventHandlers.get(env.type);
    if (eventHandler) {
      eventHandler(env);
      return;
    }
    logger.warn('ipc.unknown_type', { type: env.type });
    this.send(MessageType.error, { code: 'unknown_type', message: env.type, retryable: false }, env.id);
  }
}
