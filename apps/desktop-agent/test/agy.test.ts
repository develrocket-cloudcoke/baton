import { unenforceableProtections } from '@baton/shared';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AgyAdapter, AgyRunner } from '../src/adapter/agy';
import { buildAgyArgs } from '../src/adapter/agy/policy';
import { AgyStreamMapper } from '../src/adapter/agy/stream-mapper';
import { makeExecDir } from '../src/adapter/claude-code/exec-dir';
import { registrationCapabilities } from '../src/adapter/interface';
import { Daemon } from '../src/daemon';
import { LocalShellServices } from '../src/services/shell-services';
import { LocalSettingsStore } from '../src/settings/store';
import { PolicySchema } from '../src/transport/events';
import { hookCommand, makeProject, tmpDir, startFakeServer, postJson, waitFor } from './helpers';

const binary = path.join(__dirname, 'fake-agy.mjs');
const policy = PolicySchema.parse({ deployment_apply: 'allow', network_outbound: 'allow' });

const acknowledgedRisks = unenforceableProtections(new AgyAdapter().getCapabilities(), policy).map((item) => item.key);
function context(projectRoot: string, executionId = 'agy-test') {
  return {
    executionId,
    requestId: 'req',
    projectRoot,
    attachments: [],
    policy,
    acknowledgedRisks,
    originalInstruction: 'add 수정'
  };
}

test('Antigravity capability·인자: 정직한 capability 선언, resume 플래그 보존', () => {
  const capabilities = registrationCapabilities(new AgyAdapter());
  assert.deepEqual(capabilities, {
    supportsResume: true,
    supportsStructuredProgress: true,
    supportsCancel: true,
    supportsLayer1Patch: false,
    securityTier: 'tier_c_unrestricted',
    supportedPolicyEnforcements: {
      toolDeny: false,
      networkDeny: false,
      destructiveCommandDeny: false,
      credentialPathDeny: false
    }
  });

  const ctx = {
    ...context('/project'),
    resumeSessionId: '12345678-1234-1234-1234-123456789abc'
  };
  const args = buildAgyArgs(ctx, 'test prompt', 60_000);
  assert.ok(args.includes('-p') && args.includes('test prompt'));
  assert.ok(args.includes('--output-format') && args.includes('stream-json'));
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(args.includes('--sandbox'));
  assert.ok(args.includes('--disable-slash-commands'));
  assert.ok(args.includes('--conversation') && args.includes('12345678-1234-1234-1234-123456789abc'));
  assert.ok(args.includes('--print-timeout') && args.includes('60s'));
});

test('Antigravity mapper: tool/test/edit/response 및 알 수 없는 이벤트', () => {
  const mapper = new AgyStreamMapper();
  // init
  assert.equal(
    mapper.map({ event: 'init', conversation_id: 'uuid-1', init: { model: 'gemini-3.8-flash-low' } })[0].phase,
    'started'
  );
  // user_input
  assert.equal(
    mapper.map({ event: 'step_update', step_update: { step_index: 0, state: 'DONE', step_type: 'user_input' } })[0].phase,
    'reading_input'
  );
  // tool write_to_file
  assert.equal(
    mapper.map({
      event: 'step_update',
      step_update: {
        step_index: 1,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'write_to_file',
        tool_info: { name: 'write_to_file', parameters: { TargetFile: 'src/add.js' } }
      }
    })[0].phase,
    'editing'
  );
  // tool run_command test
  assert.equal(
    mapper.map({
      event: 'step_update',
      step_update: {
        step_index: 2,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'node --test' } }
      }
    })[0].phase,
    'testing'
  );
  assert.equal(
    mapper.map({
      event: 'step_update',
      step_update: {
        step_index: 2,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'node --test' }, output: '# ok' }
      }
    })[0].phase,
    'test_passed'
  );
  // agent_response
  assert.equal(
    mapper.map({
      event: 'step_update',
      step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'hello' }
    })[0].phase,
    'note'
  );
  // result
  assert.equal(
    mapper.map({ event: 'result', result: { status: 'SUCCESS', response: 'done' } })[0].phase,
    'finished'
  );
  // unknown event
  assert.deepEqual(mapper.map({ event: 'future_event' }), []);
});

test('Antigravity runner: 계층2/3·resume 회차 diff·실패·미지원 정책·취소', async () => {
  const home = tmpDir('agy-home');
  const project = makeProject(tmpDir('agy-project'));
  const adapter = new AgyAdapter({ home, agyPath: binary, timeoutMs: 10_000 });
  const events: string[] = [];
  const callbacks = { onProgress: (e: any) => events.push(e.phase) };

  // 1회차 실행: 정상 파일 생성 및 계층 2 수집
  const first = await adapter.createRunner().run(context(project, 'first'), callbacks);
  assert.equal(first.outcome, 'success');
  assert.deepEqual(first.collected.changedFiles, ['src/add.js']);
  assert.equal(first.collected.layer1.patch, '');
  assert.ok(first.collected.resultMd?.includes('덧셈'));
  assert.ok(events.includes('editing') && events.includes('testing') && events.includes('finished'));

  // 2회차 resume 실행: 세션 유지 및 2회차 변경 파일만 수집
  const second = await adapter.createRunner().run(
    {
      ...context(project, 'second'),
      resumeSessionId: first.sessionId,
      followUpInstruction: '음수 테스트 추가'
    },
    callbacks
  );
  assert.equal(second.sessionId, first.sessionId);
  assert.deepEqual(second.collected.changedFiles, ['test/add.test.mjs']);
  assert.ok(!second.collected.patch.includes('+  return a + b;'));

  // 현재 정책의 보호가 승인 목록보다 늘어나면 실행 전에 독립 검증으로 거부한다.
  for (const deniedPolicy of [
    PolicySchema.parse({ network_outbound: 'allow', deployment_apply: 'deny' }),
    PolicySchema.parse({ deployment_apply: 'allow', network_outbound: 'deny' })
  ]) {
    await assert.rejects(adapter.createRunner().run({ ...context(project, 'denied'), policy: deniedPolicy }, callbacks), /execution.capability_mismatch/);
  }

  // 미지원 제한 (maxBudgetUsd)
  const limited = await adapter.createRunner().run(
    { ...context(project, 'limited'), maxBudgetUsd: 10 },
    callbacks
  );
  assert.match(limited.failureReason!, /maxBudgetUsd/);

  // 잘못된 바이너리 경로
  const missing = await new AgyRunner({ home, agyPath: '/missing/agy' }).run(
    context(project, 'missing-binary'),
    callbacks
  );
  assert.equal(missing.outcome, 'failed');

  // 에러 모드 테스트
  const previous = process.env.FAKE_AGY_MODE;
  try {
    process.env.FAKE_AGY_MODE = 'missing-session';
    const gone = await adapter.createRunner().run(
      { ...context(project, 'gone'), resumeSessionId: first.sessionId },
      callbacks
    );
    assert.equal(gone.outcome, 'failed');
    assert.equal(gone.resumeFallback, false);

    process.env.FAKE_AGY_MODE = 'wrong-session';
    const wrong = await adapter.createRunner().run(
      { ...context(project, 'wrong'), resumeSessionId: first.sessionId },
      callbacks
    );
    assert.equal(wrong.outcome, 'failed');
    assert.match(wrong.failureReason!, /다른 세션/);

    process.env.FAKE_AGY_MODE = 'hang';
    const runner = adapter.createRunner();
    const running = runner.run(context(project, 'cancel'), callbacks);
    await waitFor(() => fs.existsSync(path.join(project, 'child.pid')));
    const pid = Number(fs.readFileSync(path.join(project, 'child.pid'), 'utf8'));
    runner.cancel(100);
    assert.equal((await running).outcome, 'cancelled');
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });

    const precancelled = adapter.createRunner();
    precancelled.cancel(0);
    assert.equal((await precancelled.run(context(project, 'pre-cancel'), callbacks)).outcome, 'cancelled');
  } finally {
    if (previous === undefined) delete process.env.FAKE_AGY_MODE;
    else process.env.FAKE_AGY_MODE = previous;
  }
});

test('Antigravity fake-server: provider 설정·등록·AGY 명령·실행·진행·업로드·resume', async () => {
  const home = tmpDir('agy-daemon-home');
  const project = makeProject(tmpDir('agy-daemon-project'));
  // Git 임시 인덱스의 초 단위 stat 캐시와 같은 크기 수정이 겹치지 않도록 fixture 시간을 분리한다.
  fs.utimesSync(path.join(project, 'src/add.js'), new Date(0), new Date(0));
  const log: string[] = [];
  const server = await startFakeServer({ log: (line) => log.push(line) });
  const store = new LocalSettingsStore(home);
  store.apply({ serverUrl: server.url(), projectPath: project });
  const daemon = new Daemon({ providers: ['AGY'],
    services: new LocalShellServices(store),
    hook: hookCommand(),
    home,
    agyPath: binary
  });

  try {
    await daemon.start();
    await daemon.pair('BATON-PAIR-123');
    await waitFor(() => log.some((l) => l.startsWith('SSE_CONNECTED')));

    // 1) 서버에 AGY provider 로 Agent 가 등록되었는지 검증
    assert.equal([...server.state.agents.values()][0].provider, 'AGY');

    // 2) AGY 명령 실행 검증
    const cmd = await postJson(`${server.url()}/__test/command`, { provider: 'AGY', policy, acknowledgedRisks });
    await waitFor(() => server.state.results.has(cmd.executionId));
    const first = server.state.results.get(cmd.executionId);
    assert.equal(first.status, 'SUCCEEDED');
    assert.equal(first.artifactIds.length, 3);
    assert.deepEqual(first.changedFiles, ['src/add.js']);

    // 3) 후속 작업 요청(follow-up resume) 검증
    const follow = await postJson(`${server.url()}/__test/follow-up`, {
      previousExecutionId: cmd.executionId,
      followUpInstruction: '음수 테스트 추가'
    });
    await waitFor(() => server.state.results.has(follow.executionId));
    assert.equal(server.state.results.get(follow.executionId).claudeSessionId, first.claudeSessionId);
    assert.deepEqual(server.state.results.get(follow.executionId).changedFiles, ['test/add.test.mjs']);

    // 4) Heartbeat 에 AGY capability 보고 검증
    const unapproved = await postJson(`${server.url()}/__test/command`, { provider: 'AGY', policy, acknowledgedRisks: [] });
    await waitFor(() => server.state.results.has(unapproved.executionId));
    assert.equal(server.state.results.get(unapproved.executionId).status, 'FAILED');
    assert.equal(JSON.parse(server.state.results.get(unapproved.executionId).failureReason).code, 'execution.capability_mismatch');
    await daemon.sendHeartbeat();
    assert.deepEqual(server.state.heartbeats.at(-1).capabilities, registrationCapabilities(new AgyAdapter()));

    // 5) 다른 Provider (CLAUDE_CODE) 명령 도착 시 거부(FAILED) 처리 검증
    const mismatch = await postJson(`${server.url()}/__test/command`, { provider: 'CLAUDE_CODE', policy });
    await waitFor(() => server.state.results.has(mismatch.executionId));
    assert.equal(server.state.results.get(mismatch.executionId).status, 'FAILED');

    log.push('VERIFIED AGY registration/heartbeat, command provider dispatch, progress, 3 uploads, same-session resume, provider mismatch rejection');
  } finally {
    await daemon.shutdown();
    await server.close();
    process.stderr.write(log.join('\n') + '\n');
  }
});
