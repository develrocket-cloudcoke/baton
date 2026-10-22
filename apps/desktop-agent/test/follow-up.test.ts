import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Daemon } from '../src/daemon';
import { makeExecDir } from '../src/adapter/claude-code/exec-dir';
import { buildClaudeArgs } from '../src/adapter/claude-code/policy';
import { renderFollowUpPrompt, renderPrompt } from '../src/adapter/claude-code/prompt';
import { ClaudeRunner } from '../src/adapter/claude-code/runner';
import { ProgressEvent } from '../src/adapter/claude-code/stream-mapper';
import { LocalShellServices } from '../src/services/shell-services';
import { LocalSettingsStore } from '../src/settings/store';
import { PolicySchema } from '../src/transport/events';
import { fakeClaudePath, hookCommand, makeProject, postJson, startFakeServer, tmpDir, waitFor } from './helpers';

// 기획서 §18 "결과 검토 → 추가 작업 요청" 의 데스크톱측 계약:
// execution.command.requested 에 followUpInstruction + resumeSessionId 가 오면
// claude 를 `--resume <세션id>` 로 이어 실행하고, 프롬프트에는 이번 회차 지시만 싣는다.
const policy = PolicySchema.parse({ repository_edit: 'allow', deployment_apply: 'deny' });
const ORIGINAL = 'src/add.js 의 add() 가 뺄셈을 합니다. 덧셈으로 고쳐주세요.';
const FOLLOW_UP = '테스트 케이스를 하나 더 추가해줘.';

test('resume 인자: --resume <세션id> 를 쓰고 --session-id 는 쓰지 않는다', () => {
  const dir = makeExecDir('exec-resume-args', tmpDir('home'));
  const args = buildClaudeArgs(policy, dir, { sessionId: 'sess-1', maxTurns: 3, model: 'haiku', resume: true });
  assert.deepEqual(args.slice(-2), ['--resume', 'sess-1']);
  assert.ok(!args.includes('--session-id'));
  const fresh = buildClaudeArgs(policy, dir, { sessionId: 'sess-1', maxTurns: 3, model: 'haiku' });
  assert.deepEqual(fresh.slice(-2), ['--session-id', 'sess-1']);
});

test('이어가기 프롬프트: 이번 회차 지시만 싣고 원본 요청은 반복하지 않는다', () => {
  const dir = makeExecDir('exec-followup-prompt', tmpDir('home'));
  const input = { requestId: 'req-1', senderName: 'A', originalInstruction: ORIGINAL, additionalInstruction: '운영 환경은 변경하지 마', followUpInstruction: FOLLOW_UP, policy, projectRoot: '/proj' };
  const prompt = renderFollowUpPrompt(input, dir);
  assert.ok(prompt.includes('## 1. 이어서 할 일'));
  assert.ok(prompt.includes(FOLLOW_UP));
  assert.ok(!prompt.includes(ORIGINAL), '원본 요청 본문은 세션이 이미 갖고 있으므로 다시 싣지 않는다');
  assert.ok(prompt.includes('## 3. 실행 정책 (Policy)') && prompt.includes('- repository_edit: allow'));
  assert.ok(prompt.includes(dir.resultMdPath));
  // resume 실패 폴백에서는 반대로 원본 + 이어서 할 일을 함께 싣는다
  const full = renderPrompt({ ...input, resumeFailed: true }, dir);
  assert.ok(full.includes(ORIGINAL) && full.includes(FOLLOW_UP));
  assert.ok(full.includes('## 7. 이어서 할 일 (추가 작업 요청)'));
  assert.ok(full.includes('이전 실행 세션을 이어갈 수 없어'));
});

test('runner 2회차(--resume): 세션 이어가기 + 계층2 가 이번 회차 변경만 잡는다', async () => {
  const home = tmpDir('home');
  const project = makeProject(tmpDir('proj'));
  const first = await new ClaudeRunner().run(
    { executionId: 'exec-r1', requestId: 'req-r', originalInstruction: ORIGINAL, policy, projectRoot: project, attachments: [], sessionId: 'sess-round-1', maxTurns: 3, model: 'haiku' },
    { home, hook: hookCommand(), claudePath: fakeClaudePath }
  );
  assert.equal(first.outcome, 'success', first.failureReason ?? '');
  assert.equal(first.sessionId, 'sess-round-1', 'system/init 의 session_id 를 그대로 쓴다');
  assert.equal(first.resumedFrom, null);
  assert.deepEqual(first.collected.changedFiles, ['src/add.js']);

  const progress: ProgressEvent[] = [];
  const second = await new ClaudeRunner().run(
    { executionId: 'exec-r2', requestId: 'req-r', originalInstruction: ORIGINAL, followUpInstruction: FOLLOW_UP, resumeSessionId: first.sessionId, policy, projectRoot: project, attachments: [], maxTurns: 3, model: 'haiku' },
    { home, hook: hookCommand(), claudePath: fakeClaudePath, onProgress: (e) => progress.push(e) }
  );
  assert.equal(second.outcome, 'success', second.failureReason ?? '');
  assert.equal(second.resumedFrom, 'sess-round-1');
  assert.equal(second.resumeFallback, false);
  assert.equal(second.sessionId, 'sess-round-1', '--resume 은 같은 세션을 이어간다');
  assert.deepEqual(second.manifest.claudeArgs.slice(-2), ['--resume', 'sess-round-1']);
  // 실행 디렉터리는 회차마다 따로다 → 1회차 산출물이 덮이지 않는다
  assert.notEqual(second.dir.root, first.dir.root);
  assert.ok(fs.readFileSync(first.dir.resultMdPath, 'utf8').includes('뺄셈 버그'));
  assert.ok(second.collected.resultMd?.includes('테스트 케이스를 하나 더'));
  // 핵심: 이번 회차 변경만 (1회차의 src/add.js 수정이 다시 섞이지 않는다)
  assert.deepEqual(second.collected.changedFiles, ['test/add.test.mjs']);
  assert.ok(second.collected.patch.includes("+test('add negative'"));
  assert.ok(!second.collected.patch.includes('+  return a + b;'), '이전 회차 변경은 이번 patch 에 없어야 한다');
  assert.ok(progress.map((p) => p.phase).includes('editing'));
  // 프롬프트에도 이번 회차 지시만 들어간다
  const prompt = fs.readFileSync(second.dir.promptPath, 'utf8');
  assert.ok(prompt.includes(FOLLOW_UP) && !prompt.includes(ORIGINAL));
});

test('resume 실패(세션 만료·삭제): 새 세션으로 원본 맥락을 다시 싣고 재시도 + 진행 상태 보고', async () => {
  const home = tmpDir('home');
  const project = makeProject(tmpDir('proj'));
  const progress: ProgressEvent[] = [];
  const prev = process.env.FAKE_CLAUDE_MODE;
  process.env.FAKE_CLAUDE_MODE = 'resumefail';
  try {
    const result = await new ClaudeRunner().run(
      { executionId: 'exec-resume-fail', requestId: 'req-r', originalInstruction: ORIGINAL, followUpInstruction: FOLLOW_UP, resumeSessionId: 'sess-gone-1234', policy, projectRoot: project, attachments: [], sessionId: 'sess-new-5678', maxTurns: 3, model: 'haiku' },
      { home, hook: hookCommand(), claudePath: fakeClaudePath, onProgress: (e) => progress.push(e) }
    );
    assert.equal(result.outcome, 'success', result.failureReason ?? '');
    assert.equal(result.resumeFallback, true);
    assert.equal(result.resumedFrom, 'sess-gone-1234');
    assert.equal(result.sessionId, 'sess-new-5678', '새 세션 id 로 실행된다');
    const warning = progress.find((p) => p.phase === 'warning');
    assert.ok(warning, 'resume 실패를 진행 상태로 보고한다');
    assert.ok(warning!.message.includes('새 세션'));
    assert.ok(warning!.message.includes('No conversation found'), 'claude 가 준 사유를 그대로 전달');
    // 폴백 프롬프트에는 원본 맥락 + 이번 회차 지시가 모두 있다
    const prompt = fs.readFileSync(result.dir.promptPath, 'utf8');
    assert.ok(prompt.includes(ORIGINAL) && prompt.includes(FOLLOW_UP));
    const manifest = JSON.parse(fs.readFileSync(result.dir.manifestPath, 'utf8'));
    assert.equal(manifest.resumeFallback.resumedFrom, 'sess-gone-1234');
    assert.ok(!manifest.resumeFallback.claudeArgs.includes('--resume'));
    assert.deepEqual(result.collected.changedFiles, ['src/add.js']);
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_MODE;
    else process.env.FAKE_CLAUDE_MODE = prev;
  }
});

test('데몬 E2E(fake-server): 실행 → 세션 id 보고 → 추가 작업 요청 → --resume 으로 이어 실행', async () => {
  const home = tmpDir('home');
  const project = makeProject(tmpDir('proj'));
  const serverLog: string[] = [];
  const fake = await startFakeServer({ log: (l) => serverLog.push(l) });
  const store = new LocalSettingsStore(home);
  store.apply({ serverUrl: fake.url(), projectPath: project, deviceName: 'test-mac' });
  const daemon = new Daemon({ providers: ['CLAUDE_CODE'], services: new LocalShellServices(store), hook: hookCommand(), home, claudePath: fakeClaudePath, statusIntervalMs: 60_000 });
  try {
    await daemon.start();
    await daemon.pair('BATON-PAIR-123');
    await waitFor(() => serverLog.some((l) => l.startsWith('SSE_CONNECTED')));

    // 1회차
    const first = await postJson(`${fake.url()}/__test/command`, { title: 'add 버그', originalInstruction: ORIGINAL, policy: { repository_edit: 'allow', deployment_apply: 'deny' } });
    await waitFor(() => fake.state.results.has(first.executionId), 30_000);
    const afterFirst = await (await fetch(`${fake.url()}/__test/state`)).json();
    // ③ 실행 시작 보고(started)에 세션 id 가 실린다
    const started = afterFirst.statuses.find((s: any) => s.executionId === first.executionId && s.phase === 'started');
    assert.ok(started?.sessionId, 'started 보고에 sessionId');
    assert.equal(afterFirst.sessions[first.executionId], started.sessionId);
    assert.deepEqual(afterFirst.results[first.executionId].changedFiles, ['src/add.js']);

    // 2회차: 서버가 직전 실행의 세션 id 를 resumeSessionId 로 실어 추가 작업을 시킨다
    const second = await postJson(`${fake.url()}/__test/follow-up`, { previousExecutionId: first.executionId, followUpInstruction: FOLLOW_UP });
    assert.equal(second.resumeSessionId, started.sessionId);
    await waitFor(() => fake.state.results.has(second.executionId), 30_000);
    const st = await (await fetch(`${fake.url()}/__test/state`)).json();
    const manifest = JSON.parse(fs.readFileSync(path.join(home, 'executions', second.executionId, 'manifest.json'), 'utf8'));
    assert.equal(manifest.resumedFrom, started.sessionId);
    assert.deepEqual(manifest.claudeArgs.slice(-2), ['--resume', started.sessionId]);
    const running = st.statuses.find((s: any) => s.executionId === second.executionId && s.status === 'RUNNING');
    assert.equal(running.sessionId, started.sessionId, '시작 보고에 이어갈 세션 id');
    const result = st.results[second.executionId];
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.claudeSessionId, started.sessionId, '같은 세션을 이어갔다');
    assert.deepEqual(result.changedFiles, ['test/add.test.mjs'], '이번 회차 변경만 보고');
    assert.ok(!result.patch.includes('+  return a + b;'));
    assert.ok(result.summary.includes('테스트 케이스'));
    assert.ok(serverLog.some((l) => l.startsWith('FOLLOW_UP')));
  } finally {
    await daemon.shutdown();
    await fake.close();
  }
});
