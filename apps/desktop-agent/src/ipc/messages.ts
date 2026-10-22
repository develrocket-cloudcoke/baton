import { z } from 'zod';

// docs/design/04-shell-daemon-ipc.md §3 메시지 payload 스키마 (데몬이 보내거나 해석하는 것)
export const MessageType = {
  daemonHello: 'daemon.hello',
  daemonStatus: 'daemon.status',
  requestNotify: 'request.notify',
  notificationDismiss: 'notification.dismiss', // 04 §10 (W5d-1 추가): 팀 뿌리기 요청이 claim 되면 배너 제거·알림 탭 갱신
  executionProgress: 'execution.progress',
  settingsSchema: 'settings.schema',
  settingsGet: 'settings.get',
  settingsSet: 'settings.set',
  tokenGet: 'token.get',
  tokenSet: 'token.set',
  daemonLog: 'daemon.log',
  shellHello: 'shell.hello',
  settingsChanged: 'settings.changed',
  pairStart: 'pair.start',
  pairResult: 'pair.result',
  notificationClicked: 'notification.clicked',
  daemonShutdown: 'daemon.shutdown',
  settingsValue: 'settings.value',
  tokenValue: 'token.value',
  ack: 'ack',
  error: 'error'
} as const;

export const SettingsValueSchema = z.record(z.unknown());
export type SettingsMap = Record<string, unknown>;

export const ShellHelloSchema = z.object({
  protocol: z.number().int(),
  shellVersion: z.string(),
  platform: z.string(),
  settings: SettingsValueSchema,
  deviceToken: z.string().nullable()
});
export type ShellHello = z.infer<typeof ShellHelloSchema>;

export const SettingsValuePayloadSchema = z.object({ settings: SettingsValueSchema });
export const TokenValuePayloadSchema = z.object({ deviceToken: z.string().nullable() });
export const SettingsChangedSchema = z.object({ settings: SettingsValueSchema });
export const PairStartSchema = z.object({ pairingCode: z.string().min(1), deviceName: z.string().nullable().optional() });
export const NotificationClickedSchema = z.object({
  notificationId: z.string(),
  requestId: z.string().nullable().optional(),
  webUrl: z.string().nullable().optional(),
  action: z.string(),
  clickedAt: z.string().optional()
});
export const DaemonShutdownSchema = z.object({ reason: z.string() });
export const ErrorPayloadSchema = z.object({ code: z.string(), message: z.string(), retryable: z.boolean().optional() });

export type DaemonState = 'idle' | 'connecting' | 'connected' | 'running';

export interface DaemonStatusPayload {
  state: DaemonState;
  since: string;
  deviceId: string | null;
  lastError: { code: string; message: string; at: string } | null;
  activeExecutionId: string | null;
  /** 이 기기에서 감지돼 서버에 등록된 에이전트 (CLAUDE_CODE, CODEX, AGY) */
  providers?: string[];
}

export interface RequestNotifyPayload {
  notificationId: string;
  kind: string;
  requestId: string | null;
  title: string;
  body: string;
  webUrl: string | null;
}

// 04 §10 notification.dismiss (데몬→셸, request, 응답 ack)
export interface NotificationDismissPayload {
  notificationId: string | null; // 제거할 알림. null 이면 requestId 로 찾는다
  requestId: string | null;
  reason: 'claimed' | 'withdrawn' | 'generic';
  note: string | null; // 알림 탭 항목에 남길 한 줄 (예: "처리 중: 박인프라")
  claimedBy: string | null;
}

export interface ExecutionProgressPayload {
  executionId: string | null;
  requestId: string | null;
  phase: string;
  message: string;
  at: string;
}

export interface SettingsField {
  key: string;
  label: string;
  // 04 §11.1 에서 `projects`(프로젝트 목록, JSON 문자열) 를 추가했다. 셸은 이 타입을 전용 UI 로 그린다.
  type: 'string' | 'url' | 'path' | 'bool' | 'int' | 'projects';
  required?: boolean;
  readonly?: boolean;
  hidden?: boolean;
  default?: unknown;
  help?: string;
}

// 셸 설정 화면이 그릴 필드 (04 §3.3 settings.schema, §4)
export const SETTINGS_SCHEMA: SettingsField[] = [
  { key: 'serverUrl', label: '서버 URL', type: 'url', required: true, default: 'http://127.0.0.1:4000', help: 'Baton 서버 주소' },
  // 04 §11.1: 프로젝트 여러 개. 값은 `[{ name, path, projectIds }]` 의 JSON 문자열이고 셸이 목록 UI 로 편집한다.
  { key: 'projects', label: '프로젝트 목록', type: 'projects', required: false, default: '[]', help: '이름 + 로컬 경로. 설치된 에이전트마다 Project 로 등록되고 실행 명령의 projectId 로 골라 쓴다' },
  { key: 'deviceName', label: '디바이스 이름', type: 'string', required: false, default: null },
  { key: 'deviceId', label: '디바이스 ID', type: 'string', required: false, readonly: true, default: null },
  // provider 는 더 이상 사람이 고르지 않는다. 데몬이 설치된 CLI 를 감지해 각각 Agent 로 등록한다.
  // 값은 `{ "CLAUDE_CODE": "<agentId>", ... }` 의 JSON 문자열이다.
  { key: 'agents', label: '등록된 에이전트', type: 'string', required: false, hidden: true, default: '{}' },
  { key: 'lastEventId', label: '마지막 이벤트', type: 'string', required: false, hidden: true, default: '' },
  // pairing 응답에 userId 가 있으면 저장한다(실서버는 주지 않음). request.claimed 의 본인 판별용.
  { key: 'userId', label: '사용자 ID', type: 'string', required: false, hidden: true, default: null }
];
