#!/usr/bin/env node
import { runApprovalMcp } from './adapter/claude-code/approval-mcp';
// Baton Desktop 데몬 CLI.
//   baton login --code <pairing code> [--server <url>] [--name <device name>]   콘솔 모드 pairing (파일 저장)
//   baton start [--server <url>] [--project <path>]                             셸 없이 콘솔 모드로 실행
//   baton daemon --ipc stdio                                                     셸(apps/desktop-macos)의 자식으로 실행
//   baton status                                                                 로컬 설정·토큰 상태 출력
//   baton hook <canary|pretool|posttool> --policy <policy.json>                  Claude Code hook 진입점 (내부용)
import path from 'node:path';
import { runHook } from './adapter/claude-code/hook';
import { AgentProviderSchema } from '@baton/shared';
import { Daemon } from './daemon';
import { IpcChannel } from './ipc/channel';
import { IPC_PROTOCOL_VERSION, IpcError } from './ipc/envelope';
import { DaemonShutdownSchema, MessageType, NotificationClickedSchema, PairStartSchema, SettingsChangedSchema, ShellHelloSchema } from './ipc/messages';
import { IpcShellServices, LocalShellServices } from './services/shell-services';
import { parseProjects, serializeProjects } from './settings/projects';
import { LocalSettingsStore } from './settings/store';
import { logger, setLogLevel } from './util/log';
import { DAEMON_VERSION } from './util/version';

const VERSION = DAEMON_VERSION;
// 04 §11.2: 서버가 이 디바이스의 SSE 를 다른 데몬에 넘겨서 종료하는 경우. 셸은 이 코드를 보면 재시작하지 않는다.
export const EXIT_CONNECTION_REPLACED = 17;

interface Args {
  command: string | null;
  positional: string[];
  flags: Record<string, string | true>;
}

// 의존성 없는 소형 인자 파서 (--key value / --key=value / --flag)
export function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[a.slice(2)] = argv[i + 1];
        i += 1;
      } else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { command: positional[0] ?? null, positional: positional.slice(1), flags };
}

function hookCommand(): { node: string; cli: string } {
  // hook 은 이 CLI 자신을 다시 호출한다 (빌드 산출물 dist/cli.js 또는 tsx 개발 실행 시 src/cli.ts)
  const self = path.resolve(__filename);
  if (self.endsWith('.ts')) {
    const tsx = path.resolve(__dirname, '..', '..', '..', 'node_modules', '.bin', 'tsx');
    return { node: tsx, cli: self };
  }
  return { node: process.execPath, cli: self };
}

async function runIpcDaemon(): Promise<void> {
  const channel = new IpcChannel(process.stdin, process.stdout);
  let daemon: Daemon | null = null;
  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown', { reason });
    await daemon?.shutdown();
    setTimeout(() => process.exit(0), 100);
  };
  // 04 §6-8: 셸이 죽어 stdin EOF 가 되면 5초 안에 종료
  channel.onClose = () => void shutdown('stdin EOF');
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // 핸드셰이크 (04 §3.2): daemon.hello 를 첫 줄로 보내고 shell.hello 를 기다린다
  const hello = await channel.request(MessageType.daemonHello, { protocol: IPC_PROTOCOL_VERSION, daemonVersion: VERSION, pid: process.pid, capabilities: ['pairing', 'sse', 'claude-code'] }, 10_000);
  const parsed = ShellHelloSchema.safeParse(hello.payload);
  if (!parsed.success) throw new IpcError('invalid_payload', 'shell.hello payload');
  if (parsed.data.protocol !== IPC_PROTOCOL_VERSION) throw new IpcError('protocol_mismatch', `shell protocol ${parsed.data.protocol}`);
  const services = new IpcShellServices(channel, { settings: parsed.data.settings, deviceToken: parsed.data.deviceToken });
  daemon = new Daemon({
    services,
    hook: hookCommand(),
    model: process.env.BATON_CLAUDE_MODEL,
    codexPath: process.env.BATON_CODEX_PATH,
    codexModel: process.env.BATON_CODEX_MODEL,
    agyPath: process.env.BATON_AGY_PATH,
    agyModel: process.env.BATON_AGY_MODEL,
    // 개발·E2E 용: claude 실행 파일을 직접 지정한다 (테스트의 fake-claude.mjs). 비어 있으면 PATH 에서 찾는다.
    claudePath: process.env.BATON_CLAUDE_PATH || undefined,
    maxTurns: process.env.BATON_MAX_TURNS ? Number(process.env.BATON_MAX_TURNS) : undefined,
    statusIntervalMs: process.env.BATON_STATUS_INTERVAL_MS ? Number(process.env.BATON_STATUS_INTERVAL_MS) : undefined,
    // 중복 데몬: 재시작하지 않도록 전용 exit code 로 끝낸다 (셸 DaemonSupervisor 가 해석)
    onFatal: () => {
      // unref 하면 안 된다: 데몬이 타이머·SSE 를 모두 정리한 뒤라 이벤트 루프가 비어 exit 0 으로 먼저 끝나 버린다.
      shuttingDown = true;
      setTimeout(() => process.exit(EXIT_CONNECTION_REPLACED), 100);
    }
  });
  const d = daemon;

  channel.onEvent(MessageType.settingsChanged, (env) => {
    const s = SettingsChangedSchema.safeParse(env.payload);
    if (s.success) {
      services.updateFromShell(s.data.settings);
      void d.applySettings(s.data.settings);
    }
  });
  channel.onRequest(MessageType.pairStart, async (env) => {
    const p = PairStartSchema.safeParse(env.payload);
    if (!p.success) throw new IpcError('invalid_payload', 'pair.start payload');
    try {
      const r = await d.pair(p.data.pairingCode, p.data.deviceName ?? null);
      return { type: MessageType.pairResult, payload: { ok: true, deviceId: r.deviceId, error: null } };
    } catch (e) {
      const err = e as { code?: string; message: string };
      return { type: MessageType.pairResult, payload: { ok: false, deviceId: null, error: { code: err.code ?? 'internal', message: err.message } } };
    }
  });
  channel.onRequest(MessageType.notificationClicked, async (env) => {
    const n = NotificationClickedSchema.safeParse(env.payload);
    if (!n.success) throw new IpcError('invalid_payload', 'notification.clicked payload');
    logger.info('notification clicked', { notificationId: n.data.notificationId, requestId: n.data.requestId ?? null, action: n.data.action });
    return { type: MessageType.ack, payload: {} };
  });
  channel.onRequest(MessageType.daemonShutdown, async (env) => {
    const s = DaemonShutdownSchema.safeParse(env.payload);
    setTimeout(() => void shutdown(s.success ? s.data.reason : 'daemon.shutdown'), 10);
    return { type: MessageType.ack, payload: {} };
  });
  await d.start();
}

async function runConsole(flags: Record<string, string | true>): Promise<void> {
  const store = new LocalSettingsStore();
  const patch: Record<string, unknown> = {};
  if (typeof flags.server === 'string') patch.serverUrl = flags.server;
  // 콘솔 모드의 --project 는 프로젝트 목록에 추가한다 (04 §11.1). 여러 번 실행하면 경로별로 쌓인다.
  if (typeof flags.project === 'string') {
    const root = path.resolve(flags.project);
    const list = parseProjects(store.all());
    if (!list.some((e) => e.path === root)) list.push({ name: path.basename(root) || root, path: root, projectIds: {} });
    patch.projects = serializeProjects(list);
  }
  if (Object.keys(patch).length) store.apply(patch);
  const services = new LocalShellServices(store);
  const daemon = new Daemon({
    services,
    hook: hookCommand(),
    // --provider 는 이제 "이것만 쓴다" 는 제한이다. 주지 않으면 설치된 CLI 를 모두 등록한다.
    ...(typeof flags.provider === 'string' ? { providers: [AgentProviderSchema.parse(flags.provider)] } : {}),
    model: process.env.BATON_CLAUDE_MODEL,
    codexPath: process.env.BATON_CODEX_PATH,
    codexModel: process.env.BATON_CODEX_MODEL,
    agyPath: process.env.BATON_AGY_PATH,
    agyModel: process.env.BATON_AGY_MODEL,
    claudePath: process.env.BATON_CLAUDE_PATH || undefined,
    maxTurns: process.env.BATON_MAX_TURNS ? Number(process.env.BATON_MAX_TURNS) : undefined,
    onFatal: () => setTimeout(() => process.exit(EXIT_CONNECTION_REPLACED), 100)
  });
  const shutdown = async (reason: string) => {
    logger.info('shutdown', { reason });
    await daemon.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  await daemon.start();
  if (!(await services.getToken())) {
    logger.error('토큰이 없습니다. 먼저 `baton login --code <pairing code> --server <url>` 을 실행하세요.');
    process.exit(2);
  }
  logger.info('console mode 실행 중 (Ctrl+C 로 종료)', { config: store.configPath });
}

async function runLogin(flags: Record<string, string | true>): Promise<void> {
  const store = new LocalSettingsStore();
  if (typeof flags.server === 'string') store.apply({ serverUrl: flags.server });
  if (typeof flags.project === 'string') {
    const root = path.resolve(flags.project);
    const list = parseProjects(store.all());
    if (!list.some((e) => e.path === root)) list.push({ name: path.basename(root) || root, path: root, projectIds: {} });
    store.apply({ projects: serializeProjects(list) });
  }
  const code = typeof flags.code === 'string' ? flags.code : null;
  if (!code) {
    logger.error('--code <XXXX-XXXX> 가 필요합니다 (웹 → 내 디바이스에서 발급한 pairing 코드)');
    process.exit(2);
  }
  const services = new LocalShellServices(store);
  const daemon = new Daemon({ services, hook: hookCommand() });
  const settings = store.all();
  const { ApiClient } = await import('./transport/api-client');
  const api = new ApiClient(String(settings.serverUrl), null);
  let r: Awaited<ReturnType<typeof api.pair>>;
  try {
    const { deviceInfo } = await import('./transport/device-info');
    r = await api.pair(code, typeof flags.name === 'string' ? flags.name : String(settings.deviceName), deviceInfo());
  } catch (e) {
    const { ApiError } = await import('./transport/api-client');
    if (e instanceof ApiError) {
      // 만료·재사용·형식 오류는 서버 사유를 그대로 보여 준다 (05 §3.4)
      logger.error(`pairing 실패: ${e.serverMessage ?? e.message}`, { status: e.status });
      process.exit(3);
    }
    // 연결 자체가 안 된 경우. 어느 주소로 붙으려 했는지 함께 보여 준다 —
    // 오타·스킴 실수와 진짜 차단을 구분하는 데 이 한 줄이 필요하다.
    logger.error(`pairing 실패: ${Daemon.describe(e)}`, { server: String(settings.serverUrl) });
    process.exit(3);
  }
  await services.setToken(r.deviceToken);
  // 새로 pairing 하면 이전 디바이스·서버에서 받은 등록 id 는 전부 무효다.
  // 남겨 두면 데몬이 `if (!agentId)` 때문에 Agent 를 다시 등록하지 않고, heartbeat 가
  // "이 디바이스의 활성 Agent만 보고할 수 있습니다"(403) 로 조용히 실패한다 — SSE 는 붙어 있어서
  // 겉보기엔 정상인데 실행이 배정되지 않는다(2026-09-14 실측, 터널 주소가 바뀌어 재로그인할 때 발생).
  const relist = parseProjects(store.all()).map((e) => ({ ...e, projectIds: {} }));
  store.apply({
    deviceId: r.deviceId,
    ...(r.userId ? { userId: r.userId } : {}),
    agents: '{}',
    agentId: null,
    agentProvider: null,
    projectId: null,
    lastEventId: '',
    projects: serializeProjects(relist)
  });
  logger.info('pairing 완료', { deviceId: r.deviceId, tokenFile: store.tokenPath });
  await daemon.shutdown();
}

function runStatus(): void {
  const store = new LocalSettingsStore();
  const all = store.all();
  process.stdout.write(JSON.stringify({ config: store.configPath, hasToken: store.getToken() !== null, settings: all }, null, 2) + '\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.debug) setLogLevel('debug');
  if (args.flags.version || args.positional.includes('-v') || args.command === '-v') {
    process.stdout.write(VERSION + '\n');
    return;
  }
  switch (args.command) {
    case 'approval-mcp': {
      if (typeof args.flags.socket !== 'string') throw new Error('approval socket required');
      await runApprovalMcp(args.flags.socket);
      return;
    }
    case 'hook': {
      const sub = args.positional[0] ?? '';
      const policy = typeof args.flags.policy === 'string' ? args.flags.policy : '';
      process.exit(await runHook(sub, policy));
      return;
    }
    case 'daemon':
      if (args.flags.ipc !== 'stdio') {
        logger.error('daemon 은 --ipc stdio 만 지원합니다');
        process.exit(2);
      }
      await runIpcDaemon();
      return;
    case 'start':
      await runConsole(args.flags);
      return;
    case 'login':
      await runLogin(args.flags);
      return;
    case 'status':
      runStatus();
      return;
    default:
      process.stdout.write('usage: baton <login|start|daemon --ipc stdio|status|hook> [options]\n');
      process.exit(args.command ? 2 : 0);
  }
}

if (require.main === module) {
  main().catch((e) => {
    // e.message 만 찍으면 fetch 실패가 "fetch failed" 한 줄로 끝나 원인을 알 수 없다.
    // Daemon.describe 로 cause 사슬을 펼쳐 ECONNREFUSED·ENOTFOUND·TLS 오류를 구분한다.
    logger.error('fatal', { message: Daemon.describe(e) });
    process.exit(1);
  });
}
