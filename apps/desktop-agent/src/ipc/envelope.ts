import { z } from 'zod';

// docs/design/04-shell-daemon-ipc.md §2 봉투
export const IPC_PROTOCOL_VERSION = 1;

export const EnvelopeSchema = z.object({
  v: z.number().int(),
  type: z.string().min(1),
  id: z.string().min(1),
  ts: z.string().min(1),
  replyTo: z.string().min(1).optional(),
  payload: z.record(z.unknown())
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export type IpcErrorCode =
  | 'invalid_envelope'
  | 'invalid_payload'
  | 'unknown_type'
  | 'protocol_mismatch'
  | 'timeout'
  | 'keychain_error'
  | 'not_paired'
  | 'invalid_pairing_code'
  | 'server_unreachable'
  | 'internal';

export class IpcError extends Error {
  constructor(
    public readonly code: IpcErrorCode,
    message: string,
    public readonly retryable = false
  ) {
    super(message);
  }
}

export function nowTs(): string {
  return new Date().toISOString();
}

// 봉투 한 줄 직렬화. 개행은 JSON 이스케이프로 들어가므로 줄 안에 0x0A 가 없다.
export function encodeLine(env: Envelope): string {
  return JSON.stringify(env) + '\n';
}

export function decodeLine(line: string): Envelope {
  const parsed: unknown = JSON.parse(line);
  const result = EnvelopeSchema.safeParse(parsed);
  if (!result.success) throw new IpcError('invalid_envelope', result.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '));
  return result.data;
}

// 보내는 쪽 id 생성기 (`d-<n>`)
export class MessageIdSequence {
  private counter = 0;
  constructor(private readonly prefix: string) {}
  next(): string {
    this.counter += 1;
    return `${this.prefix}-${this.counter}`;
  }
}
