import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const mode = process.env.FAKE_AGY_MODE;
const value = (flag) => args[args.indexOf(flag) + 1];
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');

if (args.includes('--version')) {
  console.log('1.2.0 (fake)');
  process.exit(0);
}

if (mode === 'missing-session') {
  emit({ event: 'result', result: { status: 'ERROR', error: 'Conversation not found' } });
  process.exit(1);
}

const resume = args.includes('--conversation');
const session = resume && mode !== 'wrong-session' ? value('--conversation') : randomUUID();

// 비정형 로그나 깨진 줄이 섞여도 파서가 무시하고 견뎌야 한다.
process.stdout.write('null\ninvalid-json\n');

emit({
  event: 'init',
  conversation_id: session,
  init: {
    model: 'gemini-3.8-flash-low',
    cwd: process.cwd(),
    tools: ['write_to_file', 'run_command'],
    permission_mode: 'always-proceed'
  }
});

emit({
  event: 'step_update',
  step_update: {
    conversation_id: session,
    step_index: 0,
    state: 'DONE',
    step_type: 'user_input'
  }
});

// `agy models` 는 목록만 출력하고 끝낸다. 실행 모드와 섞이면 조회가 파일을 쓴다.
if (process.argv.slice(2)[0] === 'models') {
  process.stdout.write('gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.1-pro-low\tGemini 3.1 Pro (Low)\n');
  process.exit(0);
}

if (mode === 'hang') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync('child.pid', String(child.pid));
  setInterval(() => {}, 1000);
} else if (mode === 'failed') {
  emit({ event: 'result', result: { status: 'FAILURE', error: 'API failed' } });
  process.exit(1);
} else {
  const file = resume ? 'test/add.test.mjs' : 'src/add.js';
  if (resume) {
    fs.appendFileSync(file, "test('negative', () => assert.equal(add(-2, -3), -5));\n");
  } else {
    fs.writeFileSync(file, 'export function add(a, b) {\n  return a + b;\n}\n');
  }

  emit({
    event: 'step_update',
    step_update: {
      conversation_id: session,
      step_index: 1,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'write_to_file',
      tool_info: { name: 'write_to_file', parameters: { TargetFile: file } }
    }
  });

  emit({
    event: 'step_update',
    step_update: {
      conversation_id: session,
      step_index: 1,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'write_to_file',
      duration_seconds: 0.05,
      tool_info: { name: 'write_to_file', parameters: { TargetFile: file } }
    }
  });

  emit({
    event: 'step_update',
    step_update: {
      conversation_id: session,
      step_index: 2,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'node --test' } }
    }
  });

  emit({
    event: 'step_update',
    step_update: {
      conversation_id: session,
      step_index: 2,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      duration_seconds: 0.1,
      tool_info: { name: 'run_command', parameters: { CommandLine: 'node --test' }, output: '# pass 1\n# ok\n' }
    }
  });

  const response = '## 요약\n\n덧셈 구현 완료\n\n## 테스트\n\nnode --test 성공\n';

  emit({
    event: 'step_update',
    step_update: {
      conversation_id: session,
      step_index: 3,
      state: 'ACTIVE',
      step_type: 'agent_response',
      text_delta: response
    }
  });

  emit({
    event: 'step_update',
    step_update: {
      conversation_id: session,
      step_index: 3,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: '',
      duration_seconds: 0.5,
      usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 }
    }
  });

  // 마지막 줄에 개행이 없어도 완료 이벤트를 읽어야 함
  process.stdout.write(
    JSON.stringify({
      event: 'result',
      result: {
        conversation_id: session,
        status: 'SUCCESS',
        response,
        duration_seconds: 1.0,
        num_turns: 1,
        usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 }
      }
    })
  );
}
