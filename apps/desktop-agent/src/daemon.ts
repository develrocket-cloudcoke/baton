import os from 'node:os';
import path from 'node:path';
import { createDefaultAdapterRegistry } from './adapter';
import { AgentAdapter, AgentRunner, ExecutionRunResult as RunResult, registrationCapabilities } from './adapter/interface';
import { AgentAdapterRegistry } from './adapter/registry';
import { secretWarningLine } from './adapter/common/secret-scan';
import { AgentProviderSchema, type AgentModels, type AgentProvider } from '@baton/shared';
import { DaemonState, DaemonStatusPayload } from './ipc/messages';
import { ExecutionQueue } from './queue/execution-queue';
import { ShellServices } from './services/shell-services';
import { ProjectEntry, findByProjectId, needsRegistration, parseProjects, projectIdFor, serializeProjects } from './settings/projects';
import { ApiClient, ApiError } from './transport/api-client';
import { deviceInfo } from './transport/device-info';
import { ConnectionReplacedSchema, ExecutionCancelSchema, ExecutionCommand, ExecutionCommandSchema, RequestClaimedEventSchema, RequestNotifyEventSchema, teamName, userDisplayName, userRefId } from './transport/events';
import { SseClient, SseEvent } from './transport/sse-client';
import { logger } from './util/log';
import { nowIso } from './util/fs';

export interface DaemonOptions {
  services: ShellServices;
  adapterRegistry?: AgentAdapterRegistry;
  /** 이 provider 들만 쓴다(테스트·콘솔용). 주지 않으면 설치된 것을 모두 감지해 등록한다. */
  providers?: AgentProvider[];
  provider?: AgentProvider;
  hook: { node: string; cli: string };
  home?: string;
  claudePath?: string;
  codexPath?: string;
  codexModel?: string;
  agyPath?: string;
  agyModel?: string;
  model?: string;
  maxTurns?: number;
  statusIntervalMs?: number;
  heartbeatIntervalMs?: number;
  // SSE 가 '다른 연결로 대체됨' 으로 끊겼을 때 (04 §11.2). CLI 가 exit 17 로 종료시킨다.
  onFatal?: (reason: string) => void;
}

// 데몬 코어: 설정/토큰(셸 대행) → (pairing) → Agent/Project 등록 → SSE 구독 → 명령 수신 → 큐 → Adapter 실행 → 보고
const AUTH_FAILURE_REASON = '서버가 이 디바이스 토큰을 인정하지 않습니다(다른 서버로 바꿨거나 해제됨).';

export class Daemon {
  private needsPairing = false;
  private credentialReset: Promise<void> = Promise.resolve();
  private api: ApiClient | null = null;
  private sse: SseClient | null = null;
  private readonly queue = new ExecutionQueue();
  private readonly runners = new Map<string, AgentRunner>();
  private readonly handled = new Set<string>();
  private state: DaemonState = 'idle';
  private since = nowIso();
  private lastError: DaemonStatusPayload['lastError'] = null;
  // 셸이 토큰을 주지 못한 사유 (Keychain 프롬프트·거부 등). 팝오버에 그대로 표시된다.
  private tokenError: { code: string; message: string } | null = null;
  private activeExecutionId: string | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private settings: Record<string, unknown> = {};
  private token: string | null = null;
  private stopped = false;
  // request.delivered 로 띄운 알림 id (requestId → notificationId). claim 되면 같은 id 를 제거한다.
  private readonly deliveredNotifications = new Map<string, string>();
  // 취소 요청을 받은 Execution. 아직 시작하지 않은(큐 대기) 실행도 여기 들어가면 실행하지 않는다.
  private readonly cancelRequested = new Set<string>();
  // 실행 중인 Execution → 프로젝트 경로 (heartbeat·로그용)
  private readonly running = new Map<string, string>();

  private readonly registry: AgentAdapterRegistry;
  // 이 디바이스에서 실제로 쓸 수 있는 provider 들. 설치 여부를 detect() 로 확인해 채운다.
  private providers: AgentProvider[] = [];
  // provider → 서버에 등록된 Agent id
  private agents: Record<string, string> = {};
  // provider → 쓸 수 있는 모델. CLI 조회가 느려서(agy 실측 33초) 등록을 막지 않고
  // 백그라운드로 채운 뒤 heartbeat 로 따라 보낸다.
  private models: Record<string, AgentModels> = {};

  constructor(private readonly options: DaemonOptions) {
    this.registry = options.adapterRegistry ?? createDefaultAdapterRegistry({
      home: options.home,
      claudePath: options.claudePath,
      codexPath: options.codexPath,
      agyPath: options.agyPath,
      hook: options.hook,
      downloader: (url, dest, sha256) => this.api!.download(url, dest, sha256)
    });
  }

  get services(): ShellServices {
    return this.options.services;
  }

  private setState(state: DaemonState, error?: { code: string; message: string } | null): void {
    if (error !== undefined) this.lastError = error ? { ...error, at: nowIso() } : null;
    if (state !== this.state) {
      this.state = state;
      this.since = nowIso();
    }
    this.publishStatus();
  }

  // 설치된 에이전트 CLI 를 찾는다. 옵션·환경변수로 지정하면 그것만 쓰고(테스트·콘솔),
  // 아니면 세 provider 를 모두 확인해 **설치된 것마다** Agent 를 등록한다.
  private async detectProviders(): Promise<AgentProvider[]> {
    const forced = this.options.providers
      ?? (this.options.provider ? [this.options.provider] : null)
      ?? (process.env.BATON_PROVIDER ? [AgentProviderSchema.parse(process.env.BATON_PROVIDER)] : null);
    const candidates = forced ?? AgentProviderSchema.options;
    const out: AgentProvider[] = [];
    for (const provider of candidates) {
      let detected: { available: boolean; reason?: string; version?: string };
      try {
        detected = await this.registry.get(provider).detect();
      } catch (e) {
        detected = { available: false, reason: Daemon.describe(e) };
      }
      if (detected.available) {
        out.push(provider);
        logger.info('adapter 감지됨', { provider, version: detected.version ?? null });
      } else {
        logger.info('adapter 미설치 — 등록하지 않음', { provider, reason: detected.reason ?? null });
      }
    }
    if (!out.length) logger.warn('설치된 에이전트 CLI 가 없습니다 — 실행을 받을 수 없습니다');
    return out;
  }

  /** 등록된 provider 마다 쓸 수 있는 모델을 CLI 에서 읽어 캐시한다. 실패는 로그만 남긴다. */
  private async refreshModels(): Promise<void> {
    for (const provider of Object.keys(this.agents) as AgentProvider[]) {
      if (this.models[provider]) continue;
      try {
        const found = await this.registry.get(provider).listModels();
        this.models[provider] = found;
        logger.info('모델 목록 조회', { provider, source: found.source, count: found.models.length, defaultModel: found.defaultModel });
      } catch (e) {
        logger.warn('모델 목록 조회 실패 (계속 진행)', { provider, message: Daemon.describe(e) });
      }
    }
    // 다음 주기를 기다리지 않고 바로 올린다 (사람이 실행 화면에서 기다리고 있다)
    if (!this.stopped) await this.sendHeartbeat();
  }

  private storedAgents(): Record<string, string> {
    const raw = this.settings.agents;
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === 'string' && v) out[k] = v;
          return out;
        }
      } catch {
        logger.warn('설정 agents 가 JSON 객체가 아님 — 비우고 다시 등록합니다');
      }
    }
    // 구버전: agentId 한 개 + agentProvider
    const legacyId = typeof this.settings.agentId === 'string' ? this.settings.agentId : '';
    if (!legacyId) return {};
    const legacyProvider = typeof this.settings.agentProvider === 'string' && this.settings.agentProvider ? this.settings.agentProvider : 'CLAUDE_CODE';
    return { [legacyProvider]: legacyId };
  }

  // 구버전 설정 정리. 한 번만 하면 되고, 실패해도 데몬은 계속 돈다.
  // - projectPath(단일 경로) → projects 목록의 항목 하나로
  // - provider(사람이 고르던 값) → 삭제. 이제 설치된 것을 모두 감지해 쓴다
  private async migrateLegacySettings(): Promise<void> {
    const patch: Record<string, unknown> = {};
    const legacyPath = typeof this.settings.projectPath === 'string' ? this.settings.projectPath.trim() : '';
    if (legacyPath) {
      const list = parseProjects(this.settings);
      if (!list.some((e) => e.path === path.resolve(legacyPath))) {
        const resolved = path.resolve(legacyPath);
        const legacyProvider = typeof this.settings.agentProvider === 'string' && this.settings.agentProvider ? this.settings.agentProvider : 'CLAUDE_CODE';
        const projectIds: Record<string, string | null> = {};
        if (typeof this.settings.projectId === 'string' && this.settings.projectId) projectIds[legacyProvider] = this.settings.projectId;
        list.push({ name: path.basename(resolved) || resolved, path: resolved, projectIds });
        patch.projects = serializeProjects(list);
        logger.info('구버전 projectPath 를 프로젝트 목록으로 옮김', { path: resolved });
      }
      patch.projectPath = null;
    }
    if (this.settings.provider !== undefined) patch.provider = null;
    if (this.settings.projectId !== undefined) patch.projectId = null;
    if (!Object.keys(patch).length) return;
    this.settings = await this.services.setSettings(patch);
  }

  private async saveAgents(): Promise<void> {
    this.settings = await this.services.setSettings({
      agents: JSON.stringify(this.agents),
      // 구버전 키는 더 쓰지 않는다. 남겨 두면 storedAgents 가 옛 id 를 되살린다.
      agentId: null,
      agentProvider: null
    });
  }

  publishStatus(): void {
    this.services.status({ state: this.state, since: this.since, deviceId: (this.settings.deviceId as string | undefined) ?? null, lastError: this.lastError, activeExecutionId: this.activeExecutionId, providers: this.providers });
  }

  private serverUrl(): string {
    return String(this.settings.serverUrl || 'http://127.0.0.1:4000');
  }

  async start(): Promise<void> {
    this.settings = await this.services.getSettings();
    await this.migrateLegacySettings();
    this.providers = await this.detectProviders();
    this.agents = this.storedAgents();
    await this.loadToken();
    logger.info('daemon start', { serverUrl: this.serverUrl(), hasToken: this.token !== null, deviceId: this.settings.deviceId ?? null, providers: this.providers, projects: this.projects().map((p) => p.path) });
    this.services.sendSchema();
    this.statusTimer = setInterval(() => this.publishStatus(), this.options.statusIntervalMs ?? 60_000);
    if (!this.token) {
      this.setState('idle', this.tokenError ?? { code: 'not_paired', message: 'pairing code 를 입력해 주세요' });
      return;
    }
    await this.connect();
  }

  // 셸에서 토큰을 받아 온다. **실패해도 죽지 않는다** (CLO-9 ①).
  // 셸의 Keychain 읽기는 ad-hoc 재빌드 뒤 ACL 프롬프트에 걸려 오래 끌거나 실패할 수 있는데,
  // 예전에는 그 오류가 start() 밖으로 나가 CLI 가 exit 1 → 셸이 백오프 재시작 → 프롬프트 재발 루프였다.
  // 지금은 사유를 lastError 에 담아 not_paired 로 떨어지고, 셸이 다시 알려 주면(settings.changed) 재시도한다.
  private async loadToken(): Promise<void> {
    this.tokenError = null;
    try {
      this.token = await this.services.getToken();
    } catch (e) {
      this.token = null;
      const message = e instanceof Error ? e.message : String(e);
      this.tokenError = { code: 'token_unavailable', message: `디바이스 토큰을 읽지 못했습니다: ${message}` };
      logger.warn('token.get 실패 — 토큰 없이 대기합니다', { message });
    }
    // 개발·CI 용 우회: 셸이 토큰을 주지 못할 때(예: 화면 잠금으로 Keychain 프롬프트 불가) 환경변수로 받는다. 제품 경로는 Keychain/파일이다.
    if (!this.token && process.env.BATON_DEVICE_TOKEN) {
      this.token = process.env.BATON_DEVICE_TOKEN;
      this.tokenError = null;
      logger.warn('BATON_DEVICE_TOKEN 환경변수 토큰 사용 (개발용)');
    }
  }

  // 셸의 settings.changed: serverUrl 이 바뀌면 재연결
  async applySettings(settings: Record<string, unknown>): Promise<void> {
    const before = this.serverUrl();
    this.settings = settings;
    if (this.serverUrl() !== before) {
      this.handleRevoked(AUTH_FAILURE_REASON);
      await this.credentialReset;
      return;
    }
    if (this.needsPairing) {
      await this.credentialReset;
      return;
    }
    // 토큰 없이 대기 중이면 셸이 뭔가 바뀌었다고 알려 준 김에 다시 읽어 본다.
    // (Keychain 프롬프트에 늦게 응답한 경우 — 데몬을 재시작하지 않고 여기서 회복한다. CLO-9 ①)
    if (!this.token) {
      await this.loadToken();
      if (!this.token) {
        this.setState('idle', this.tokenError ?? { code: 'not_paired', message: 'pairing code 를 입력해 주세요' });
        return;
      }
      logger.info('토큰을 뒤늦게 읽었습니다 — 연결을 시작합니다');
      await this.connect();
      return;
    }
    // 앱에서 프로젝트를 추가하고 "설정 저장" 을 누르면 여기로 온다. 등록은 connect() 안에서만
    // 했기 때문에, 예전에는 저장해도 데몬을 재시작할 때까지 서버에 나타나지 않았다
    // (2026-09-18: 사용자가 프로젝트를 추가했는데 웹 목록에 없었다 — 설정에는 projectId:null 로 남아 있었다).
    if (this.api && needsRegistration(this.projects(), this.providers)) await this.ensureRegistered();
  }

  // 05 §3.4: 웹 "내 디바이스" 에서 발급한 사용자별 코드(XXXX-XXXX)로 pairing. 만료·재사용이면 서버가 403 + 사유를 준다.
  async pair(pairingCode: string, deviceName?: string | null): Promise<{ deviceId: string }> {
    // 이미 연결된 상태에서 다시 pairing 하다 실패하면 SSE 는 그대로 살아 있으므로 원래 상태로 되돌린다 (W5d-2 수정: idle 로 떨어지던 문제)
    await this.credentialReset;
    const pairingServer = this.serverUrl();
    const previous = this.state;
    this.setState('connecting');
    const api = new ApiClient(this.serverUrl(), null);
    try {
      // pairing 에도 heartbeat 와 같은 디바이스 정보를 함께 보낸다 (웹 "내 디바이스" 의 플랫폼 표시용, 09.4 이슈 1)
      const r = await api.pair(pairingCode, deviceName || String(this.settings.deviceName || os.hostname()), deviceInfo());
      if (this.serverUrl() !== pairingServer) throw new Error('pairing 중 서버 주소가 바뀌었습니다. 새 서버에서 다시 연결해 주세요.');
      await this.services.setToken(r.deviceToken);
      // 새로 pairing 하면 이전 디바이스·서버에서 받은 등록 id 는 전부 무효다. 남겨 두면
      // ensureRegistered 가 `if (!this.settings.agentId)` 때문에 Agent 를 다시 등록하지 않고,
      // heartbeat 가 "이 디바이스의 활성 Agent만 보고할 수 있습니다"(403) 로 조용히 실패한다.
      // SSE 는 붙어 있어서 겉보기엔 정상인데 실행이 배정되지 않는다 — 콘솔 login 경로(cli.ts)는
      // 이미 이렇게 하고 있었고, 셸(앱) 경로만 빠져 있었다. 2026-09-18 테스트에서 사용자의
      // Mac 이 정확히 이 상태였다(재-pairing 후 Agent 미등록).
      const relisted = parseProjects(this.settings).map((e) => ({ ...e, projectIds: {} }));
      this.agents = {};
      this.settings = await this.services.setSettings({
        deviceId: r.deviceId,
        ...(r.userId ? { userId: r.userId } : {}),
        agents: '{}',
        agentId: null,
        agentProvider: null,
        projectId: null,
        lastEventId: '',
        projects: serializeProjects(relisted)
      });
      if (this.serverUrl() !== pairingServer) {
        this.handleRevoked(AUTH_FAILURE_REASON);
        await this.credentialReset;
        throw new Error('pairing 중 서버 주소가 바뀌었습니다.');
      }
      this.needsPairing = false;
      this.token = r.deviceToken;
      await this.connect();
      return { deviceId: r.deviceId };
    } catch (e) {
      // String(e) 는 undici 의 "TypeError: fetch failed" 만 남기고 진짜 사유(ECONNREFUSED,
      // ETIMEDOUT, 인증서 오류 …)를 cause 에 묻어 버린다. 실제로 이 메시지만 보고는
      // 주소가 틀렸는지, 막혔는지, 서버가 죽었는지 구분할 수 없었다 (2026-09-18 테스트).
      const err = e instanceof ApiError ? Daemon.pairingError(e) : { code: 'server_unreachable', message: `${Daemon.describe(e)} (서버 ${this.serverUrl()})` };
      this.setState(this.token && previous !== 'idle' ? previous : 'idle', err);
      throw Object.assign(new Error(err.message), { code: err.code });
    }
  }

  // fetch 실패의 cause 사슬을 풀어 사람이 읽을 수 있는 한 줄로 만든다.
  static describe(e: unknown): string {
    const parts: string[] = [];
    let cur: unknown = e;
    for (let depth = 0; cur instanceof Error && depth < 4; depth += 1) {
      const code = (cur as { code?: string }).code;
      parts.push(code ? `${cur.message} [${code}]` : cur.message);
      cur = (cur as { cause?: unknown }).cause;
    }
    return parts.length ? parts.join(' ← ') : String(e);
  }

  // 403(만료·재사용·미발급) 과 400(형식 오류) 은 서버 사유를 그대로 셸 팝오버에 보여 준다.
  static pairingError(e: ApiError): { code: string; message: string } {
    if (e.status === 403 || e.status === 400 || e.status === 404) {
      return { code: 'invalid_pairing_code', message: e.serverMessage ?? 'pairing 코드가 올바르지 않습니다 (웹 → 내 디바이스에서 발급한 코드를 입력하세요)' };
    }
    return { code: 'server_unreachable', message: e.serverMessage ?? e.message };
  }

  private async connect(): Promise<void> {
    if (!this.token) return;
    this.setState('connecting', null);
    const api = new ApiClient(this.serverUrl(), this.token, () => {
      // 예전 연결의 늦은 401이 새 pairing을 해제하지 않도록 소유 연결을 확인한다.
      if (this.api === api) this.handleRevoked(AUTH_FAILURE_REASON);
    });
    this.api = api;
    // 설치 상태는 바뀔 수 있다(codex 를 나중에 깔았다든지). 연결할 때마다 다시 본다.
    if (!this.providers.length) this.providers = await this.detectProviders();
    if (this.api !== api) return;
    await this.ensureRegistered();
    if (this.api !== api || !this.token) return;
    this.sse?.stop();
    this.sse = new SseClient({
      url: `${this.api.base}/v1/desktop/events/stream`,
      token: this.token,
      getLastEventId: () => String(this.settings.lastEventId ?? ''),
      onEvent: (ev) => this.handleEvent(ev),
      onConnected: () => {
        if (this.state !== 'running') this.setState('connected', null);
        const presence = this.state === 'running' ? 'BUSY' : 'ONLINE';
        for (const agentId of Object.values(this.agents)) this.api?.reportPresence(agentId, presence).catch(() => undefined);
      },
      onDisconnected: (reason) => {
        if (this.state !== 'running') this.setState('connecting', { code: 'server_unreachable', message: reason });
      },
      onAuthFailure: () => { if (this.api === api) this.handleRevoked(AUTH_FAILURE_REASON); },
      onFatal: (reason) => this.handleConnectionReplaced(reason)
    });
    this.sse.start();
    this.startHeartbeat();
  }

  // 02 §7.4: 60초 주기 heartbeat. 디바이스 정보 + 현재 실행 상태를 보내고, 실패는 로그만 남기고 계속한다.
  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const interval = this.options.heartbeatIntervalMs ?? Number(process.env.BATON_HEARTBEAT_INTERVAL_MS ?? 60_000);
    void this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), interval);
    this.heartbeatTimer.unref?.();
  }

  async sendHeartbeat(): Promise<void> {
    const api = this.api;
    if (!api || this.stopped) return;
    // capability 는 provider 마다 다르다. 서버도 heartbeat 의 agentId 로 해당 Agent 만
    // 갱신하므로(desktop.service heartbeat), 등록된 Agent 마다 한 번씩 보낸다.
    const targets = Object.entries(this.agents);
    const base = {
      ...deviceInfo(),
      deviceId: (this.settings.deviceId as string | undefined) ?? null,
      state: this.state,
      activeExecutionIds: [...this.running.keys()],
      at: nowIso()
    };
    try {
      if (!targets.length) {
        const ok = await api.heartbeat({ ...base, agentId: null });
        if (!ok) logger.debug('heartbeat 미구현 서버 (404) — 건너뜀');
        return;
      }
      for (const [provider, agentId] of targets) {
        const ok = await api.heartbeat({ ...base, agentId, capabilities: registrationCapabilities(this.registry.get(provider as AgentProvider)), ...(this.models[provider] ? { models: this.models[provider] } : {}) });
        if (!ok) logger.debug('heartbeat 미구현 서버 (404) — 건너뜀');
      }
    } catch (e) {
      // 서버가 잠시 죽어도 데몬은 계속 돈다 (SSE 재연결이 복구를 담당)
      logger.warn('heartbeat 실패 (계속 진행)', { message: String(e) });
    }
  }

  // 서버가 디바이스당 SSE 1개를 강제한다(apps/server desktop/connections.ts). 새 데몬이 붙으면 이 연결에
  // `connection.replaced` 를 보내고 끊는다 → 재연결하지 않고 셸에 알린 뒤 종료한다 (04 §11.2).
  private handleConnectionReplaced(reason: string): void {
    if (this.stopped) return;
    const message = reason || '다른 데몬 연결로 대체되었습니다';
    logger.error('SSE 가 다른 연결로 대체됨 — 재연결하지 않고 종료', { reason: message });
    this.services.log('error', `다른 데몬이 이 디바이스에 연결되어 종료합니다: ${message}`);
    this.setState('idle', { code: 'connection_replaced', message });
    void this.shutdown().finally(() => this.options.onFatal?.(message));
  }

  // 웹에서 디바이스를 해제했을 때. 연결만 정리하고 pairing 대기 상태로 돌아간다.
  private handleRevoked(reason: string): void {
    if (this.stopped) return;
    this.needsPairing = true;
    logger.warn('디바이스 연결 해제됨 — pairing 대기 상태로 돌아갑니다', { reason });
    this.services.log('warn', `${reason} 새 pairing 코드로 다시 연결해 주세요.`);
    this.sse?.stop();
    this.sse = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    // 죽은 토큰과 등록 id 를 들고 있으면 다시 pairing 해도 옛 Agent 를 재사용하려 한다.
    this.token = null;
    this.api?.invalidate();
    this.api = null;
    this.agents = {};
    const cleared = { deviceId: null, userId: null, agents: '{}', agentId: null, agentProvider: null, projectId: null, lastEventId: '', projects: serializeProjects(this.projects().map(p => ({ ...p, projectIds: {} }))) };
    this.settings = { ...this.settings, ...cleared };
    // 겹친 인증 실패는 직렬로 정리하고 새 pairing은 이 작업 뒤에만 시작한다.
    this.credentialReset = this.credentialReset.then(async () => {
      await this.services.setToken(null).catch(() => undefined);
      await this.services.setSettings(cleared).catch(() => undefined);
    });
    this.setState('idle', { code: 'not_paired', message: `${reason} 새 pairing 코드를 입력해 주세요.` });
  }

  // 설정의 프로젝트 목록 (04 §11.1). 구버전 projectPath 는 start() 에서 이 목록으로 옮긴다.
  projects(): ProjectEntry[] {
    return parseProjects(this.settings);
  }

  // Agent·Project 등록 (01 §5.3). 프로젝트 목록의 각 항목을 Project 로 등록하고 projectId 를 설정에 되돌려 저장한다.
  // 서버가 미구현이면 id 없이 진행한다.
  private async ensureRegistered(): Promise<void> {
    const api = this.api;
    if (!api) return;
    try {
      const deviceName = String(this.settings.deviceName || os.hostname());
      let agentsChanged = false;
      for (const provider of this.providers) {
        if (this.agents[provider]) continue;
        const adapter = this.registry.get(provider);
        const agentId = await api.registerAgent(`${adapter.getCapabilities().displayName} @ ${deviceName}`, provider, registrationCapabilities(adapter), this.models[provider]);
        if (this.api !== api) return;
        if (!agentId) continue; // 서버 미구현(404)
        this.agents[provider] = agentId;
        agentsChanged = true;
        logger.info('agent 등록', { provider, agentId });
      }
      if (agentsChanged) await this.saveAgents();
      if (this.api !== api) return;
      if (!Object.keys(this.agents).length) return;
      // 등록을 막지 않는다. 결과는 다음 heartbeat 에 실려 나간다.
      void this.refreshModels();

      // 서버의 Project 는 Agent 소속이라 같은 경로라도 provider 마다 따로 등록한다.
      const list = this.projects();
      let registered = 0;
      for (const entry of list) {
        for (const [provider, agentId] of Object.entries(this.agents)) {
          if (entry.projectIds[provider]) continue;
          const projectId = await api.registerProject(agentId, entry.name, entry.path);
          if (this.api !== api) return;
          if (!projectId) break; // 서버 미구현(404) — 나머지도 안 될 것이므로 그만둔다
          entry.projectIds[provider] = projectId;
          registered += 1;
          logger.info('project 등록', { provider, projectId, name: entry.name, path: entry.path });
        }
      }
      if (registered) this.settings = await this.services.setSettings({ projects: serializeProjects(list) });
    } catch (e) {
      logger.warn('agent/project 등록 실패 (계속 진행)', { message: String(e) });
    }
  }

  // 실행 명령의 projectId → 로컬 경로. 매핑에 없으면 사유를 돌려준다 (호출자가 FAILED 로 보고).
  private resolveProjectRoot(cmd: ExecutionCommand): { root: string; entry: ProjectEntry | null } | { error: string } {
    const list = this.projects();
    if (!list.length) {
      return { error: '이 디바이스에 등록된 프로젝트가 없습니다. 셸 설정 탭 → 프로젝트 목록에 이름과 로컬 경로를 추가하세요.' };
    }
    const projectId = typeof cmd.projectId === 'string' ? cmd.projectId : null;
    if (!projectId) {
      // 구버전 서버(projectId 없음) 는 첫 프로젝트로 실행한다.
      logger.warn('실행 명령에 projectId 가 없어 첫 프로젝트로 실행', { executionId: cmd.executionId, path: list[0].path });
      return { root: list[0].path, entry: list[0] };
    }
    const entry = findByProjectId(list, projectId);
    if (!entry) {
      const known = list.map((e) => `${e.name}(${Object.values(e.projectIds).filter(Boolean).join('/') || '미등록'})`).join(', ');
      return { error: `projectId ${projectId} 에 해당하는 로컬 프로젝트가 이 디바이스에 없습니다. 등록된 프로젝트: ${known || '없음'}. 셸 설정 탭에서 프로젝트를 추가한 뒤 다시 실행하세요.` };
    }
    return { root: entry.path, entry };
  }

  private async handleEvent(ev: SseEvent): Promise<void> {
    logger.info('sse event', { id: ev.id, type: ev.type });
    let data: unknown;
    try {
      data = JSON.parse(ev.data);
    } catch {
      logger.warn('sse event data 가 JSON 이 아님', { id: ev.id });
      return;
    }
    const eventName = ev.type !== 'message' ? ev.type : String((data as Record<string, unknown>)?.eventName ?? '');
    if (eventName === 'execution.command.requested') {
      const parsed = ExecutionCommandSchema.safeParse({ eventName, ...(data as Record<string, unknown>) });
      if (!parsed.success) {
        logger.warn('execution.command.requested payload 오류', { issues: parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message) });
        await this.advanceLastEventId(ev.id);
        return;
      }
      // 처리 시작 시점에 lastEventId 를 올리면 실행 중 크래시 시 명령을 잃는다. 실행을 큐에 넣은 뒤 올린다.
      void this.enqueue(parsed.data);
      await this.advanceLastEventId(ev.id);
      return;
    }
    if (eventName === 'execution.command.cancel_requested') {
      const parsed = ExecutionCancelSchema.safeParse({ eventName, ...(data as Record<string, unknown>) });
      if (parsed.success) await this.handleCancel(parsed.data.executionId, parsed.data.requestId ?? null, parsed.data.reason ?? '사용자가 실행을 취소했습니다');
      else logger.warn('execution.command.cancel_requested payload 오류', { issues: parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message) });
      await this.advanceLastEventId(ev.id);
      return;
    }
    // 서버가 디바이스당 SSE 1개를 강제한다. 이 두 이벤트에는 `id:` 가 없으므로 lastEventId 를 올리지 않는다.
    if (eventName === 'connection.replaced') {
      const c = ConnectionReplacedSchema.safeParse(data);
      this.handleConnectionReplaced((c.success && c.data.reason) || '다른 데몬 연결로 대체되었습니다');
      return;
    }
    // 사람이 웹에서 이 디바이스를 해제했다. **종료하지 않는다** — 토큰만 죽은 것이고
    // 곧 새 코드로 다시 pairing 할 수 있어야 한다. 예전에는 이것도 replaced 로 와서
    // 데몬이 exit 17 로 죽고 셸이 재시작을 포기했다(= "daemon not running").
    if (eventName === 'connection.revoked') {
      const c = ConnectionReplacedSchema.safeParse(data);
      this.handleRevoked((c.success && c.data.reason) || '디바이스 연결이 해제되었습니다');
      return;
    }
    if (eventName === 'connection.ready') {
      logger.info('sse connection.ready');
      return;
    }
    // 그 밖의 connection.* 제어 프레임도 outbox 커서를 옮기지 않는다 (id 가 연결별 일련번호라 커서로 쓸 수 없다)
    if (eventName.startsWith('connection.')) {
      logger.info('sse 제어 프레임 무시', { eventName });
      return;
    }
    if (eventName === 'request.delivered' || eventName === 'request.notify') {
      const n = RequestNotifyEventSchema.safeParse({ eventName, ...(data as Record<string, unknown>) });
      if (n.success) {
        // 05 §3.2: recipientTeam 이 있고 recipientUserId 가 명시적으로 null 이면 팀 전체 뿌리기 → "팀 infra 에 새 요청".
        // 서버는 사람 지정 요청에도 recipientTeam 을 넣으므로, 필드가 없으면(undefined) 사람 지정으로 본다.
        const team = teamName(n.data.recipientTeam);
        const broadcast = team !== null && n.data.recipientUserId === null;
        const notificationId = `ntf_req_${n.data.requestId}`;
        this.deliveredNotifications.set(n.data.requestId, notificationId);
        await this.services.notify({
          notificationId,
          kind: 'request.delivered',
          requestId: n.data.requestId,
          title: n.data.followup ? '이어서 요청이 왔습니다' : broadcast ? `팀 ${team} 에 새 요청` : '새로운 Baton 요청',
          // 서버가 발신자 이름을 모르면 아무것도 보내지 않는다. 여기서 'A' 같은 기호를
          // 채워 넣으면 알림에 없는 사람 이름이 뜬다 (2026-09-21 전수조사 결함 11).
          body: `${n.data.senderName ? `${n.data.senderName} → ` : ''}${broadcast ? `팀 ${team}` : '나'} · ${n.data.title ?? n.data.requestId}`,
          webUrl: n.data.webUrl ?? null
        }).catch(() => undefined);
      } else {
        logger.warn('request.delivered payload 오류', { issues: n.error.issues.map((i) => i.path.join('.') + ' ' + i.message) });
      }
      await this.advanceLastEventId(ev.id);
      return;
    }
    if (eventName === 'request.withdrawn') {
      const withdrawn = RequestNotifyEventSchema.safeParse({ eventName, ...(data as Record<string, unknown>) });
      if (withdrawn.success) {
        const requestId = withdrawn.data.requestId;
        const notificationId = this.deliveredNotifications.get(requestId) ?? `ntf_req_${requestId}`;
        await this.services.dismiss({ notificationId, requestId, reason: 'withdrawn', note: '요청이 철회되었습니다', claimedBy: null }).catch(() => undefined);
        this.deliveredNotifications.delete(requestId);
        await this.services.notify({ notificationId: `ntf_withdrawn_${requestId}`, kind: 'request.delivered',
          requestId, title: '요청이 철회되었습니다', body: withdrawn.data.title ?? '', webUrl: withdrawn.data.webUrl ?? null });
      }
      await this.advanceLastEventId(ev.id);
      return;
    }
    if (eventName === 'request.claimed') {
      const c = RequestClaimedEventSchema.safeParse({ eventName, ...(data as Record<string, unknown>) });
      if (c.success) {
        const myUserId = typeof this.settings.userId === 'string' ? this.settings.userId : null;
        const claimerId = userRefId(c.data.claimedBy);
        const self = c.data.self === true || (myUserId !== null && claimerId !== null && claimerId === myUserId);
        const name = userDisplayName(c.data.claimedBy);
        if (self) {
          // 내가 처리한 요청: 배너는 그대로 두고 로그만 남긴다 (서버는 원래 나머지 팀원에게만 보낸다, 05 §3.2)
          logger.info('request.claimed (본인) 무시', { requestId: c.data.requestId });
        } else {
          const notificationId = this.deliveredNotifications.get(c.data.requestId) ?? `ntf_req_${c.data.requestId}`;
          this.deliveredNotifications.delete(c.data.requestId);
          await this.services.dismiss({ notificationId, requestId: c.data.requestId, reason: 'claimed', note: `처리 중: ${name}`, claimedBy: name }).catch(() => undefined);
        }
      } else {
        logger.warn('request.claimed payload 오류', { issues: c.error.issues.map((i) => i.path.join('.') + ' ' + i.message) });
      }
      await this.advanceLastEventId(ev.id);
      return;
    }
    logger.debug('sse event ignored', { eventName });
    await this.advanceLastEventId(ev.id);
  }

  private async advanceLastEventId(id: string): Promise<void> {
    if (!id) return; // `id:` 없는 이벤트(connection.*)는 커서를 옮기지 않는다
    try {
      this.settings = await this.services.setSettings({ lastEventId: id });
    } catch (e) {
      logger.warn('lastEventId 저장 실패', { message: String(e) });
    }
  }

  // 01 §5.4 execution.command.cancel_requested: 진행 중인 claude 를 SIGTERM→SIGKILL 로 끝내고 CANCELLED 로 보고한다.
  // 서버는 취소 시점에 이미 Execution 을 CANCELLED 로 바꾸므로 사후 보고는 실패할 수 있다(로그만 남긴다).
  async handleCancel(executionId: string, requestId: string | null, reason: string): Promise<void> {
    this.cancelRequested.add(executionId);
    const runner = this.runners.get(executionId);
    this.progress(executionId, requestId, 'cancelled', `실행 취소 요청: ${reason}`);
    if (runner) {
      logger.info('execution 취소 — claude 종료 (SIGTERM→SIGKILL)', { executionId, reason });
      runner.cancel();
      return; // 결과 보고는 execute() 의 완료 경로가 담당한다
    }
    if (this.handled.has(executionId)) {
      // 큐에서 대기 중이던 실행: 시작하지 않고 CANCELLED 로 보고한다 (실제 보고는 큐 차례가 왔을 때)
      logger.info('execution 취소 — 아직 시작하지 않아 실행하지 않음', { executionId, reason });
      return;
    }
    // 명령보다 취소가 먼저 온 경우: cancelRequested 에 남겨 두고 명령이 오면 실행하지 않는다
    logger.info('execution 취소 — 알 수 없는 executionId (선취소로 기록)', { executionId, reason });
    await this.reportCancelled(executionId, requestId, reason, null);
  }

  private progress(executionId: string | null, requestId: string | null, phase: string, message: string): void {
    this.services.progress({ executionId, requestId, phase, message, at: nowIso() });
  }

  // CLO-11 취소된 실행의 부분 결과: 취소 시점까지 claude 가 만든 3계층 결과(계층1 structuredPatch · 계층2 git diff ·
  // 계층3 result.md)를 모아 status=CANCELLED 로 올린다. 서버는 **이미 CANCELLED 인** Execution 에만 PARTIAL Result 를
  // upsert 하고 Request 상태는 그대로 둔다(01 §5.3). 부분 결과는 승인 대상이 아니다.
  // 수집된 것이 하나도 없으면 아무것도 보내지 않는다 — 웹이 그 회차를 '취소됨 (수집된 변경 없음)' 으로 보여 준다.
  // 업로드·보고 실패는 로그만 남긴다. 취소 자체는 이미 서버에서 끝났으므로 여기서 실패해도 되돌릴 것이 없다.
  private async uploadPartialResult(api: ApiClient, cmd: ExecutionCommand, result: RunResult): Promise<boolean> {
    const { collected, dir } = result;
    const gitPatch = !!collected.layer2?.patch.trim();
    const hasPatch = gitPatch || !!collected.layer1.patch.trim();
    if (!collected.changedFiles.length && !hasPatch && !collected.resultMd) return false;
    const uploads: { kind: string; file: string; mime: string }[] = [];
    if (hasPatch) uploads.push({ kind: 'PATCH', file: gitPatch ? dir.gitPatchPath : dir.streamPatchPath, mime: 'text/x-patch' });
    if (collected.resultMd) uploads.push({ kind: 'RESULT_ATTACHMENT', file: dir.resultMdPath, mime: 'text/markdown' });
    const artifactIds: string[] = [];
    for (const u of uploads) {
      try {
        const id = await api.uploadArtifact({ teamId: cmd.teamId, requestId: cmd.requestId, kind: u.kind, filePath: u.file, mimeType: u.mime });
        if (id) artifactIds.push(id);
      } catch (e) {
        logger.warn('부분 결과 artifact 업로드 실패 (부분 결과 보고는 계속한다)', { file: u.file, message: String(e) });
      }
    }
    const summary = collected.resultMd?.match(/## 요약\s*\n([\s\S]*?)(\n## |$)/)?.[1]?.trim() || `취소 시점까지 수집된 부분 변경입니다 (변경 파일 ${collected.changedFiles.length}개).`;
    try {
      await api.reportResult(cmd.executionId, { status: 'CANCELLED', summary: summary.slice(0, 10000), changedFiles: collected.changedFiles, artifactIds });
    } catch (e) {
      logger.warn('취소 부분 결과 보고 실패 (취소 자체는 완료됨)', { executionId: cmd.executionId, message: String(e) });
      return false;
    }
    logger.info('취소 부분 결과 보고 완료', { executionId: cmd.executionId, changedFiles: collected.changedFiles.length, artifacts: artifactIds.length });
    this.progress(cmd.executionId, cmd.requestId, 'note', `취소 시점까지의 부분 결과를 보고했습니다 (변경 파일 ${collected.changedFiles.length}개, 산출물 ${artifactIds.length}개)`);
    return true;
  }

  // 서버가 시킨 취소는 서버가 이미 Execution 을 CANCELLED 로 확정한 뒤라(01 §5.4) 상태를 되돌리지 않는다.
  // partial 이 있으면 그 시점까지의 부분 결과만 덧붙인다 (CLO-11). 없으면 알림만 띄운다.
  private async reportCancelled(executionId: string, requestId: string | null, reason: string, partial: { api: ApiClient; cmd: ExecutionCommand; result: RunResult } | null): Promise<void> {
    const reported = partial ? await this.uploadPartialResult(partial.api, partial.cmd, partial.result) : false;
    logger.info('execution 취소 완료', { executionId, reason, partialReported: reported });
    await this.services.notify({ notificationId: `ntf_done_${executionId}`, kind: 'generic', requestId, title: '작업 취소됨', body: reason.slice(0, 120), webUrl: null }).catch(() => undefined);
  }

  // 서버가 시킨 취소가 아닌데 실행이 중단된 경우(데몬 종료·stdin EOF). 서버는 아직 RUNNING 으로 알고 있으므로
  // FAILED 로 알려서 Execution 이 영원히 RUNNING 에 남지 않게 한다.
  private async reportInterrupted(api: ApiClient, cmd: ExecutionCommand, changedFiles: string[]): Promise<void> {
    const reason = '데몬이 종료되어 실행이 중단되었습니다';
    await api
      .reportResult(cmd.executionId, { status: 'FAILED', failureReason: reason, summary: `실행 중단: ${reason}`, changedFiles, artifactIds: [] })
      .catch((e) => logger.warn('중단 보고 실패', { executionId: cmd.executionId, message: String(e) }));
    await this.services.notify({ notificationId: `ntf_done_${cmd.executionId}`, kind: 'execution.failed', requestId: cmd.requestId, title: '작업 중단됨', body: reason, webUrl: cmd.webUrl ?? null }).catch(() => undefined);
  }

  private async enqueue(cmd: ExecutionCommand): Promise<void> {
    if (this.handled.has(cmd.executionId)) {
      logger.info('execution 중복 명령 무시', { executionId: cmd.executionId });
      return;
    }
    this.handled.add(cmd.executionId);
    if (this.cancelRequested.has(cmd.executionId)) {
      logger.info('execution 이 이미 취소됨 — 실행하지 않음', { executionId: cmd.executionId });
      this.progress(cmd.executionId, cmd.requestId, 'cancelled', '취소된 실행이라 시작하지 않습니다');
      return;
    }
    // 04 §11.1: 명령의 projectId 를 로컬 경로로 바꾼다. 매핑이 없으면 실행하지 않고 사유를 서버에 보고한다.
    const resolved = this.resolveProjectRoot(cmd);
    if ('error' in resolved) {
      logger.error('projectId 매핑 없음 — FAILED 로 보고', { executionId: cmd.executionId, projectId: cmd.projectId, reason: resolved.error });
      this.progress(cmd.executionId, cmd.requestId, 'failed', resolved.error);
      await this.api?.reportStatus(cmd.executionId, 'RUNNING', 'projectId 매핑 확인').catch(() => undefined);
      await this.api?.reportResult(cmd.executionId, { status: 'FAILED', failureReason: resolved.error, summary: `실행 실패: ${resolved.error}`, changedFiles: [], artifactIds: [] }).catch((e) => logger.warn('FAILED 보고 실패', { message: String(e) }));
      await this.services.notify({ notificationId: `ntf_done_${cmd.executionId}`, kind: 'execution.failed', requestId: cmd.requestId, title: '작업 실패 · 프로젝트 매핑 없음', body: resolved.error.slice(0, 120), webUrl: cmd.webUrl ?? null }).catch(() => undefined);
      return;
    }
    const projectRoot = resolved.root;
    logger.info('execution 프로젝트 선택', { executionId: cmd.executionId, projectId: cmd.projectId ?? null, name: resolved.entry?.name ?? null, projectRoot });
    await this.services.notify({ notificationId: `ntf_exec_${cmd.executionId}`, kind: 'generic', requestId: cmd.requestId, title: 'Baton 요청 실행 시작', body: cmd.title ? `${cmd.title}` : `Execution ${cmd.executionId.slice(0, 8)}`, webUrl: cmd.webUrl ?? null }).catch(() => undefined);
    await this.queue.run(projectRoot, cmd.executionId, () => this.execute(cmd, projectRoot));
  }

  private async execute(cmd: ExecutionCommand, projectRoot: string): Promise<void> {
    const api = this.api;
    if (!api) return;
    const executionId = cmd.executionId;
    // 이 디바이스가 등록한 Agent 중 명령이 가리키는 것을 찾는다. 등록하지 않은 provider
    // (그 CLI 가 이 기기에 없다) 나 남의 Agent id 면 실행하지 않는다.
    // provider 는 서버가 실어 보낸다. 구버전 서버가 빠뜨리면 agentId 로 되짚는다 —
    // 추측(첫 번째 등록)으로 떨어지면 다른 provider 를 고른 실행이 통째로 실패한다.
    const byAgentId = cmd.agentId
      ? (Object.entries(this.agents).find(([, id]) => id === cmd.agentId)?.[0] as AgentProvider | undefined)
      : undefined;
    const provider = cmd.provider ?? byAgentId ?? (Object.keys(this.agents)[0] as AgentProvider | undefined) ?? 'CLAUDE_CODE';
    const agentId = this.agents[provider];
    if (!agentId || (cmd.agentId && cmd.agentId !== agentId)) {
      const known = Object.entries(this.agents).map(([p, id]) => `${p}=${id.slice(0, 8)}`).join(', ') || '없음';
      await api.reportStatus(executionId, 'RUNNING', 'Agent/provider 매핑 확인').catch(() => undefined);
      await api.reportResult(executionId, { status: 'FAILED', failureReason: `이 디바이스에 등록된 Agent 와 명령이 일치하지 않습니다 (명령 provider: ${provider}, agentId: ${(cmd.agentId ?? '없음').slice(0, 8)}, 등록: ${known})`, summary: 'Agent/provider 매핑 오류', changedFiles: [], artifactIds: [] });
      return;
    }
    const adapter = this.registry.get(provider);
    // 큐에서 기다리는 사이에 취소되었을 수 있다 (04 §11.3)
    if (this.cancelRequested.has(executionId)) {
      logger.info('큐 대기 중 취소된 execution — 시작하지 않음', { executionId });
      this.progress(executionId, cmd.requestId, 'cancelled', '대기 중 취소되어 실행하지 않습니다');
      await this.reportCancelled(executionId, cmd.requestId, '대기 중 취소됨', null);
      return;
    }
    // §18 추가 작업 요청: 서버가 이어갈 claude 세션 id 를 준다 (없으면 평소처럼 새 세션).
    const followUpOf = cmd.resumeSessionId?.trim() || null;
    this.activeExecutionId = executionId;
    this.running.set(executionId, projectRoot);
    this.setState('running', null);
    if (agentId) api.reportPresence(agentId, 'BUSY').catch(() => undefined);
    try {
      // 실행 시작 보고. §18 추가 작업이면 이어갈 세션 id 를 이 시점에 이미 알고 있으므로 함께 싣는다
      // (진짜 세션 id 는 아래 'started' 진행 보고에서 stream-json system/init 값으로 확정한다).
      await api.reportStatus(executionId, 'RUNNING', followUpOf ? `${adapter.getCapabilities().displayName} adapter started (추가 작업 · resume ${followUpOf.slice(0, 8)}…)` : `${adapter.getCapabilities().displayName} adapter started`, undefined, followUpOf ?? cmd.claudeSessionId ?? null);
    } catch (e) {
      // 409 = 이미 다른 데몬(같은 디바이스 토큰)이 이 Execution 을 시작했거나 상태가 맞지 않음 → 중복 실행 방지를 위해 포기한다.
      if (e instanceof ApiError && e.status === 409) {
        logger.warn('execution 을 시작할 수 없어 건너뜀 (이미 실행 중이거나 상태 불일치)', { executionId, message: e.message });
        this.activeExecutionId = null;
        this.running.delete(executionId);
        this.setState('connected', null);
        return;
      }
      logger.warn('status RUNNING 보고 실패 (계속 진행)', { message: String(e) });
    }
    const runner = adapter.createRunner();
    this.runners.set(executionId, runner);
    let result: RunResult | null = null;
    try {
      result = await runner.run(
        {
          ...(cmd.policy.approval_mode === 'ask' ? { approvalRequest: (method: string, route: string, body: unknown, signal: AbortSignal) => api.call(method, route, body, signal) } : {}),
          executionId,
          requestId: cmd.requestId,
          title: cmd.title,
          senderName: cmd.senderName,
          originalInstruction: cmd.originalInstruction,
          additionalInstruction: cmd.additionalInstruction,
          previousWork: cmd.previousWork,
          followUpInstruction: cmd.followUpInstruction,
          resumeSessionId: followUpOf,
          policy: cmd.policy,
          projectRoot,
          attachments: cmd.attachments,
          sessionId: cmd.claudeSessionId,
          maxTurns: cmd.limits?.maxTurns ?? (provider === 'CLAUDE_CODE' ? this.options.maxTurns : undefined),
          // 실행마다 사람이 고른 모델이 우선이다. 없으면 데몬 환경변수, 그것도 없으면 CLI 기본값.
          model: cmd.model ?? (provider === 'CODEX' ? this.options.codexModel : provider === 'AGY' ? this.options.agyModel : this.options.model),
          maxBudgetUsd: cmd.limits?.maxBudgetUsd,
          acknowledgedRisks: cmd.acknowledgedRisks,
          inheritedRiskKeys: cmd.inheritedRiskKeys
        },
        {
          onProgress: (ev) => {
            const at = nowIso();
            this.services.progress({ executionId, requestId: cmd.requestId, phase: ev.phase, message: ev.message, at });
            // 'started' 는 stream-json system/init 에서 나온다. 여기 실린 session_id 가 서버가 기억해야 할 진짜 세션 id 다(§18).
            const sessionId = ev.phase === 'started' ? ((ev.detail?.session_id as string | undefined) ?? null) : null;
            api.reportStatus(executionId, 'PROGRESS', ev.message, ev.phase, sessionId).catch((e) => logger.debug('progress 보고 실패', { message: String(e) }));
          }
        }
      );
      await this.report(api, cmd, result);
    } catch (e) {
      logger.error('execution 실패', { executionId, message: String(e) });
      const failureReason = e instanceof Error ? e.message : String(e);
      await api.reportResult(executionId, { status: 'FAILED', failureReason, summary: `실행 실패: ${failureReason}`, changedFiles: [], artifactIds: [] }).catch(() => undefined);
      await this.services.notify({ notificationId: `ntf_done_${executionId}`, kind: 'execution.failed', requestId: cmd.requestId, title: '작업 실패', body: failureReason.slice(0, 120), webUrl: cmd.webUrl ?? null }).catch(() => undefined);
    } finally {
      this.runners.delete(executionId);
      this.running.delete(executionId);
      this.activeExecutionId = null;
      this.setState('connected', null);
      if (agentId) api.reportPresence(agentId, 'ONLINE').catch(() => undefined);
    }
  }

  private async report(api: ApiClient, cmd: ExecutionCommand, result: RunResult): Promise<void> {
    const executionId = cmd.executionId;
    if (result.outcome === 'cancelled') {
      // 서버가 시킨 취소면 부분 결과(CLO-11)를, 데몬이 죽어서 끊긴 것이면 FAILED 를 보고한다.
      this.progress(executionId, cmd.requestId, 'cancelled', `실행이 취소되었습니다 (변경 파일 ${result.collected.changedFiles.length})`);
      if (this.cancelRequested.has(executionId)) await this.reportCancelled(executionId, cmd.requestId, '사용자가 실행을 취소했습니다', { api, cmd, result });
      else await this.reportInterrupted(api, cmd, result.collected.changedFiles);
      return;
    }
    if (result.outcome === 'failed') {
      await api.reportResult(executionId, { status: 'FAILED', failureReason: result.failureReason ?? 'failed', failureCode: result.failureCode, summary: `실행 실패: ${result.failureReason ?? ''}`, changedFiles: result.collected.changedFiles, artifactIds: [] });
      await this.services.notify({ notificationId: `ntf_done_${executionId}`, kind: 'execution.failed', requestId: cmd.requestId, title: '작업 실패', body: (result.failureReason ?? '').slice(0, 120), webUrl: cmd.webUrl ?? null }).catch(() => undefined);
      return;
    }
    // 결과 artifact 업로드 (result.md, changes.patch, stream.jsonl) → artifactIds 로 연결
    const artifactIds: string[] = [];
    const uploads: { kind: string; file: string; mime: string }[] = [
      { kind: 'RESULT_ATTACHMENT', file: result.dir.resultMdPath, mime: 'text/markdown' },
      { kind: 'PATCH', file: result.collected.layer2?.patch.trim() ? result.dir.gitPatchPath : result.dir.streamPatchPath, mime: 'text/x-patch' },
      { kind: 'TEST_OUTPUT', file: result.dir.streamPath, mime: 'application/x-ndjson' }
    ];
    for (const u of uploads) {
      try {
        const id = await api.uploadArtifact({ teamId: cmd.teamId, requestId: cmd.requestId, kind: u.kind, filePath: u.file, mimeType: u.mime });
        if (id) artifactIds.push(id);
      } catch (e) {
        logger.warn('artifact 업로드 실패', { file: u.file, message: String(e) });
      }
    }
    let summary = result.collected.resultMd?.match(/## 요약\s*\n([\s\S]*?)(\n## |$)/)?.[1]?.trim() || result.collected.resultMd?.slice(0, 2000) || '(요약 없음)';
    // CLO-110 H-4-④: 결과물에 시크릿으로 보이는 값이 섞였으면 결과를 막지 않고 경고를 앞에 붙여 수신자가 보게 한다.
    if (result.collected.secretFindings.length) {
      const warning = secretWarningLine(result.collected.secretFindings);
      logger.warn('결과물 시크릿 패턴 탐지', { executionId, findings: result.collected.secretFindings });
      this.progress(executionId, cmd.requestId, 'warning', warning);
      summary = `${warning}\n\n${summary}`;
    }
    await api.reportResult(executionId, {
      status: result.outcome === 'partial' ? 'SUCCEEDED' : 'SUCCEEDED',
      outcome: result.outcome,
      summary: summary.slice(0, 10000),
      changedFiles: result.collected.changedFiles,
      testSummary: result.collected.testSummary ?? undefined,
      artifactIds,
      patch: result.collected.patch.slice(0, 200_000),
      resultMarkdown: result.collected.resultMd?.slice(0, 200_000),
      numTurns: result.numTurns,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      claudeSessionId: result.sessionId
    });
    await this.services.notify({ notificationId: `ntf_done_${executionId}`, kind: 'execution.finished', requestId: cmd.requestId, title: result.outcome === 'partial' ? '작업 부분 완료 · 결과 검토 필요' : '작업 완료 · 결과 검토 필요', body: `${cmd.title ?? executionId.slice(0, 8)} · 변경 파일 ${result.collected.changedFiles.length}`, webUrl: cmd.webUrl ?? null }).catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.sse?.stop();
    // 04 §3.4: 셸 종료 경로에서는 자식 claude 에 SIGINT 를 보낸다 (취소의 SIGTERM 과 구분)
    for (const [, r] of this.runners) r.interrupt();
    if (this.api) {
      for (const agentId of Object.values(this.agents)) await this.api.reportPresence(agentId, 'OFFLINE').catch(() => undefined);
    }
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  get currentState(): DaemonState {
    return this.state;
  }
}
