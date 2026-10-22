import { EventEmitter } from 'node:events';

// 재생 조회와 보존 기간 검증에서 같은 창을 사용한다.
export const OUTBOX_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type LiveOutboxEvent = {
  id: string;
  deviceId: string;
  eventName: string;
  payload: unknown;
  createdAt: Date;
};

// 단일 프로세스는 저장 직후 SSE에 푸시한다. 다중 인스턴스에서는 Redis Pub/Sub로 교체한다.
export const outboxEvents = new EventEmitter();

// WEB_URL은 브라우저로 접속하는 origin과 반드시 같게 설정한다. CORS 설정과 분리한다.
export function webUrlBase(): string {
  return (process.env.WEB_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
}
