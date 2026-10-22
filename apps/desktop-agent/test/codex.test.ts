import { unenforceableProtections } from '@baton/shared';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CodexAdapter, CodexRunner } from '../src/adapter/codex';
import { buildCodexArgs, splitCodexModel } from '../src/adapter/codex/policy';
import { makeExecDir } from '../src/adapter/claude-code/exec-dir';
import { CodexStreamMapper } from '../src/adapter/codex/stream-mapper';
import { registrationCapabilities } from '../src/adapter/interface';
import { Daemon } from '../src/daemon';
import { LocalShellServices } from '../src/services/shell-services';
import { LocalSettingsStore } from '../src/settings/store';
import { PolicySchema } from '../src/transport/events';
import { hookCommand, makeProject, tmpDir, startFakeServer, postJson, waitFor } from './helpers';

const binary = path.join(__dirname, 'fake-codex.mjs');
const policy = PolicySchema.parse({ deployment_apply: 'allow' });
const acknowledgedRisks = unenforceableProtections(new CodexAdapter().getCapabilities(), policy).map((item) => item.key);
function context(projectRoot: string, executionId = 'codex-test') { return { executionId, requestId: 'req', projectRoot, attachments: [], policy, acknowledgedRisks, originalInstruction: 'add 수정' }; }

test('Codex capability·인자: 미지원 권한은 false, resume에도 강제 옵션 보존', () => {
  const capabilities = registrationCapabilities(new CodexAdapter());
  assert.deepEqual(capabilities, { supportsResume: true, supportsStructuredProgress: true, supportsCancel: true, supportsLayer1Patch: false, securityTier: 'tier_b_sandboxed', supportedPolicyEnforcements: { toolDeny: false, networkDeny: true, destructiveCommandDeny: false, credentialPathDeny: false } });
  const ctx = { ...context('/project'), resumeSessionId: 'previous' };
  const args = buildCodexArgs(ctx, makeExecDir('args', tmpDir('codex-args')));
  assert.ok(args.indexOf('-s') < args.indexOf('resume'));
  assert.ok(args.includes('sandbox_workspace_write.network_access=false'));
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.includes('--ignore-user-config') && args.includes('--ignore-rules'));
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('Codex mapper: command/test/edit/error 및 알 수 없는 이벤트', () => {
  const mapper = new CodexStreamMapper();
  assert.equal(mapper.map({ type: 'item.started', item: { type: 'command_execution', command: 'node --test' } })[0].phase, 'testing');
  assert.equal(mapper.map({ type: 'item.completed', item: { type: 'command_execution', command: 'node --test', exit_code: 1 } })[0].phase, 'test_failed');
  assert.equal(mapper.map({ type: 'turn.failed', error: { message: 'x' } })[0].phase, 'warning');
  assert.equal(mapper.map({ type: 'item.started', item: { type: 'command_execution', command: 'rg --files test/add.test.mjs' } })[0].phase, 'exploring');
  assert.deepEqual(mapper.map({ type: 'future' }), []);
});

test('Codex runner: 계층2/3·resume 회차 diff·실패·미지원 정책·취소', async () => {
  const home = tmpDir('codex-home');
  const project = makeProject(tmpDir('codex-project'));
  const adapter = new CodexAdapter({ home, codexPath: binary, timeoutMs: 10_000 });
  const events: string[] = [];
  const callbacks = { onProgress: (e: any) => events.push(e.phase) };
  const first = await adapter.createRunner().run(context(project, 'first'), callbacks);
  assert.equal(first.outcome, 'success');
  assert.deepEqual(first.collected.changedFiles, ['src/add.js']);
  assert.equal(first.collected.layer1.patch, '');
  assert.ok(first.collected.resultMd?.includes('덧셈'));
  assert.ok(events.includes('editing') && events.includes('testing') && events.includes('finished'));
  const second = await adapter.createRunner().run({ ...context(project, 'second'), resumeSessionId: first.sessionId, followUpInstruction: '음수 테스트 추가' }, callbacks);
  assert.equal(second.sessionId, first.sessionId);
  assert.deepEqual(second.collected.changedFiles, ['test/add.test.mjs']);
  assert.ok(!second.collected.patch.includes('+  return a + b;'));
  await assert.rejects(adapter.createRunner().run({ ...context(project, 'denied'), policy: PolicySchema.parse({}) }, callbacks), /execution.capability_mismatch/);
  const limited = await adapter.createRunner().run({ ...context(project, 'limited'), maxTurns: 3 }, callbacks);
  assert.match(limited.failureReason!, /maxTurns/);
  const missing = await new CodexRunner({ home, codexPath: '/missing/codex' }).run(context(project, 'missing-binary'), callbacks);
  assert.equal(missing.outcome, 'failed');
  const previous = process.env.FAKE_CODEX_MODE;
  try {
    process.env.FAKE_CODEX_MODE = 'missing-session';
    const gone = await adapter.createRunner().run({ ...context(project, 'gone'), resumeSessionId: first.sessionId }, callbacks);
    assert.equal(gone.outcome, 'failed');
    assert.equal(gone.resumeFallback, false);
    process.env.FAKE_CODEX_MODE = 'wrong-session';
    const wrong = await adapter.createRunner().run({ ...context(project, 'wrong'), resumeSessionId: first.sessionId }, callbacks);
    assert.equal(wrong.outcome, 'failed');
    assert.match(wrong.failureReason!, /다른 세션/);
    process.env.FAKE_CODEX_MODE = 'hang';
    const runner = adapter.createRunner();
    const running = runner.run(context(project, 'cancel'), callbacks);
    await waitFor(() => fs.existsSync(path.join(project, 'child.pid')));
    const pid = Number(fs.readFileSync(path.join(project, 'child.pid'), 'utf8'));
    runner.cancel(100);
    assert.equal((await running).outcome, 'cancelled');
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    const precancelled = adapter.createRunner();
    precancelled.cancel(0);
    assert.equal((await precancelled.run(context(project, 'pre-cancel'), callbacks)).outcome, 'cancelled');
  } finally {
    if (previous === undefined) delete process.env.FAKE_CODEX_MODE; else process.env.FAKE_CODEX_MODE = previous;
  }
});

test('Codex fake-server: provider 설정·등록·CODEX 명령·실행·진행·업로드·resume', async () => {
  const home = tmpDir('codex-daemon-home');
  const project = makeProject(tmpDir('codex-daemon-project'));
  // Git 임시 인덱스의 초 단위 stat 캐시와 같은 크기 수정이 겹치지 않도록 fixture 시간을 분리한다.
  fs.utimesSync(path.join(project, 'src/add.js'), new Date(0), new Date(0));
  const log: string[] = [];
  const server = await startFakeServer({ log: (line) => log.push(line) });
  const store = new LocalSettingsStore(home);
  store.apply({ serverUrl: server.url(), projectPath: project });
  const daemon = new Daemon({ providers: ['CODEX'], services: new LocalShellServices(store), hook: hookCommand(), home, codexPath: binary });
  try {
    await daemon.start();
    await daemon.pair('BATON-PAIR-123');
    await waitFor(() => log.some((l) => l.startsWith('SSE_CONNECTED')));
    assert.equal([...server.state.agents.values()][0].provider, 'CODEX');
    const cmd = await postJson(`${server.url()}/__test/command`, { provider: 'CODEX', policy, acknowledgedRisks });
    await waitFor(() => server.state.results.has(cmd.executionId));
    const first = server.state.results.get(cmd.executionId);
    assert.equal(first.status, 'SUCCEEDED');
    assert.equal(first.artifactIds.length, 3);
    assert.deepEqual(first.changedFiles, ['src/add.js']);
    const follow = await postJson(`${server.url()}/__test/follow-up`, { previousExecutionId: cmd.executionId, followUpInstruction: '음수 테스트 추가' });
    await waitFor(() => server.state.results.has(follow.executionId));
    assert.equal(server.state.results.get(follow.executionId).claudeSessionId, first.claudeSessionId);
    assert.deepEqual(server.state.results.get(follow.executionId).changedFiles, ['test/add.test.mjs']);
    const unapproved = await postJson(`${server.url()}/__test/command`, { provider: 'CODEX', policy, acknowledgedRisks: [] });
    await waitFor(() => server.state.results.has(unapproved.executionId));
    assert.equal(server.state.results.get(unapproved.executionId).status, 'FAILED');
    assert.equal(JSON.parse(server.state.results.get(unapproved.executionId).failureReason).code, 'execution.capability_mismatch');
    await daemon.sendHeartbeat();
    assert.deepEqual(server.state.heartbeats.at(-1).capabilities, registrationCapabilities(new CodexAdapter()));
    const mismatch = await postJson(`${server.url()}/__test/command`, { provider: 'CLAUDE_CODE', policy });
    await waitFor(() => server.state.results.has(mismatch.executionId));
    assert.equal(server.state.results.get(mismatch.executionId).status, 'FAILED');
    log.push('VERIFIED CODEX registration/heartbeat, command provider dispatch, progress, 3 uploads, same-session resume, provider mismatch rejection');
  } finally {
    await daemon.shutdown(); await server.close();
    process.stderr.write(log.join('\n') + '\n');
  }
});

// 2026-09-21: `codex debug models` 가 계정 기준 카탈로그를 준다. visibility=hide 는 고를 수
// 없는 모델(내부용)이라 목록에서 빼고, 기본값은 config.toml 값이 있으면 그것을 쓴다.
test('Codex 모델 목록: debug models 의 visibility=list 만 고른다', async () => {
  const home = tmpDir('codex-models-home');
  const models = await new CodexAdapter({ home, codexPath: binary }).listModels();
  assert.equal(models.source, 'cli');
  // 추론 강도별로 펼쳐지고, hide 는 빠진다
  assert.deepEqual(models.models.map((m) => m.id), [
    'gpt-6-astra:low',
    'gpt-6-astra:high',
    'gpt-5.5:medium',
  ]);
  assert.equal(models.models[0].label, 'GPT-6-Astra (low, 모델 기본)');
  assert.equal(models.models[0].group, 'GPT-6-Astra');
  assert.equal(models.models[0].effort, 'low');
  assert.equal(models.models[1].effort, 'high');
  assert.ok(models.defaultModel);
});

// 추론 강도를 안 고르면 인자를 넣지 않아 모델 기본 강도로 돈다.
// 예전에는 model_reasoning_effort="low" 가 박혀 있어 어떤 모델도 가장 얕게 돌았다.
test('Codex 인자: 모델:강도 를 쪼개 -m 과 model_reasoning_effort 로 넘긴다', () => {
  assert.deepEqual(splitCodexModel('gpt-6-astra:high'), { slug: 'gpt-6-astra', effort: 'high' });
  assert.deepEqual(splitCodexModel('gpt-6-astra'), { slug: 'gpt-6-astra', effort: null });
  assert.deepEqual(splitCodexModel(undefined), { slug: null, effort: null });

  const dir = { outputDir: '/o', resultMdPath: '/o/result.md', inputDir: '/i', promptPath: '/p', systemAppendPath: '/s' } as any;
  const base = { executionId: 'e', requestId: 'r', projectRoot: '/proj', attachments: [], policy } as any;

  const withEffort = buildCodexArgs({ ...base, model: 'gpt-6-astra:high' }, dir).join(' ');
  assert.match(withEffort, /-m gpt-6-astra/);
  assert.match(withEffort, /model_reasoning_effort="high"/);

  const plain = buildCodexArgs({ ...base, model: 'gpt-6-astra' }, dir).join(' ');
  assert.match(plain, /-m gpt-6-astra/);
  assert.equal(/model_reasoning_effort/.test(plain), false, '강도를 안 고르면 인자를 넣지 않는다');

  const none = buildCodexArgs(base, dir).join(' ');
  assert.equal(/-m /.test(none), false);
  assert.equal(/model_reasoning_effort/.test(none), false);
});
