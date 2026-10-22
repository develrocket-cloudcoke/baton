import { decodeLine, Envelope } from './envelope';

// 바이트 기반 JSON Lines 파서 (04 §1). 텍스트 line API 를 쓰지 않고 0x0A 로 직접 자른다.
export const MAX_LINE_BYTES = 1024 * 1024;

export type ParserEvent =
  | { kind: 'envelope'; envelope: Envelope }
  | { kind: 'malformed'; consecutive: number; preview: string }
  | { kind: 'oversize'; bytes: number };

export class LineParser {
  private buffer: Buffer = Buffer.alloc(0);
  private droppingOversize = false;
  private droppedBytes = 0;
  consecutiveMalformed = 0;

  constructor(private readonly maxLineBytes = MAX_LINE_BYTES) {}

  feed(chunk: Buffer): ParserEvent[] {
    const events: ParserEvent[] = [];
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let nl: number;
    while ((nl = this.buffer.indexOf(0x0a)) >= 0) {
      let line = this.buffer.subarray(0, nl);
      this.buffer = this.buffer.subarray(nl + 1);
      if (this.droppingOversize) {
        this.droppingOversize = false;
        events.push({ kind: 'oversize', bytes: this.droppedBytes + line.length });
        this.droppedBytes = 0;
        continue;
      }
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      if (line.length === 0) continue;
      if (line.length > this.maxLineBytes) {
        events.push({ kind: 'oversize', bytes: line.length });
        continue;
      }
      try {
        events.push({ kind: 'envelope', envelope: decodeLine(line.toString('utf8')) });
        this.consecutiveMalformed = 0;
      } catch {
        this.consecutiveMalformed += 1;
        events.push({ kind: 'malformed', consecutive: this.consecutiveMalformed, preview: line.subarray(0, 80).toString('utf8') });
      }
    }
    if (this.buffer.length > this.maxLineBytes) {
      this.droppedBytes += this.buffer.length;
      this.buffer = Buffer.alloc(0);
      this.droppingOversize = true;
    }
    return events;
  }

  // 스트림 종료 시 개행 없이 남은 마지막 줄 처리
  finish(): ParserEvent[] {
    if (this.buffer.length === 0) return [];
    const tail = Buffer.concat([this.buffer, Buffer.from([0x0a])]);
    this.buffer = Buffer.alloc(0);
    return this.feed(tail);
  }
}
