import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { collectAll } from '../src/adapter/claude-code/collector';
import { makeExecDir } from '../src/adapter/claude-code/exec-dir';
import { decidePreToolUse } from '../src/adapter/claude-code/hook';
import { batonSecretPaths, buildClaudeSettings, buildHookPolicy, credentialPaths } from '../src/adapter/claude-code/policy';
import { PolicySchema } from '../src/transport/events';
import { tmpDir } from './helpers';

// 2026-09-14 회귀: credentialPaths() 가 Baton 홈을 **디렉터리째** 막으면서 실행 디렉터리까지 같이 막혔다.
// 실행 디렉터리는 <BATON_HOME>/executions/<id>/ 라, 에이전트가 자기 첨부(input/docs)를 못 읽고
// 결과 문서(output/result.md)도 못 썼다. 터널 테스트에서 "권한으로 인해 첨부 파일을 직접 읽을 수 없습니다" 로 드러났다.
//
// 기존 테스트가 못 잡은 이유: 테스트는 BATON_HOME 을 세팅하지 않고 tmpdir 을 home 인자로만 넘겨서
// 실행 디렉터리와 차단 목록이 애초에 겹치지 않았다. 그래서 이 파일은 **BATON_HOME 을 실제로 세팅한다.**
const policy = PolicySchema.parse({ repository_edit: 'allow', deployment_apply: 'deny' });

function withBatonHome<T>(fn: (home: string, batonHome: string) => T): T {
  const home = tmpDir('bh-home');
  const batonHome = path.join(home, 'baton-home');
  const prev = process.env.BATON_HOME;
  process.env.BATON_HOME = batonHome;
  try {
    return fn(home, batonHome);
  } finally {
    if (prev === undefined) delete process.env.BATON_HOME;
    else process.env.BATON_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('BATON_HOME 을 세팅해도 실행 디렉터리(첨부·결과)는 막히지 않는다', () => {
  withBatonHome((home, batonHome) => {
    const dir = makeExecDir('exec-bh', batonHome);
    const projectRoot = tmpDir('bh-project');
    const attachment = path.join(dir.docsDir, 'analysis.md');
    fs.writeFileSync(attachment, '# 분석\n');

    // ① hook: 첨부 읽기는 통과해야 한다
    const hookPolicy = buildHookPolicy(policy, dir, projectRoot, home);
    const readDoc = decidePreToolUse(hookPolicy, { tool_name: 'Read', tool_input: { file_path: attachment }, cwd: projectRoot });
    assert.equal(readDoc.decision, 'pass', `첨부 읽기가 막혔다: ${readDoc.reason ?? ''}`);

    // ② hook: 결과 문서 쓰기는 통과해야 한다 (output 은 writableRoots 에 있다)
    const writeResult = decidePreToolUse(hookPolicy, { tool_name: 'Write', tool_input: { file_path: dir.resultMdPath }, cwd: projectRoot });
    assert.equal(writeResult.decision, 'pass', `결과 문서 쓰기가 막혔다: ${writeResult.reason ?? ''}`);

    // ③ hook: 디바이스 토큰 읽기는 여전히 막혀야 한다 (H-3 체인 유지)
    const token = path.join(batonHome, 'device-token');
    const readToken = decidePreToolUse(hookPolicy, { tool_name: 'Read', tool_input: { file_path: token }, cwd: projectRoot });
    assert.equal(readToken.decision, 'deny', '디바이스 토큰은 계속 막혀야 한다');
    assert.ok(readToken.reason?.includes('자격증명 경로 읽기 금지'));
    // Grep·Glob 로 우회하는 경로도 같이 본다 (Bash `cat` 은 hook 이 아니라 sandbox.credentials 가 막는다 — ④ 에서 확인)
    for (const tool of ['Grep', 'Glob'] as const) {
      const d = decidePreToolUse(hookPolicy, { tool_name: tool, tool_input: { path: token }, cwd: projectRoot });
      assert.equal(d.decision, 'deny', `${tool} 로 토큰을 읽는 경로가 열려 있으면 안 된다`);
    }

    // ④ claude-settings: 실행 디렉터리가 어떤 차단 목록에도 없어야 한다
    const settings = buildClaudeSettings(policy, dir, { node: 'node', cli: 'cli.js' }, home) as any;
    const deny: string[] = settings.permissions.deny;
    const denyRead: string[] = settings.sandbox.filesystem.denyRead;
    const credFiles: string[] = settings.sandbox.credentials.files.map((f: any) => f.path);
    for (const [label, list] of [['permissions.deny', deny], ['sandbox.denyRead', denyRead], ['sandbox.credentials', credFiles]] as const) {
      assert.ok(!list.some((p) => p === batonHome || p.endsWith(`//${batonHome}`)), `${label} 에 Baton 홈이 통째로 들어가면 실행 디렉터리가 막힌다`);
      assert.ok(!list.some((p) => p.includes(dir.root)), `${label} 에 실행 디렉터리가 들어가면 안 된다`);
    }
    // 반대로 토큰 파일은 세 목록 모두에 있어야 한다
    assert.ok(deny.some((p) => p.includes(token)), 'permissions.deny 에 토큰 파일');
    assert.ok(denyRead.includes(token), 'sandbox.denyRead 에 토큰 파일');
    assert.ok(credFiles.includes(token), 'sandbox.credentials 에 토큰 파일');

    // ⑤ 실행 디렉터리는 additionalDirectories 로 열려 있어야 한다
    assert.deepEqual(settings.permissions.additionalDirectories, [dir.inputDir, dir.outputDir]);

    // ⑥ batonSecretPaths: 기본 홈과 BATON_HOME 둘 다 파일 단위로 막는다
    const secrets = batonSecretPaths(home);
    assert.ok(secrets.includes(path.join(batonHome, 'device-token')));
    assert.ok(secrets.includes(path.join(home, '.baton', 'device-token')));
    assert.ok(!secrets.includes(batonHome), '디렉터리 자체는 목록에 없어야 한다');
    assert.ok(credentialPaths(home).includes(path.join(batonHome, 'device-token')));
  });
});

test('빈 result.md 는 결과 없음으로 보고 최종 응답으로 대체한다', () => {
  const home = tmpDir('empty-result-home');
  const project = tmpDir('empty-result-proj');
  const dir = makeExecDir('exec-empty', home);
  // 차단된 `cat > result.md` 가 0바이트 파일만 남기고 끝나는 상황
  fs.writeFileSync(dir.resultMdPath, '');
  const collected = collectAll(dir, project, [], null, '덧셈 오류를 고쳤습니다.');
  assert.ok(collected.resultMd, '빈 파일 때문에 요약이 통째로 비면 안 된다');
  assert.ok(collected.resultMd!.includes('덧셈 오류를 고쳤습니다.'));
  assert.ok(collected.resultMd!.includes('## 요약'));

  // 공백만 있는 경우도 같다
  fs.writeFileSync(dir.resultMdPath, '\n \n');
  assert.ok(collectAll(dir, project, [], null, '두 번째 응답').resultMd!.includes('두 번째 응답'));

  // 내용이 있으면 그대로 쓴다
  fs.writeFileSync(dir.resultMdPath, '## 요약\n에이전트가 쓴 결과\n');
  assert.equal(collectAll(dir, project, [], null, '쓰이면 안 되는 폴백').resultMd, '## 요약\n에이전트가 쓴 결과\n');

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});
