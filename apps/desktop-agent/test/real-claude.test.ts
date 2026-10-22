import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { snapshotTree } from '../src/adapter/claude-code/collector';
import { findClaude } from '../src/adapter/claude-code/runner';
import { ClaudeRunner } from '../src/adapter/claude-code/runner';
import { ProgressEvent } from '../src/adapter/claude-code/stream-mapper';
import { PolicySchema } from '../src/transport/events';
import { hookCommand, makeProject, tmpDir } from './helpers';

// 실제 claude 1회 실행 (haiku, --max-turns 3, 임시 git 프로젝트). 비용 약 $0.03~0.05.
// BATON_SKIP_REAL_CLAUDE=1 이거나 claude 가 없으면 건너뛴다.
const claude = findClaude();
const skip = process.env.BATON_SKIP_REAL_CLAUDE === '1' || !claude;

test('adapter 실제 실행: claude -p --max-turns 3 (haiku) 진행 이벤트·canary·결과 수집', { skip: skip ? 'claude 없음 또는 BATON_SKIP_REAL_CLAUDE=1' : false, timeout: 180_000 }, async () => {
  const home = tmpDir('home');
  const project = makeProject(tmpDir('proj'));
  const progress: ProgressEvent[] = [];
  const result = await new ClaudeRunner().run(
    {
      executionId: 'exec-real',
      requestId: 'req-real',
      title: 'add() 버그 수정',
      originalInstruction: 'src/add.js 의 add() 가 뺄셈을 합니다. 덧셈으로 고치고 `node --test` 로 확인해 주세요.',
      additionalInstruction: '- src/ 아래만 수정할 것',
      policy: PolicySchema.parse({ repository_edit: 'allow', deployment_apply: 'deny' }),
      projectRoot: project,
      attachments: [],
      maxTurns: 3,
      model: 'haiku'
    },
    { home, hook: hookCommand(), claudePath: claude!, onProgress: (e) => progress.push(e) }
  );
  fs.writeFileSync(`${result.dir.root}/progress.json`, JSON.stringify(progress, null, 2));
  assert.ok(fs.existsSync(result.dir.canaryPath), 'canary.ok');
  assert.ok(['success', 'partial'].includes(result.outcome), `${result.outcome} ${result.failureReason ?? ''}`);
  const phases = progress.map((p) => p.phase);
  assert.equal(phases[0], 'started');
  assert.ok(phases.some((p) => p === 'finished' || p === 'finished_partial'));
  assert.ok(result.numTurns !== null && result.numTurns <= 4);
  assert.ok(fs.existsSync(result.dir.streamPath));
  process.stderr.write(`real claude: outcome=${result.outcome} turns=${result.numTurns} cost=$${result.costUsd} phases=${phases.join(',')} changed=${result.collected.changedFiles.join(',')}\n`);
});

// 기획서 §18 추가 작업 요청을 실제 claude 로 1회 확인한다 (haiku, --max-turns 3 × 2회, 비용 약 $0.06~0.1).
// **판정은 결정적 신호만 쓴다.** 예전에는 "result.md 가 1회차에 고친 파일을 짚는가" 로 세션 이어가기를 봤는데,
// 모델이 result.md 를 아예 안 쓰거나 파일명을 안 적으면 실패해 간헐적으로 깨졌다(2026-09-11 실측).
// 이어가기의 결정적 증거는 ① resume 이 폴백하지 않았고(resumeFallback=false) ② system/init 이 같은 세션 id 를 돌려준 것이다
// — 없는 세션을 --resume 하면 claude 는 init 없이 error_during_execution 으로 죽으므로, 세션 id 동일성 자체가 증거다.
// 계층2 범위(이번 회차 변경만)도 모델 출력이 아니라 **2회차 baseline tree 가 1회차 종료 시점 워킹트리와 같은지**로 본다.
// 모델 출력에 기대는 확인(result.md 문구·수정 파일 목록)은 경고 로그로만 남긴다.
test('adapter 실제 실행 2회차: --resume 으로 세션을 이어가고 이번 회차 변경만 수집', { skip: skip ? 'claude 없음 또는 BATON_SKIP_REAL_CLAUDE=1' : false, timeout: 300_000 }, async () => {
  const home = tmpDir('home');
  const project = makeProject(tmpDir('proj'));
  const common = { requestId: 'req-resume', policy: PolicySchema.parse({ repository_edit: 'allow', deployment_apply: 'deny' }), projectRoot: project, attachments: [], maxTurns: 3, model: 'haiku' as const };
  const first = await new ClaudeRunner().run(
    { ...common, executionId: 'exec-real-1', title: 'add() 버그 수정', originalInstruction: 'src/add.js 의 add() 가 뺄셈을 합니다. 덧셈으로 고쳐 주세요.' },
    { home, hook: hookCommand(), claudePath: claude! }
  );
  assert.ok(['success', 'partial'].includes(first.outcome), `1회차 ${first.outcome} ${first.failureReason ?? ''}`);
  assert.match(first.sessionId, /^[0-9a-f-]{36}$/, 'system/init 에서 읽은 세션 id');
  // 1회차가 끝난 직후의 워킹트리를 tree object 로 남겨 둔다 (2회차 기준점 비교용, 사용자 인덱스는 건드리지 않는다)
  const afterFirstTree = snapshotTree(project, path.join(tmpDir('idx'), 'snapshot.index'));
  assert.ok(afterFirstTree, '1회차 종료 스냅샷을 만들지 못했다');

  const progress: ProgressEvent[] = [];
  const second = await new ClaudeRunner().run(
    {
      ...common,
      executionId: 'exec-real-2',
      title: 'add() 버그 수정',
      originalInstruction: 'src/add.js 의 add() 가 뺄셈을 합니다. 덧셈으로 고쳐 주세요.',
      followUpInstruction: '바로 앞 턴에서 네가 수정한 파일의 경로를 result.md 의 "## 요약" 첫 줄에 그대로 적어라. 그리고 test/add.test.mjs 에 음수 덧셈 케이스를 한 개 추가해라.',
      resumeSessionId: first.sessionId
    },
    { home, hook: hookCommand(), claudePath: claude!, onProgress: (e) => progress.push(e) }
  );
  fs.writeFileSync(`${second.dir.root}/progress.json`, JSON.stringify(progress, null, 2));
  assert.ok(['success', 'partial'].includes(second.outcome), `2회차 ${second.outcome} ${second.failureReason ?? ''}`);
  assert.equal(second.resumedFrom, first.sessionId);
  assert.equal(second.resumeFallback, false, 'resume 이 성공해야 한다');
  assert.equal(second.sessionId, first.sessionId, '--resume 은 같은 세션을 이어간다');
  // 이어가기 프롬프트에는 원본 요청도 파일명도 없다 (우리가 렌더링하므로 결정적이다)
  const prompt = fs.readFileSync(second.dir.promptPath, 'utf8');
  assert.ok(!prompt.includes('add.js'), '이어가기 프롬프트에 파일명이 없어야 검증이 성립한다');
  assert.equal(second.manifest.resumeFallback, undefined, '폴백 기록이 남으면 세션을 이어가지 못한 것이다');

  // 계층2 기준점: 2회차 baseline tree 는 **1회차가 끝난 뒤의 워킹트리**여야 한다.
  // 그래야 1회차 변경(src/add.js)이 2회차 diff 에 다시 섞이지 않는다. 모델이 무엇을 했는지와 무관하게 성립한다.
  const baselineTree = (second.manifest.gitBaseline as { tree?: string | null } | null)?.tree;
  assert.ok(baselineTree, '2회차 baseline tree 를 만들지 못했다');
  assert.equal(
    execFileSync('git', ['-C', project, 'diff', '--name-only', afterFirstTree!, baselineTree!], { encoding: 'utf8' }).trim(),
    '',
    '2회차 기준점이 1회차 종료 시점 워킹트리와 다르다'
  );

  // 아래는 모델 출력에 기대는 확인이라 단언하지 않고 경고만 남긴다 (모델이 result.md 를 안 쓰는 회차가 있다).
  const soft: string[] = [];
  if (!second.collected.resultMd?.includes('add.js')) soft.push(`result.md 가 1회차 파일을 짚지 않음: ${second.collected.resultMd?.slice(0, 120) ?? '(result.md 없음)'}`);
  if (!second.collected.changedFiles.includes('test/add.test.mjs')) soft.push('이번 회차에 test/add.test.mjs 를 고치지 않음');
  if (second.collected.patch.includes('diff --git a/src/add.js')) soft.push('2회차에 src/add.js 를 다시 고침');
  process.stderr.write(
    `real claude resume: session=${second.sessionId} outcome=${second.outcome} turns=${second.numTurns} cost=$${second.costUsd} changed=${second.collected.changedFiles.join(',')}${soft.length ? ` warn=[${soft.join(' | ')}]` : ''}\n`
  );
});

// 공통 팩토리 경유도 실제 CLI의 canary와 성공 결과를 그대로 전달하는지 확인한다.
test('공통 Adapter 실제 실행: haiku max-turns 3 성공 결과 전달', { skip: skip ? 'claude 없음 또는 BATON_SKIP_REAL_CLAUDE=1' : false, timeout: 180_000 }, async () => {
  const { ClaudeCodeAdapter } = await import('../src/adapter/claude-code/adapter');
  const { AgentAdapterRegistry } = await import('../src/adapter/registry');
  const home = tmpDir('adapter-real-home');
  const project = makeProject(tmpDir('adapter-real-proj'));
  const adapter = new ClaudeCodeAdapter({ home, hook: hookCommand(), claudePath: claude! });
  const detection = await adapter.detect();
  assert.equal(detection.available, true);
  const runner = new AgentAdapterRegistry([adapter]).get('CLAUDE_CODE').createRunner();
  const progress: ProgressEvent[] = [];
  const chunks: string[] = [];
  const result = await runner.run({
    executionId: 'exec-adapter-real', requestId: 'req-adapter-real',
    originalInstruction: '이것은 CLI 연결 확인입니다. 파일을 읽거나 수정하거나 도구를 호출할 필요가 없습니다. 최종 답변으로 연결 확인 완료 한 줄만 출력하세요.',
    projectRoot: project, policy: PolicySchema.parse({}), attachments: [], model: 'haiku', maxTurns: 3
  }, { onProgress: (event) => progress.push(event), onLogChunk: (chunk) => chunks.push(chunk) });
  assert.equal(result.outcome, 'success', result.failureReason ?? '');
  assert.ok(fs.existsSync(result.dir.canaryPath));
  assert.ok(progress.some((event) => event.phase === 'started'));
  assert.ok(progress.some((event) => event.phase === 'finished'));
  assert.ok(chunks.join('').includes('"type":"result"'));
  process.stderr.write(`real adapter: version=${detection.version} outcome=${result.outcome} turns=${result.numTurns} cost=$${result.costUsd} canary=OK manifest=${result.dir.manifestPath}\n`);
});
