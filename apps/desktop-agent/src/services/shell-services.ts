import { IpcChannel } from '../ipc/channel';
import { IpcError } from '../ipc/envelope';
import {
  DaemonStatusPayload,
  ExecutionProgressPayload,
  MessageType,
  NotificationDismissPayload,
  RequestNotifyPayload,
  SETTINGS_SCHEMA,
  SettingsMap,
  SettingsValuePayloadSchema,
  TokenValuePayloadSchema
} from '../ipc/messages';
import { LocalSettingsStore } from '../settings/store';
import { logger } from '../util/log';

// 데몬이 필요로 하는 "셸 기능" 추상화. 셸(IPC)이 있으면 셸이, 없으면 로컬 파일·콘솔이 담당한다.
export interface ShellServices {
  getSettings(): Promise<SettingsMap>;
  setSettings(patch: SettingsMap): Promise<SettingsMap>;
  getToken(): Promise<string | null>;
  setToken(token: string | null): Promise<void>;
  status(payload: DaemonStatusPayload): void;
  notify(payload: RequestNotifyPayload): Promise<void>;
  dismiss(payload: NotificationDismissPayload): Promise<void>;
  progress(payload: ExecutionProgressPayload): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  sendSchema(): void;
}

// 셸이 Keychain/UserDefaults 를 대행한다 (04 §3.3 settings.*/token.*)
export class IpcShellServices implements ShellServices {
  private cache: SettingsMap = {};
  private token: string | null = null;

  constructor(
    private readonly channel: IpcChannel,
    initial: { settings: SettingsMap; deviceToken: string | null }
  ) {
    this.cache = initial.settings;
    this.token = initial.deviceToken;
  }

  updateFromShell(settings: SettingsMap): void {
    this.cache = settings;
  }

  async getSettings(): Promise<SettingsMap> {
    const env = await this.channel.request(MessageType.settingsGet, {});
    const parsed = SettingsValuePayloadSchema.safeParse(env.payload);
    if (!parsed.success) throw new IpcError('invalid_payload', 'settings.value payload');
    this.cache = parsed.data.settings;
    return this.cache;
  }

  async setSettings(patch: SettingsMap): Promise<SettingsMap> {
    const env = await this.channel.request(MessageType.settingsSet, { patch });
    const parsed = SettingsValuePayloadSchema.safeParse(env.payload);
    if (!parsed.success) throw new IpcError('invalid_payload', 'settings.value payload');
    this.cache = parsed.data.settings;
    return this.cache;
  }

  async getToken(): Promise<string | null> {
    const env = await this.channel.request(MessageType.tokenGet, {});
    const parsed = TokenValuePayloadSchema.safeParse(env.payload);
    if (!parsed.success) throw new IpcError('invalid_payload', 'token.value payload');
    this.token = parsed.data.deviceToken;
    return this.token;
  }

  async setToken(token: string | null): Promise<void> {
    await this.channel.request(MessageType.tokenSet, { deviceToken: token });
    this.token = token;
  }

  status(payload: DaemonStatusPayload): void {
    this.channel.send(MessageType.daemonStatus, payload as unknown as Record<string, unknown>);
  }

  async notify(payload: RequestNotifyPayload): Promise<void> {
    await this.channel.request(MessageType.requestNotify, payload as unknown as Record<string, unknown>);
  }

  async dismiss(payload: NotificationDismissPayload): Promise<void> {
    await this.channel.request(MessageType.notificationDismiss, payload as unknown as Record<string, unknown>);
  }

  progress(payload: ExecutionProgressPayload): void {
    this.channel.send(MessageType.executionProgress, payload as unknown as Record<string, unknown>);
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.channel.send(MessageType.daemonLog, { level, message });
  }

  sendSchema(): void {
    this.channel.send(MessageType.settingsSchema, { fields: SETTINGS_SCHEMA });
  }
}

// 셸 없이 `baton start` 로 실행할 때: 파일 저장 + 콘솔(stderr) 표시
export class LocalShellServices implements ShellServices {
  constructor(private readonly store = new LocalSettingsStore()) {}

  async getSettings(): Promise<SettingsMap> {
    return this.store.all();
  }

  async setSettings(patch: SettingsMap): Promise<SettingsMap> {
    return this.store.apply(patch);
  }

  async getToken(): Promise<string | null> {
    return this.store.getToken();
  }

  async setToken(token: string | null): Promise<void> {
    this.store.setToken(token);
  }

  status(payload: DaemonStatusPayload): void {
    logger.info(`status ${payload.state}`, { deviceId: payload.deviceId, lastError: payload.lastError?.message ?? null });
  }

  async notify(payload: RequestNotifyPayload): Promise<void> {
    logger.info(`🔔 ${payload.title} — ${payload.body}`, { requestId: payload.requestId, webUrl: payload.webUrl });
  }

  async dismiss(payload: NotificationDismissPayload): Promise<void> {
    logger.info(`🔕 알림 제거 (${payload.reason}) ${payload.note ?? ''}`, { notificationId: payload.notificationId, requestId: payload.requestId });
  }

  progress(payload: ExecutionProgressPayload): void {
    logger.info(`▸ ${payload.phase.padEnd(16)} ${payload.message}`, { executionId: payload.executionId });
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    logger[level](message);
  }

  sendSchema(): void {
    // 콘솔 모드에는 설정 화면이 없다
  }
}
