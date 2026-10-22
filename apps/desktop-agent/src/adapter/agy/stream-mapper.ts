import type { Phase, ProgressEvent } from '../claude-code/stream-mapper';

export interface AgyEvent {
  event: string;
  conversation_id?: string;
  init?: {
    model?: string;
    cwd?: string;
    tools?: string[];
    permission_mode?: string;
  };
  step_update?: {
    conversation_id?: string;
    step_index: number;
    state: 'ACTIVE' | 'DONE';
    step_type: 'user_input' | 'agent_response' | 'tool' | 'system_message';
    tool_name?: string;
    tool_info?: {
      name?: string;
      parameters?: Record<string, any>;
      output?: string;
    };
    text_delta?: string;
    duration_seconds?: number;
    usage?: Record<string, any>;
  };
  result?: {
    conversation_id?: string;
    status: string;
    response?: string;
    duration_seconds?: number;
    num_turns?: number;
    usage?: Record<string, any>;
    error?: string;
  };
}

export class AgyStreamMapper {
  private userPromptSeen = false;
  private responseBuffer = '';

  map(raw: unknown): ProgressEvent[] {
    if (!raw || typeof raw !== 'object') return [];
    const event = raw as AgyEvent;
    const events: ProgressEvent[] = [];

    // 1. init: 세션 시작
    if (event.event === 'init') {
      events.push({
        phase: 'started',
        message: `Antigravity 세션 시작 (${event.init?.model ?? 'default'})`,
        detail: {
          session_id: event.conversation_id,
          model: event.init?.model,
          cwd: event.init?.cwd,
          toolsCount: event.init?.tools?.length
        }
      });
      return events;
    }

    // 2. step_update: 단계별 진행
    if (event.event === 'step_update' && event.step_update) {
      const step = event.step_update;

      if (step.step_type === 'user_input') {
        if (!this.userPromptSeen) {
          this.userPromptSeen = true;
          events.push({ phase: 'reading_input', message: '프롬프트 접수 및 분석 중...' });
        }
        return events;
      }

      if (step.step_type === 'tool') {
        const toolName = step.tool_name ?? step.tool_info?.name ?? 'unknown_tool';
        const params = step.tool_info?.parameters ?? {};

        if (step.state === 'ACTIVE') {
          let phase: Phase = 'command';
          let message = `도구 실행: ${toolName}`;

          if (toolName === 'write_to_file' || toolName === 'replace_file_content' || toolName === 'multi_replace_file_content') {
            phase = 'editing';
            message = `코드 수정: ${params.TargetFile ?? ''}`;
          } else if (toolName === 'run_command') {
            const command = String(params.CommandLine ?? '');
            const testing = /(?:\bnode\s+--test\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:pytest|vitest|jest)\b|(?:^|[\s/'"])verify\.sh\b)/.test(command);
            const reading = /\b(cat|head|tail|sed|rg|grep|ls|find)\b/.test(command);
            phase = testing ? 'testing' : reading ? 'exploring' : 'command';
            message = `명령 실행: ${command.slice(0, 100)}`;
          } else if (toolName === 'view_file' || toolName === 'grep_search' || toolName === 'find_by_name' || toolName === 'list_dir') {
            phase = 'exploring';
            message = toolName === 'view_file' ? `파일 조회: ${params.AbsolutePath ?? ''}` : `코드 탐색: ${params.Query ?? params.Pattern ?? toolName}`;
          }

          events.push({
            phase,
            message,
            detail: { tool: toolName, stepIndex: step.step_index, parameters: params }
          });
        } else if (step.state === 'DONE') {
          if (step.tool_name === 'run_command') {
            const command = String(params.CommandLine ?? '');
            const testing = /(?:\bnode\s+--test\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:pytest|vitest|jest)\b)/.test(command);
            if (testing) {
              const output = step.tool_info?.output ?? '';
              const passed = !output.includes('FAIL') && !output.includes('not ok');
              events.push({
                phase: passed ? 'test_passed' : 'test_failed',
                message: `테스트 ${passed ? '성공' : '실패'}: ${command.slice(0, 80)}`,
                detail: { tool: step.tool_name, durationSeconds: step.duration_seconds }
              });
              return events;
            }
          }
          events.push({
            phase: 'note',
            message: `${toolName} 완료 (${step.duration_seconds ? `${step.duration_seconds.toFixed(2)}s` : '완료'})`,
            detail: { tool: toolName, durationSeconds: step.duration_seconds }
          });
        }
        return events;
      }

      if (step.step_type === 'agent_response') {
        if (step.state === 'ACTIVE' && step.text_delta) {
          this.responseBuffer += step.text_delta;
          if (this.responseBuffer.length <= step.text_delta.length) {
            events.push({ phase: 'note', message: '에이전트 답변 작성 시작...' });
          }
        } else if (step.state === 'DONE') {
          events.push({
            phase: 'note',
            message: `에이전트 답변 생성 완료 (${step.duration_seconds ? `${step.duration_seconds.toFixed(2)}s` : '완료'})`,
            detail: { usage: step.usage, durationSeconds: step.duration_seconds }
          });
        }
        return events;
      }
    }

    // 3. result: 최종 종료
    if (event.event === 'result' && event.result) {
      const res = event.result;
      if (res.status === 'SUCCESS') {
        events.push({
          phase: 'finished',
          message: 'Antigravity 작업 완료',
          detail: { durationSeconds: res.duration_seconds, numTurns: res.num_turns, usage: res.usage }
        });
      } else {
        events.push({
          phase: 'failed',
          message: res.error ?? `Antigravity 작업 실패 (상태: ${res.status})`,
          detail: { status: res.status, error: res.error }
        });
      }
      return events;
    }

    return events;
  }
}
