import type { AgentCapabilities, AgentProvider, AgentModels } from '@baton/shared';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DeviceInfo } from './device-info';
import { logger } from '../util/log';

// 01 §5.3 Desktop Agent API 클라이언트 (fetch, Node 22 내장).
// 경로는 apps/server 의 현재 구현(v1/devices/pair, v1/desktop/executions/:id/status|result, v1/desktop/events/stream)에 맞춘다.
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string
  ) {
    super(`${path} -> ${status} ${body.slice(0, 200)}`);
  }

  // 서버(Nest)가 준 사람용 사유. `{"message":"만료된 pairing 코드입니다.", ...}` 형식이면 message 를, 아니면 null.
  get serverMessage(): string | null {
    try {
      const parsed = JSON.parse(this.body) as { message?: unknown };
      if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message;
      if (Array.isArray(parsed.message) && parsed.message.length) return parsed.message.map(String).join(', ');
    } catch {
      // JSON 이 아니면 사유 없음
    }
    return null;
  }
}

// 05 §3.4 사용자별 pairing 코드 `XXXX-XXXX`. 사용자가 소문자·공백·하이픈 없이 입력해도 서버 형식으로 맞춘다.
export function normalizePairingCode(raw: string): string {
  const compact = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z0-9]{8}$/.test(compact) ? `${compact.slice(0, 4)}-${compact.slice(4)}` : raw.trim().toUpperCase();
}

export interface PairResult {
  deviceId: string;
  deviceToken: string;
  userId: string | null;
}

export interface UploadTicket {
  artifactId: string;
  uploadUrl: string;
  method?: string;
  headers?: Record<string, string>;
}

export class ApiClient {
  private invalidated = false;
  constructor(
    private readonly baseUrl: string,
    private token: string | null,
    private readonly onAuthFailure?: () => void
  ) {}

  invalidate(): void {
    this.invalidated = true;
    this.token = null;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  get base(): string {
    return this.baseUrl.replace(/\/+$/, '');
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  async call<T = Record<string, unknown>>(method: string, apiPath: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.invalidated) throw new ApiError(401, apiPath, 'device token invalidated');
    const authenticated = this.token !== null;
    const res = await fetch(this.base + apiPath, {
      method,
      ...(signal ? { signal } : {}),
      headers: this.headers(body === undefined ? {} : { 'content-type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (res.status === 401 && authenticated && !this.invalidated) {
      this.invalidate();
      this.onAuthFailure?.();
    }
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, apiPath, text);
    return (text ? JSON.parse(text) : {}) as T;
  }

  // pairing 코드 → device token (05 §3.4: body `{ code, deviceName }`, 코드는 웹 "내 디바이스" 에서 사용자별로 발급)
  // deviceInfo(platform/osVersion/appVersion/hostname) 는 packages/shared DevicePairV2RequestSchema 의 선택 필드다.
  async pair(code: string, deviceName: string, info?: DeviceInfo): Promise<PairResult> {
    const r = await this.call<{ deviceId?: string; device_id?: string; deviceToken?: string; device_token?: string; userId?: string }>('POST', '/v1/devices/pair', { code: normalizePairingCode(code), deviceName, ...(info ?? {}) });
    const deviceId = r.deviceId ?? r.device_id;
    const deviceToken = r.deviceToken ?? r.device_token;
    if (!deviceId || !deviceToken) throw new ApiError(500, '/v1/devices/pair', 'deviceId/deviceToken 누락');
    // userId 는 실서버 응답에 없다(계약 밖). fake-server 가 주면 request.claimed 의 본인 판별에 쓴다.
    return { deviceId, deviceToken, userId: typeof r.userId === 'string' ? r.userId : null };
  }

  // Agent·Project 등록 (01 §5.3). 서버가 아직 없으면 404 → null
  async registerAgent(displayName: string, provider: AgentProvider = 'CLAUDE_CODE', capabilities?: AgentCapabilities, models?: AgentModels): Promise<string | null> {
    try {
      const r = await this.call<{ agentId?: string; id?: string }>('POST', '/v1/desktop/agents', { provider, displayName, ...(capabilities ? { capabilities } : {}), ...(models ? { models } : {}) });
      return r.agentId ?? r.id ?? null;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  async registerProject(agentId: string, displayName: string, localPathHint: string | null): Promise<string | null> {
    try {
      const r = await this.call<{ projectId?: string; id?: string }>('POST', '/v1/desktop/projects', { agentId, displayName, localPathHint });
      return r.projectId ?? r.id ?? null;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  async reportPresence(agentId: string, status: 'ONLINE' | 'OFFLINE' | 'BUSY' | 'DISABLED'): Promise<void> {
    try {
      await this.call('PATCH', `/v1/desktop/agents/${agentId}/presence`, { status });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return;
      throw e;
    }
  }

  // 02 §7.4 heartbeat: 디바이스 정보 + 현재 실행 상태. 서버가 미구현(404)이면 조용히 넘긴다.
  // Phase 2: capabilities 갱신 시에는 이 디바이스 소유 agentId를 함께 보낸다.
  async heartbeat(body: DeviceInfo & { capabilities?: AgentCapabilities; state?: string; activeExecutionIds?: string[]; agentId?: string | null; deviceId?: string | null; at?: string }): Promise<boolean> {
    try {
      await this.call('POST', '/v1/desktop/heartbeat', body);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return false;
      throw e;
    }
  }

  // sessionId: 기획서 §18 추가 작업(--resume)을 위해 서버가 claude 세션 id 를 기억하도록 실행 시작 보고에 싣는다.
  async reportStatus(executionId: string, status: 'RUNNING' | 'PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED', message: string, phase?: string, sessionId?: string | null): Promise<void> {
    await this.call('POST', `/v1/desktop/executions/${executionId}/status`, { status, message, phase, ...(sessionId ? { sessionId } : {}) });
  }

  async reportResult(executionId: string, body: Record<string, unknown>): Promise<void> {
    await this.call('POST', `/v1/desktop/executions/${executionId}/result`, body);
  }

  // 업로드 URL 발급 → PUT → Artifact 연결 (01 §5.2 /v1/uploads; 서버 미구현이면 null)
  async uploadArtifact(input: { teamId?: string; requestId?: string; kind: string; filePath: string; mimeType: string }): Promise<string | null> {
    if (!fs.existsSync(input.filePath)) return null;
    const data = fs.readFileSync(input.filePath);
    const sha256 = createHash('sha256').update(data).digest('hex');
    let ticket: UploadTicket;
    try {
      // 서버는 { artifact: { id }, uploadUrl } 을, fake-server 는 { artifactId, uploadUrl } 을 준다.
      const raw = await this.call<UploadTicket & { artifact?: { id: string } }>('POST', '/v1/uploads', {
        teamId: input.teamId,
        requestId: input.requestId,
        kind: input.kind,
        filename: path.basename(input.filePath),
        mimeType: input.mimeType,
        sha256,
        sizeBytes: data.length
      });
      ticket = { ...raw, artifactId: raw.artifactId ?? raw.artifact?.id ?? '' };
      if (!ticket.artifactId || !ticket.uploadUrl) throw new ApiError(500, '/v1/uploads', 'artifactId/uploadUrl 누락');
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        logger.warn('uploads 미구현 서버: artifact 업로드 생략', { file: input.filePath });
        return null;
      }
      throw e;
    }
    const put = await fetch(this.resolve(ticket.uploadUrl), { method: ticket.method ?? 'PUT', headers: { 'content-type': input.mimeType, ...(ticket.headers ?? {}) }, body: data });
    if (!put.ok) throw new ApiError(put.status, ticket.uploadUrl, await put.text());
    try {
      await this.call('POST', `/v1/uploads/${ticket.artifactId}/complete`, { sha256 });
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
    return ticket.artifactId;
  }

  // L-1: 대상 URL의 origin이 base와 동일한지 확인한다.
  isSameOrigin(url: string): boolean {
    try {
      const targetOrigin = new URL(this.resolve(url)).origin;
      const baseOrigin = new URL(this.base).origin;
      return targetOrigin.toLowerCase() === baseOrigin.toLowerCase();
    } catch {
      return false;
    }
  }

  // 상대 URL 은 서버 base 에 붙인다.
  resolve(url: string): string {
    return /^https?:\/\//i.test(url) ? url : this.base + (url.startsWith('/') ? url : '/' + url);
  }

  // 첨부 다운로드. `/v1/artifacts/:id` 처럼 JSON 메타데이터(downloadUrl 포함)가 오면 한 번 더 따라간다.
  async download(url: string, dest: string, expectedSha256?: string): Promise<void> {
    const targetUrl = this.resolve(url);
    let res = await fetch(targetUrl, { headers: this.isSameOrigin(targetUrl) ? this.headers() : {} });
    if (!res.ok) throw new ApiError(res.status, url, await res.text());
    if ((res.headers.get('content-type') ?? '').includes('application/json')) {
      const meta = (await res.json()) as { downloadUrl?: string };
      if (meta.downloadUrl) {
        const nextUrl = this.resolve(meta.downloadUrl);
        res = await fetch(nextUrl, { headers: this.isSameOrigin(nextUrl) ? this.headers() : {} });
        if (!res.ok) throw new ApiError(res.status, meta.downloadUrl, await res.text());
      } else {
        throw new ApiError(500, url, 'downloadUrl 없는 JSON 응답');
      }
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (expectedSha256) {
      const actual = createHash('sha256').update(data).digest('hex');
      if (actual !== expectedSha256.toLowerCase()) {
        logger.warn('첨부 sha256 불일치', { url, expected: expectedSha256, actual });
        throw new ApiError(400, url, `첨부 파일 무결성 검증 실패 (sha256 불일치: expected=${expectedSha256.toLowerCase()}, actual=${actual})`);
      }
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
}
