#!/usr/bin/env node
// `claude -p --output-format stream-json` 를 흉내내는 가짜 실행 파일 (비용 0). runner/collector/canary 경로 테스트용.
// FAKE_CLAUDE_MODE=ok        settings 의 SessionStart hook 을 실제로 실행해 canary.ok 를 만들고, 파일 하나를 고치고 result.md 를 쓴다
// FAKE_CLAUDE_MODE=nocanary  settings 를 무시한 것처럼 hook 을 실행하지 않는다 (F1 fail-closed 검증)
// FAKE_CLAUDE_MODE=hang      init 만 내보내고 끝나지 않는다 (취소 SIGTERM→SIGKILL 검증). SIGTERM 을 받으면 exit 143.
// FAKE_CLAUDE_MODE=partial   src/add.js 를 고치고 result.md 를 쓴 뒤 끝나지 않는다 (CLO-11 취소 부분 결과 검증).
// FAKE_CLAUDE_MODE=resumefail --resume 이 오면 실제 claude 가 만료 세션에서 그러듯 init 없이 stderr + exit 1 (§18 폴백 검증).
//                            --resume 없이 불리면(폴백 재시도) ok 모드처럼 동작한다.
// --resume <id> 가 오면 같은 session_id 로 이어서 "테스트 케이스 추가"(test/add.test.mjs)만 수행한다.
// 이번 회차 변경만 계층2 에 잡히는지(= git 기준점 조정) 검증하는 용도다.
//                            FAKE_CLAUDE_IGNORE_SIGTERM=1 이면 SIGTERM 을 무시해 SIGKILL 경로를 검증한다.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

// runner 가 실행 전에 `--help` 로 지원 플래그를 확인한다. 가짜 실행 파일도 자기가 받는
// 인터페이스를 밝혀야 한다 — 아니면 "이 Claude Code 버전은 …를 지원하지 않습니다" 로
// 막혀 테스트가 실행 경로에 들어가지도 못한다.
if (args[0] === '--help') {
  process.stdout.write(
    [
      '  -p, --print',
      '  --output-format <format>',
      '  --permission-prompts <target>',
      '  --permission-mode <mode>',
      '  --include-hook-events',
      '  --append-system-prompt-file <file>',
      '  --settings <file>',
      '  --add-dir <dirs...>',
      '  --allowedTools <tools...>',
      '  --disallowedTools <tools...>',
      '  --max-turns <n>',
      '  --model <model>',
      '  --session-id <uuid>',
      '  --resume <id>'
    ].join('\n') + '\n'
  );
  process.exit(0);
}
if (args[0] === '--version') {
  process.stdout.write('2.1.263 (Claude Code, fake)\n');
  process.exit(0);
}

const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const settingsPath = opt('--settings');
const resumeId = opt('--resume');
const sessionId = resumeId || opt('--session-id') || 'fake-session';
const addDirIdx = args.indexOf('--add-dir');
const outputDir = addDirIdx >= 0 ? args[addDirIdx + 2] : null;
const cwd = process.cwd();
// resumefail 은 --resume 일 때만 죽고, 폴백(새 세션) 재시도에서는 ok 모드와 똑같이 동작해야 한다
const okLike = mode === 'ok' || mode === 'resumefail';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// 프롬프트(stdin)를 끝까지 읽는다
let prompt = '';
process.stdin.on('data', (c) => (prompt += c));
process.stdin.on('end', run);

function runHook(event, extra = {}) {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  for (const group of settings.hooks?.[event] || []) {
    for (const h of group.hooks || []) {
      const input = JSON.stringify({ hook_event_name: event, session_id: sessionId, cwd, ...extra });
      const stdout = execFileSync('/bin/sh', ['-c', h.command], { input, encoding: 'utf8' });
      out({ type: 'system', subtype: 'hook_response', hook_event: event, output: stdout, session_id: sessionId });
      try { const j = JSON.parse(stdout); if (j.hookSpecificOutput?.permissionDecision === 'deny') return j.hookSpecificOutput.permissionDecisionReason; } catch {}
    }
  }
  return null;
}

function run() {
  if (mode === 'resumefail' && resumeId) {
    // 실측(2026-09-11, claude 2.1.x): 없는 세션을 --resume 하면 system/init 을 내지 않고
    // result/error_during_execution 을 한 줄 내보낸 뒤 exit 1 한다. errors[] 에 사유가 담긴다.
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, duration_ms: 0, total_cost_usd: 0, session_id: resumeId, permission_denials: [], errors: [`No conversation found with session ID: ${resumeId}`] });
    process.stderr.write(`No conversation found with session ID: ${resumeId}\n`);
    process.exit(1);
  }
  if (resumeId) return runFollowUp();
  if (mode === 'hang' || mode === 'partial') {
    // 취소 검증용: init 만 내보내고 대기한다. 부모가 SIGTERM → (유예 후) SIGKILL 을 보낸다.
    // canary(F1) 는 통과시켜야 runner 가 실행을 중단하지 않는다.
    if (settingsPath) runHook('SessionStart');
    out({ type: 'system', subtype: 'init', cwd, session_id: sessionId, model: 'fake-claude', tools: ['Read'] });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: '오래 걸리는 작업을 시작합니다.' }] }, parent_tool_use_id: null, session_id: sessionId });
    // partial: 끝나기 전까지 3계층(structuredPatch·워킹트리 변경·result.md)을 남겨 둔다. 취소해도 이만큼은 수집된다.
    if (mode === 'partial') writePartialWork();
    if (process.env.FAKE_CLAUDE_IGNORE_SIGTERM === '1') process.on('SIGTERM', () => {});
    else process.on('SIGTERM', () => process.exit(143));
    setInterval(() => {}, 1000);
    return;
  }
  if (okLike && settingsPath) runHook('SessionStart');
  out({ type: 'system', subtype: 'init', cwd, session_id: sessionId, model: 'fake-claude', tools: ['Read', 'Edit', 'Write', 'Bash'] });
  const target = path.join(cwd, 'src', 'add.js');
  const exists = fs.existsSync(target);
  out({ type: 'assistant', message: { content: [{ type: 'text', text: '첨부 문서를 확인하겠습니다.' }] }, parent_tool_use_id: null, session_id: sessionId });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: target } }] }, parent_tool_use_id: null, session_id: sessionId });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, parent_tool_use_id: null, tool_use_result: { type: 'text', file: { filePath: target } }, session_id: sessionId });
  if (exists && okLike) {
    const denied = runHook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: target } });
    if (!denied) {
      const before = fs.readFileSync(target, 'utf8');
      const after = before.replace('a - b', 'a + b');
      fs.writeFileSync(target, after);
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: target, old_string: 'a - b', new_string: 'a + b' } }] }, parent_tool_use_id: null, session_id: sessionId });
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'updated' }] }, parent_tool_use_id: null, tool_use_result: { filePath: target, oldString: 'a - b', newString: 'a + b', originalFile: before, structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' export function add(a, b) {', '-  return a - b;', '+  return a + b;', ' }'] }] }, session_id: sessionId });
    }
    // 프로젝트 밖 쓰기 시도 → hook 이 deny 해야 한다
    const outside = runHook('PreToolUse', { tool_name: 'Write', tool_input: { file_path: '/tmp/baton-fake-claude-outside.txt', content: 'x' } });
    out({ type: 'system', subtype: 'permission_denied', tool_name: 'Write', message: outside || 'not denied', session_id: sessionId });
  }
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'node --test', description: 'run tests' } }] }, parent_tool_use_id: null, session_id: sessionId });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: '# pass 2' }] }, parent_tool_use_id: null, tool_use_result: { stdout: '# tests 2\n# pass 2\n# fail 0', stderr: '' }, session_id: sessionId });
  if (outputDir && okLike) {
    const resultPath = path.join(outputDir, 'result.md');
    fs.writeFileSync(resultPath, '## 요약\n\nadd() 의 뺄셈 버그를 덧셈으로 고쳤습니다.\n\n## 변경 파일\n\n- src/add.js\n\n## 테스트\n\n# pass 2\n\n## 미완료·주의\n\n없음\n\n## 다음 단계 제안\n\n없음\n');
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't4', name: 'Write', input: { file_path: resultPath, content: '...' } }] }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't4', content: 'created' }] }, parent_tool_use_id: null, tool_use_result: { type: 'create', filePath: resultPath, content: '...' }, session_id: sessionId });
  }
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 4, duration_ms: 10, total_cost_usd: 0, result: 'done', session_id: sessionId, permission_denials: [], prompt_bytes: prompt.length });
  process.exit(0);
}

// CLO-11 취소 부분 결과용: 취소되기 전까지 실제로 파일을 고치고 미완성 result.md 를 남긴다.
function writePartialWork() {
  const target = path.join(cwd, 'src', 'add.js');
  if (fs.existsSync(target)) {
    const before = fs.readFileSync(target, 'utf8');
    const after = before.replace('a - b', 'a + b');
    fs.writeFileSync(target, after);
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'p1', name: 'Edit', input: { file_path: target, old_string: 'a - b', new_string: 'a + b' } }] }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'p1', content: 'updated' }] }, parent_tool_use_id: null, tool_use_result: { filePath: target, oldString: 'a - b', newString: 'a + b', originalFile: before, structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' export function add(a, b) {', '-  return a - b;', '+  return a + b;', ' }'] }] }, session_id: sessionId });
  }
  if (outputDir) {
    fs.writeFileSync(path.join(outputDir, 'result.md'), '## 요약\n\nadd() 의 뺄셈 버그까지 고쳤고 테스트는 아직 돌리지 못했습니다.\n\n## 변경 파일\n\n- src/add.js\n\n## 미완료·주의\n\n- 실행이 취소되어 테스트를 수행하지 못했습니다\n');
  }
}

// §18 추가 작업(--resume): 이전 회차에서 고친 src/add.js 는 건드리지 않고 테스트만 하나 더 추가한다.
function runFollowUp() {
  if (settingsPath) runHook('SessionStart');
  out({ type: 'system', subtype: 'init', cwd, session_id: sessionId, model: 'fake-claude', tools: ['Read', 'Edit', 'Write', 'Bash'] });
  const target = path.join(cwd, 'test', 'add.test.mjs');
  if (fs.existsSync(target)) {
    const denied = runHook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: target } });
    if (!denied) {
      const before = fs.readFileSync(target, 'utf8');
      const added = "test('add negative', () => assert.equal(add(-1, -2), -3));\n";
      fs.writeFileSync(target, before + added);
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'f1', name: 'Edit', input: { file_path: target, old_string: '', new_string: added } }] }, parent_tool_use_id: null, session_id: sessionId });
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'f1', content: 'updated' }] }, parent_tool_use_id: null, tool_use_result: { filePath: target, oldString: '', newString: added, originalFile: before, structuredPatch: [{ oldStart: 4, oldLines: 1, newStart: 4, newLines: 2, lines: [" test('add', () => assert.equal(add(2, 3), 5));", "+test('add negative', () => assert.equal(add(-1, -2), -3));"] }] }, session_id: sessionId });
    }
  }
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'f2', name: 'Bash', input: { command: 'node --test', description: 'run tests' } }] }, parent_tool_use_id: null, session_id: sessionId });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'f2', content: '# pass 3' }] }, parent_tool_use_id: null, tool_use_result: { stdout: '# tests 3\n# pass 3\n# fail 0', stderr: '' }, session_id: sessionId });
  if (outputDir) {
    const resultPath = path.join(outputDir, 'result.md');
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'f3', name: 'Write', input: { file_path: resultPath, content: '...' } }] }, parent_tool_use_id: null, session_id: sessionId });
    fs.writeFileSync(resultPath, '## 요약\n\n요청대로 테스트 케이스를 하나 더 추가했습니다.\n\n## 변경 파일\n\n- test/add.test.mjs\n\n## 테스트\n\n# pass 3\n\n## 미완료·주의\n\n없음\n\n## 다음 단계 제안\n\n없음\n');
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'f3', content: 'created' }] }, parent_tool_use_id: null, tool_use_result: { type: 'create', filePath: resultPath, content: '...' }, session_id: sessionId });
  }
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 10, total_cost_usd: 0, result: 'follow-up done', session_id: sessionId, permission_denials: [], prompt_bytes: prompt.length, resumed: true });
  process.exit(0);
}
