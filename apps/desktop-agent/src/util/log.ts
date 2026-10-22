// 사람용 로그는 stderr 로만 쓴다. stdout 은 IPC(JSON Lines) 전용이다 (04 §1).
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

let minLevel: LogLevel = (process.env.BATON_LOG_LEVEL as LogLevel) || 'info';
const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function log(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
  if (order[level] < order[minLevel]) return;
  const ts = new Date().toISOString();
  const tail = extra ? ' ' + JSON.stringify(extra) : '';
  process.stderr.write(`[${ts}] ${level.toUpperCase()} ${message}${tail}\n`);
}

export const logger = {
  debug: (m: string, e?: Record<string, unknown>) => log('debug', m, e),
  info: (m: string, e?: Record<string, unknown>) => log('info', m, e),
  warn: (m: string, e?: Record<string, unknown>) => log('warn', m, e),
  error: (m: string, e?: Record<string, unknown>) => log('error', m, e)
};
