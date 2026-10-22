import path from 'node:path';

// 02 §4.2 (PoC 보정 반영): stream-json 이벤트 → 진행 단계(phase)
export type Phase =
  | 'started'
  | 'reading_input'
  | 'exploring'
  | 'editing'
  | 'command'
  | 'testing'
  | 'test_passed'
  | 'test_failed'
  | 'blocked'
  | 'note'
  | 'warning'
  | 'writing_result'
  | 'finished'
  | 'finished_partial'
  | 'failed'
  | 'cancelled';

export interface ProgressEvent {
  phase: Phase;
  message: string;
  detail?: Record<string, unknown>;
}

export interface MapperContext {
  projectRoot: string;
  inputDir: string;
  outputDir: string;
}

const TEST_RE = /\b((npm|pnpm|yarn|bun)\s+(run\s+)?test\b|pytest\b|go\s+test\b|jest\b|vitest\b|node\s+--test\b|gradle\w*\s+test\b|mvn\s+test\b|cargo\s+test\b|verify\.(sh|mjs|js)\b)/;
const EXPLORE_RE = /^\s*(find|ls|tree|git\s+(status|log|diff|show)|wc|head|tail|cat|rg|grep)\b/;
const READ_INPUT_RE = /^\s*(cat|head|less|tail|bat)\b/;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);

type Json = Record<string, unknown>;

export class StreamMapper {
  private readonly pending = new Map<string, { name: string; input: Json; phase: Phase }>();
  private lastPhase: Phase | null = null;

  constructor(private readonly ctx: MapperContext) {}

  private rel(p: string | undefined): string {
    if (!p) return '';
    return p.startsWith(this.ctx.projectRoot + path.sep) ? path.relative(this.ctx.projectRoot, p) : path.basename(p);
  }

  map(ev: Json): ProgressEvent[] {
    const out: ProgressEvent[] = [];
    const type = ev.type as string;
    const subtype = ev.subtype as string | undefined;
    if (type === 'system' && subtype === 'init') {
      out.push({ phase: 'started', message: `작업 시작 (model=${String(ev.model ?? '?')})`, detail: { session_id: ev.session_id } });
    } else if (type === 'system' && subtype === 'permission_denied') {
      out.push({ phase: 'blocked', message: `권한 정책으로 차단: ${String(ev.tool_name ?? '?')} — ${String(ev.message ?? '')}`.slice(0, 200) });
    } else if (type === 'system' && subtype === 'api_retry') {
      out.push({ phase: 'warning', message: `API 재시도 ${String(ev.attempt)}/${String(ev.max_retries)} (${String(ev.error)})` });
    } else if (type === 'rate_limit_event') {
      const status = (ev.rate_limit_info as Json | undefined)?.status;
      if (status && status !== 'allowed') out.push({ phase: 'warning', message: `API 제한: ${String(status)}` });
    } else if (type === 'assistant' && ev.parent_tool_use_id == null) {
      const content = ((ev.message as Json | undefined)?.content as Json[] | undefined) ?? [];
      for (const c of content) {
        if (c.type === 'tool_use') out.push(this.mapToolUse(c));
        else if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) out.push({ phase: 'note', message: c.text.trim().split('\n')[0].slice(0, 120) });
      }
    } else if (type === 'user' && ev.parent_tool_use_id == null) {
      const content = ((ev.message as Json | undefined)?.content as Json[] | undefined) ?? [];
      for (const c of content) {
        if (c.type !== 'tool_result') continue;
        const p = this.pending.get(String(c.tool_use_id));
        if (!p) continue;
        if (p.phase === 'testing') {
          const r = ev.tool_use_result;
          const text = typeof r === 'object' && r !== null ? `${String((r as Json).stdout ?? '')}${String((r as Json).stderr ?? '')}` : String(r ?? '');
          const m = text.match(/(\d+)\s+pass/i) ?? text.match(/pass\s+(\d+)/i);
          out.push(c.is_error ? { phase: 'test_failed', message: '테스트 실패' } : { phase: 'test_passed', message: m ? `테스트 성공 (${m[1]} passed)` : '테스트 성공' });
        }
      }
    } else if (type === 'result') {
      if (subtype === 'success') out.push({ phase: 'finished', message: `작업 완료 (turns=${String(ev.num_turns)}, cost=$${Number(ev.total_cost_usd ?? 0).toFixed(4)})`, detail: { num_turns: ev.num_turns, total_cost_usd: ev.total_cost_usd } });
      else if (subtype === 'error_max_turns') out.push({ phase: 'finished_partial', message: `턴 한도 도달, 부분 완료 (turns=${String(ev.num_turns)})` });
      else out.push({ phase: 'failed', message: `작업 실패 (${String(subtype)})` });
    }
    // 같은 exploring 이 연속되면 1건으로 합친다
    return out.filter((e) => {
      const collapse = e.phase === 'exploring' && this.lastPhase === 'exploring';
      this.lastPhase = e.phase;
      return !collapse;
    });
  }

  private mapToolUse(c: Json): ProgressEvent {
    const name = String(c.name);
    const input = (c.input as Json | undefined) ?? {};
    const fp = (input.file_path as string | undefined) ?? (input.path as string | undefined) ?? (input.pattern as string | undefined);
    const cmd = String(input.command ?? '');
    let ev: ProgressEvent;
    if (READ_TOOLS.has(name) && fp && fp.startsWith(this.ctx.inputDir)) ev = { phase: 'reading_input', message: `${path.basename(fp)} 읽는 중` };
    else if (READ_TOOLS.has(name)) ev = { phase: 'exploring', message: `프로젝트 구조 확인 (${name} ${this.rel(fp)})`.trim() };
    else if (EDIT_TOOLS.has(name) && fp && fp.startsWith(this.ctx.outputDir)) ev = { phase: 'writing_result', message: `결과 문서 작성: ${path.basename(fp)}` };
    else if (EDIT_TOOLS.has(name)) ev = { phase: 'editing', message: `코드 수정: ${this.rel(fp)}` };
    else if (name === 'Bash' && READ_INPUT_RE.test(cmd) && cmd.includes(this.ctx.inputDir)) ev = { phase: 'reading_input', message: `${path.basename(cmd.split(/\s+/).find((t) => t.includes(this.ctx.inputDir)) ?? '')} 읽는 중` };
    else if (name === 'Bash' && TEST_RE.test(cmd)) ev = { phase: 'testing', message: '테스트 실행' };
    else if (name === 'Bash' && EXPLORE_RE.test(cmd)) ev = { phase: 'exploring', message: `프로젝트 구조 확인 (${cmd.slice(0, 60)})` };
    else if (name === 'Bash') ev = { phase: 'command', message: `명령 실행: ${String(input.description ?? cmd).slice(0, 100)}` };
    else ev = { phase: 'command', message: `도구 사용: ${name}` };
    this.pending.set(String(c.id), { name, input, phase: ev.phase });
    ev.detail = { tool: name, tool_use_id: c.id };
    return ev;
  }
}
