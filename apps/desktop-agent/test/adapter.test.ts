import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildClaudeArgs, buildClaudeSettings, buildHookPolicy, splitClaudeModel } from '../src/adapter/claude-code/policy';
import { decidePreToolUse } from '../src/adapter/claude-code/hook';
import { makeExecDir } from '../src/adapter/claude-code/exec-dir';
import { renderPrompt, renderSystemAppend } from '../src/adapter/claude-code/prompt';
import { ClaudeRunner } from '../src/adapter/claude-code/runner';
import { ProgressEvent, StreamMapper } from '../src/adapter/claude-code/stream-mapper';
import { PolicySchema } from '../src/transport/events';
import { fakeClaudePath, hookCommand, makeProject, tmpDir } from './helpers';

const policy = PolicySchema.parse({ repository_edit: 'allow', deployment_apply: 'deny' });

test('프롬프트 6구획과 F4 policy 구획', () => {
  const home = tmpDir('home');
  const dir = makeExecDir('exec-prompt', home);
  fs.writeFileSync(path.join(dir.docsDir, 'analysis.md'), '# a');
  fs.writeFileSync(path.join(dir.attachmentsDir, 'server.log'), 'log');
  const prompt = renderPrompt({ requestId: 'req-1', title: '로그인 API 오류', senderName: 'A', originalInstruction: '오류를 고쳐주세요.', additionalInstruction: '운영 환경은 변경하지 마.', policy, projectRoot: '/proj' }, dir);
  for (const h of ['## 1. 원본 요청', '## 2. 첨부 문서', '## 3. 첨부 파일', '## 4. 실행자의 추가 지시', '## 5. 실행 정책 (Policy)', '## 6. 작업 완료 조건']) assert.ok(prompt.includes(h), h);
  assert.ok(prompt.includes(path.join(dir.docsDir, 'analysis.md')));
  assert.ok(prompt.includes('- repository_edit: allow'));
  assert.ok(prompt.includes('- deployment_apply: deny'));
  assert.ok(prompt.includes(dir.resultMdPath));
  const sys = renderSystemAppend(policy, dir, '/proj');
  assert.ok(sys.includes('kubectl apply'));
  assert.ok(sys.includes('로컬 파일 수정 금지가 아니다'));
});

test('claude-settings.json: F1 문자열 값, F2 Read deny 세트, canary hook, 인자', () => {
  const home = tmpDir('home');
  const dir = makeExecDir('exec-settings', home);
  const s = buildClaudeSettings(policy, dir, { node: '/usr/bin/node', cli: '/x/cli.js' }) as any;
  assert.equal(s.permissions.disableBypassPermissionsMode, 'disable');
  assert.ok(s.permissions.deny.some((d: string) => d.startsWith('Read(//') && d.includes('.aws/credentials')));
  assert.ok(s.permissions.deny.includes('WebFetch'));
  assert.ok(s.permissions.deny.includes('Bash(aws *)'));
  assert.equal(s.sandbox.network.strictAllowlist, true);
  assert.ok(s.hooks.SessionStart[0].hooks[0].command.includes('hook canary'));
  assert.ok(s.hooks.PreToolUse[0].hooks[0].command.includes(dir.policyPath));
  const args = buildClaudeArgs(policy, dir, { sessionId: 'sid', maxTurns: 3, model: 'haiku' });
  assert.deepEqual(args.slice(0, 3), ['-p', '--output-format', 'stream-json']);
  assert.ok(args.includes('--permission-prompts') && args.includes('none'));
  assert.ok(args.includes('acceptEdits'));
  assert.equal(args[args.length - 1], 'sid');
  const readOnly = buildClaudeArgs(PolicySchema.parse({ repository_edit: 'deny', shell_execution: 'deny' }), dir, { sessionId: 's', maxTurns: 1, model: 'haiku' });
  assert.ok(!readOnly.includes('Edit'));
  assert.ok(readOnly.slice(readOnly.indexOf('--disallowedTools')).includes('Bash'));
});

test('hook 정책 판정: 프로젝트 밖 쓰기·자격증명 읽기·배포 명령 deny', () => {
  const home = tmpDir('home');
  const dir = makeExecDir('exec-hook', home);
  const hp = buildHookPolicy(policy, dir, '/proj');
  assert.equal(decidePreToolUse(hp, { tool_name: 'Write', tool_input: { file_path: '/proj/src/a.ts' }, cwd: '/proj' }).decision, 'pass');
  assert.equal(decidePreToolUse(hp, { tool_name: 'Write', tool_input: { file_path: dir.resultMdPath }, cwd: '/proj' }).decision, 'pass');
  assert.equal(decidePreToolUse(hp, { tool_name: 'Write', tool_input: { file_path: '/tmp/x.txt' }, cwd: '/proj' }).decision, 'deny');
  assert.equal(decidePreToolUse(hp, { tool_name: 'Read', tool_input: { file_path: hp.denyReadPaths[0] }, cwd: '/proj' }).decision, 'deny');
  assert.equal(decidePreToolUse(hp, { tool_name: 'Bash', tool_input: { command: 'kubectl apply -f deployment.yaml' }, cwd: '/proj' }).decision, 'deny');
  assert.equal(decidePreToolUse(hp, { tool_name: 'Bash', tool_input: { command: 'kubectl get pods' }, cwd: '/proj' }).decision, 'pass');
  assert.equal(decidePreToolUse(hp, { tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: '/proj' }).decision, 'deny');
  const ro = buildHookPolicy(PolicySchema.parse({ shell_execution: 'read_only' }), dir, '/proj');
  assert.equal(decidePreToolUse(ro, { tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, cwd: '/proj' }).decision, 'deny');
});

test('stream-json → 진행 단계 매핑 (02 §4.2 보정)', () => {
  const m = new StreamMapper({ projectRoot: '/proj', inputDir: '/exec/input', outputDir: '/exec/output' });
  const phases = (ev: Record<string, unknown>) => m.map(ev).map((e) => e.phase);
  assert.deepEqual(phases({ type: 'system', subtype: 'init', model: 'haiku' }), ['started']);
  const tu = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name, input }] } });
  assert.deepEqual(phases(tu('1', 'Read', { file_path: '/exec/input/docs/a.md' })), ['reading_input']);
  assert.deepEqual(phases(tu('2', 'Bash', { command: 'cat /exec/input/attachments/server.log' })), ['reading_input']);
  assert.deepEqual(phases(tu('3', 'Bash', { command: 'find /proj -name "*.ts"' })), ['exploring']);
  assert.deepEqual(phases(tu('4', 'Read', { file_path: '/proj/src/a.ts' })), []); // 연속 exploring 은 합침
  assert.deepEqual(phases(tu('5', 'Edit', { file_path: '/proj/src/a.ts' })), ['editing']);
  assert.deepEqual(phases(tu('6', 'Write', { file_path: '/exec/output/result.md' })), ['writing_result']);
  assert.deepEqual(phases(tu('7', 'Bash', { command: 'node --test' })), ['testing']);
  const res = m.map({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: '7', is_error: false }] }, tool_use_result: { stdout: '# pass 2' } });
  assert.equal(res[0].phase, 'test_passed');
  assert.ok(res[0].message.includes('2 passed'));
  assert.deepEqual(phases({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', message: 'denied' }), ['blocked']);
  assert.deepEqual(phases({ type: 'result', subtype: 'error_max_turns', num_turns: 3 }), ['finished_partial']);
  assert.deepEqual(phases({ type: 'result', subtype: 'success', num_turns: 5, total_cost_usd: 0.01 }), ['finished']);
});

test('runner(fake-claude ok): canary 통과, hook deny, 진행 이벤트, 결과 3계층', async () => {
  const home = tmpDir('home');
  const project = makeProject(tmpDir('proj'));
  const progress: ProgressEvent[] = [];
  const result = await new ClaudeRunner().run(
    { executionId: 'exec-ok', requestId: 'req', originalInstruction: 'add 버그 수정', policy, projectRoot: project, attachments: [], maxTurns: 3, model: 'haiku' },
    { home, hook: hookCommand(), claudePath: fakeClaudePath, onProgress: (e) => progress.push(e) }
  );
  assert.equal(result.outcome, 'success', result.failureReason ?? '');
  assert.ok(fs.existsSync(result.dir.canaryPath), 'canary.ok 생성');
  const phases = progress.map((p) => p.phase);
  for (const p of ['started', 'exploring', 'editing', 'testing', 'test_passed', 'writing_result', 'finished', 'blocked']) assert.ok(phases.includes(p as ProgressEvent['phase']), p);
  assert.ok(progress.find((p) => p.phase === 'blocked')?.message.includes('프로젝트 밖 쓰기 금지'));
  assert.deepEqual(result.collected.changedFiles, ['src/add.js']);
  assert.ok(result.collected.layer2?.patch.includes('+  return a + b;'));
  assert.ok(result.collected.layer1.patch.includes('+  return a + b;'));
  assert.ok(!result.collected.layer1.files.some((f) => f.includes('output')), '계층1 은 프로젝트 안만');
  assert.ok(result.collected.resultMd?.includes('## 요약'));
  assert.equal(result.collected.testSummary, '# pass 2');
  const hookLog = fs.readFileSync(result.dir.hookEventsPath, 'utf8');
  assert.ok(hookLog.includes('"canary":true'));
  assert.ok(hookLog.includes('"decision":"deny"'));
});

test('runner(fake-claude nocanary): settings 무시 감지 → SIGKILL → failed (F1)', async () => {
  const home = tmpDir('home');
  const project = makeProject(tmpDir('proj'), false);
  const prev = process.env.FAKE_CLAUDE_MODE;
  process.env.FAKE_CLAUDE_MODE = 'nocanary';
  try {
    const result = await new ClaudeRunner().run({ executionId: 'exec-nocanary', requestId: 'req', policy, projectRoot: project, attachments: [], maxTurns: 3 }, { home, hook: hookCommand(), claudePath: fakeClaudePath });
    assert.equal(result.outcome, 'failed');
    assert.ok(result.failureReason?.includes('canary'));
    assert.ok(!fs.existsSync(result.dir.canaryPath));
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_MODE;
    else process.env.FAKE_CLAUDE_MODE = prev;
  }
});

// 2026-09-21: 모델과 추론 강도를 한 문자열(`별칭:강도`)로 실어 보내고 러너가 쪼갠다.
// 강도를 안 고르면 --effort 를 넣지 않는다 — 이 옵션을 모르는 예전 claude 도 돌아야 한다.
test('Claude 인자: 별칭:강도 를 --model 과 --effort 로 쪼갠다', () => {
  assert.deepEqual(splitClaudeModel('sonnet:high'), { model: 'sonnet', effort: 'high' });
  assert.deepEqual(splitClaudeModel('sonnet'), { model: 'sonnet', effort: null });
  assert.deepEqual(splitClaudeModel('sonnet:bogus'), { model: 'sonnet:bogus', effort: null });

  const dir = makeExecDir('effort', tmpDir('claude-effort'));
  const policy = { repository_edit: 'allow', deployment_apply: 'deny' } as any;

  const withEffort = buildClaudeArgs(policy, dir, { maxTurns: 3, model: 'sonnet:high' } as any).join(' ');
  assert.match(withEffort, /--model sonnet /);
  assert.match(withEffort, /--effort high/);

  const plain = buildClaudeArgs(policy, dir, { maxTurns: 3, model: 'sonnet' } as any).join(' ');
  assert.match(plain, /--model sonnet /);
  assert.equal(/--effort/.test(plain), false, '강도를 안 고르면 인자를 넣지 않는다');
});
