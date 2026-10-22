import http from 'node:http';
import https from 'node:https';
import { logger } from '../util/log';

export interface SseEvent {
  id: string;
  type: string;
  data: string;
}

export interface SseClientOptions {
  url: string;
  token: string;
  getLastEventId: () => string;
  onEvent: (event: SseEvent) => Promise<void> | void;
  onConnected?: (lastEventId: string) => void;
  onDisconnected?: (reason: string) => void;
  // 재연결하면 안 되는 종료 (다른 데몬으로 대체됨 등). 호출 후 이 클라이언트는 멈춘 상태다.
  onFatal?: (reason: string) => void;
  onAuthFailure?: () => void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

// 서버 SSE 구독 (D1). Last-Event-ID 로 재연결, 바이트 기반 파서, 지수 백오프.
// 서버(W6a)가 live push(outboxEvents)를 구현한 뒤로는 짧은 주기 재연결이 필요 없다.
// `idleReconnectMs` 는 이제 half-open TCP(조용히 죽은 연결) 대비 안전망이라 기본값이 5분이다.
// 0 을 주면 끄고, 짧게 주면 예전처럼 폴링에 가깝게 동작한다 (BATON_SSE_IDLE_RECONNECT_MS).
export class SseClient {
  private req: http.ClientRequest | null = null;
  private stopped = false;
  private backoff: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly processed: string[] = [];
  idleReconnectMs = Number(process.env.BATON_SSE_IDLE_RECONNECT_MS ?? 300_000);
  connectCount = 0;

  constructor(private readonly options: SseClientOptions) {
    this.backoff = options.minBackoffMs ?? 500;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  // 재연결 금지 종료. 데몬이 상태를 셸에 알리고 프로세스를 끝낸다 (04 §11.2).
  fatal(reason: string): void {
    if (this.stopped) return;
    logger.warn('sse fatal (재연결 안 함)', { reason });
    this.stop();
    this.options.onFatal?.(reason);
  }

  private authenticationFailed(): void {
    if (this.stopped) return;
    this.stop();
    this.options.onAuthFailure?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.req?.destroy();
    this.req = null;
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnectTimer) return;
    this.options.onDisconnected?.(reason);
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.options.maxBackoffMs ?? 30_000);
    logger.info('sse reconnecting', { delayMs: delay, reason, lastEventId: this.options.getLastEventId() });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private armIdleReconnect(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.idleReconnectMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      logger.debug('sse idle reconnect (server live push 미구현 대비)');
      this.req?.destroy();
    }, this.idleReconnectMs);
  }

  private connect(): void {
    if (this.stopped) return;
    const url = new URL(this.options.url);
    const client = url.protocol === 'https:' ? https : http;
    const lastEventId = this.options.getLastEventId();
    const req = client.request(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.options.token}`, accept: 'text/event-stream', 'last-event-id': lastEventId }
    });
    this.req = req;
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        logger.warn('sse http error', { status: res.statusCode });
        // 409 = 서버가 이 디바이스의 연결을 이미 다른 데몬에 넘겼다 → 재연결하지 않는다
        if (res.statusCode === 401 || res.statusCode === 403) this.authenticationFailed();
        else if (res.statusCode === 409) this.fatal('http 409 (다른 연결이 이미 이 디바이스를 점유)');
        else this.scheduleReconnect(`http ${res.statusCode}`);
        return;
      }
      this.backoff = this.options.minBackoffMs ?? 500;
      this.connectCount += 1;
      this.options.onConnected?.(lastEventId);
      this.armIdleReconnect();
      let buffer = Buffer.alloc(0);
      let id: string | null = null;
      let type: string | null = null;
      let data: string[] = [];
      let queue: Promise<void> = Promise.resolve();
      const dispatch = () => {
        // 서버(Nest @Sse)는 connection.replaced/connection.ready 를 `id:` 없이 보낸다. id 가 없어도 버리지 않는다.
        if (data.length && (id || type)) {
          const event: SseEvent = { id: id ?? '', type: type ?? 'message', data: data.join('\n') };
          // Nest @Sse 인증 오류는 HTTP 200이며 JSON이 아니다. id 중복 검사보다 먼저 처리한다.
          if (event.type === 'error' && /^unauthorized$/i.test(event.data.trim())) {
            this.authenticationFailed();
          } else queue = queue.then(() => this.handle(event)).catch((e) => logger.error('sse handler error', { message: String(e) }));
        }
        id = null;
        type = null;
        data = [];
      };
      res.on('data', (chunk: Buffer) => {
        this.armIdleReconnect();
        buffer = Buffer.concat([buffer, chunk]);
        let nl: number;
        while ((nl = buffer.indexOf(0x0a)) >= 0) {
          let line = buffer.subarray(0, nl).toString('utf8');
          buffer = buffer.subarray(nl + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (line === '') dispatch();
          else if (line.startsWith(':')) continue;
          else if (line.startsWith('id:')) id = line.slice(3).trim();
          else if (line.startsWith('event:')) type = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
      });
      res.on('end', () => this.scheduleReconnect('stream ended'));
      res.on('error', (e) => this.scheduleReconnect(`stream error ${e.message}`));
      res.on('close', () => this.scheduleReconnect('stream closed'));
    });
    req.on('error', (e) => this.scheduleReconnect(`request error ${e.message}`));
    req.end();
  }

  // 서버 연결 제어 프레임(connection.ready/replaced)은 outbox 이벤트가 아니다.
  // Nest @Sse 는 id 를 주지 않은 이벤트에 **연결마다 1부터** 번호를 붙이므로, 재연결하면 같은 id 가 다시 온다.
  // 이걸 멱등 캐시에 넣으면 두 번째 연결의 connection.replaced 가 "중복" 으로 조용히 버려진다(W6d 발견).
  static isControlEvent(type: string): boolean {
    return type.startsWith('connection.');
  }

  // 멱등: 같은 id 는 한 번만 처리 (최근 200개 기억)
  private async handle(event: SseEvent): Promise<void> {
    if (this.stopped) return;
    if (event.id === '' || SseClient.isControlEvent(event.type)) {
      await this.options.onEvent(event);
      return;
    }
    if (this.processed.includes(event.id)) {
      logger.info('sse duplicate ignored', { id: event.id });
      return;
    }
    this.processed.push(event.id);
    if (this.processed.length > 200) this.processed.shift();
    await this.options.onEvent(event);
  }
}
