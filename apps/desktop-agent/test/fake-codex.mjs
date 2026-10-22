import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE;
const value = (flag) => args[args.indexOf(flag) + 1];
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
if (args.includes('--version')) { console.log('codex-cli 0.154.0 (fake)'); process.exit(0); }
// `codex debug models` 는 계정 카탈로그를 JSON 으로 준다. 실행 모드와 섞이면 조회가 세션을 연다.
if (args[0] === 'debug' && args[1] === 'models') {
  console.log(JSON.stringify({
    models: [
      { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', priority: 1,
        default_reasoning_level: 'low',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 2,
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [{ effort: 'medium' }] },
      { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 9 }
    ]
  }));
  process.exit(0);
}
await new Promise((resolve) => { process.stdin.resume(); process.stdin.on('end', resolve); });
if (mode === 'missing-session') { emit({ type: 'turn.failed', error: { message: 'No thread found' } }); process.exit(1); }
const resume = args.includes('resume');
const session = resume && mode !== 'wrong-session' ? value('resume') : randomUUID();
process.stdout.write('null\ninvalid-json\n');
emit({ type: 'thread.started', thread_id: session });
emit({ type: 'turn.started' });
if (mode === 'hang') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync('child.pid', String(child.pid));
  setInterval(() => {}, 1000);
} else if (mode === 'failed') {
  emit({ type: 'turn.failed', error: { message: 'API failed' } }); process.exitCode = 1;
} else if (fs.existsSync('deployment.yaml')) {
  const content = fs.readFileSync('deployment.yaml', 'utf8');
  fs.writeFileSync('deployment.yaml', content.replace(/redis-servcie/g, 'redis-service'));
  emit({ type: 'item.completed', item: { id: 'patch', type: 'file_change', status: 'completed', changes: [{ path: 'deployment.yaml', kind: 'update' }] } });
  emit({ type: 'item.started', item: { id: 'test', type: 'command_execution', command: './verify.sh', status: 'in_progress' } });
  emit({ type: 'item.completed', item: { id: 'test', type: 'command_execution', command: './verify.sh', status: 'completed', exit_code: 0 } });
  const text = '## 요약\n\nKubernetes deployment.yaml 내 REDIS_HOST 오타(redis-servcie -> redis-service) 수정 완료\n\n## 테스트\n\n./verify.sh 실행 성공 (DEPLOYMENT_VERIFIED_SUCCESS)\n';
  fs.writeFileSync(value('-o'), text);
  emit({ type: 'item.completed', item: { id: 'message', type: 'agent_message', text } });
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 150, output_tokens: 35 } }));
} else {
  const file = resume ? 'test/add.test.mjs' : 'src/add.js';
  if (resume) fs.appendFileSync(file, "test('negative', () => assert.equal(add(-2, -3), -5));\n");
  else fs.writeFileSync(file, 'export function add(a, b) {\n  return a + b;\n}\n');
  emit({ type: 'item.completed', item: { id: 'patch', type: 'file_change', status: 'completed', changes: [{ path: file, kind: 'update' }] } });
  emit({ type: 'item.started', item: { id: 'test', type: 'command_execution', command: 'node --test', status: 'in_progress' } });
  emit({ type: 'item.completed', item: { id: 'test', type: 'command_execution', command: 'node --test', status: 'completed', exit_code: 0 } });
  const text = '## 요약\n\n덧셈 수정 완료\n\n## 테스트\n\nnode --test 성공\n';
  fs.writeFileSync(value('-o'), text);
  emit({ type: 'item.completed', item: { id: 'message', type: 'agent_message', text } });
  // 마지막 줄에 개행이 없어도 완료 이벤트를 읽어야 한다.
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } }));
}
