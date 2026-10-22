import type { ProgressEvent } from '../interface';

type Json = Record<string, any>;

// Codex JSONL의 lifecycle/item 이벤트를 기존 Baton phase 어휘로 변환한다.
export class CodexStreamMapper {
  map(event: Json): ProgressEvent[] {
    if (event.type === 'thread.started') return [{ phase: 'started', message: 'Codex 작업 시작', detail: { session_id: event.thread_id } }];
    if (event.type === 'turn.started') return [{ phase: 'note', message: 'Codex 턴 시작' }];
    if (event.type === 'turn.completed') return []; // exit code까지 확인한 뒤 러너가 finished를 보낸다.
    if (event.type === 'turn.failed' || event.type === 'error') return [{ phase: 'warning', message: String(event.error?.message ?? event.message ?? 'Codex 오류') }];
    if (!['item.started', 'item.updated', 'item.completed'].includes(event.type)) return [];
    const item = event.item ?? {};
    if (item.type === 'file_change') return [{ phase: item.status === 'failed' ? 'warning' : 'editing', message: `코드 수정: ${(Array.isArray(item.changes) ? item.changes : []).map((c: Json) => c.path).join(', ')}` }];
    if (item.type === 'command_execution') {
      const command = String(item.command ?? '');
      const testing = /(?:\bnode\s+--test\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:pytest|vitest|jest)\b|(?:^|[\s/'"])verify\.sh\b)/.test(command);
      if (testing && event.type === 'item.completed') return [{ phase: item.exit_code === 0 ? 'test_passed' : 'test_failed', message: `테스트 ${item.exit_code === 0 ? '성공' : '실패'}: ${command.slice(0, 300)}` }];
      const reading = /\b(cat|head|tail|sed|rg|grep|ls|find)\b/.test(command);
      return [{ phase: testing ? 'testing' : reading ? 'exploring' : 'command', message: command.slice(0, 500) }];
    }
    if (item.type === 'agent_message') return [{ phase: 'note', message: String(item.text ?? '').slice(0, 1000) }];
    if (item.type === 'web_search') return [{ phase: 'exploring', message: '웹 검색' }];
    if (item.type === 'mcp_tool_call') return [{ phase: 'command', message: `도구 호출: ${item.server ?? ''}/${item.tool ?? ''}` }];
    if (item.type === 'error') return [{ phase: 'warning', message: String(item.message ?? '도구 오류') }];
    return [];
  }
}
