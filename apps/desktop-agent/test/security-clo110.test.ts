import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ApiClient, ApiError } from '../src/transport/api-client';
import { buildClaudeSettings, buildHookPolicy, credentialPaths } from '../src/adapter/claude-code/policy';
import { decidePreToolUse } from '../src/adapter/claude-code/hook';
import { makeExecDir } from '../src/adapter/claude-code/exec-dir';
import { buildChildEnv } from '../src/adapter/env-whitelist';
import { PolicySchema } from '../src/transport/events';
import { tmpDir } from './helpers';

test('H-5: 첨부 다운로드 시 sha256 불일치 검증 실패 및 파일 미생성', async () => {
  const fileContent = 'safe content for testing integrity';
  const expectedSha256 = createHash('sha256').update(fileContent).digest('hex');
  const wrongSha256 = '0000000000000000000000000000000000000000000000000000000000000000';

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(fileContent);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const api = new ApiClient(baseUrl, 'test-token');

  const testDir = tmpDir('h5-test');
  const destSuccess = path.join(testDir, 'success.txt');
  const destFailure = path.join(testDir, 'failure.txt');

  try {
    // 1. 정상 sha256: 성공적으로 다운로드되고 파일이 작성됨
    await api.download('/test-file', destSuccess, expectedSha256);
    assert.ok(fs.existsSync(destSuccess));
    assert.equal(fs.readFileSync(destSuccess, 'utf8'), fileContent);

    // 2. 불일치 sha256: 예외 발생(ApiError 400) 및 파일이 디스크에 생성되지 않음
    await assert.rejects(
      async () => {
        await api.download('/test-file', destFailure, wrongSha256);
      },
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 400);
        assert.ok(err.message.includes('무결성 검증 실패') || err.message.includes('sha256 불일치'));
        return true;
      }
    );
    assert.ok(!fs.existsSync(destFailure), '변조된 파일은 디스크에 기록되지 않아야 함');
  } finally {
    server.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('H-3-1: credentialPaths에 Baton 디바이스 토큰 경로 포함 및 읽기 차단', () => {
  const customHome = tmpDir('custom-home');
  const originalBatonHome = process.env.BATON_HOME;
  try {
    // 1. 기본 homedir 기준 확인.
    //    막는 단위는 **디렉터리가 아니라 파일**이다 — 실행 디렉터리(<home>/executions/…)가 Baton 홈 안에
    //    있어서 디렉터리째 막으면 첨부 읽기·result.md 쓰기까지 같이 막힌다(2026-09-14 회귀).
    delete process.env.BATON_HOME;
    const defaultPaths = credentialPaths(customHome);
    assert.ok(defaultPaths.includes(path.join(customHome, '.baton', 'device-token')), '기본 .baton/device-token 이 포함되어야 함');
    assert.ok(!defaultPaths.includes(path.join(customHome, '.baton')), 'Baton 홈 디렉터리 자체는 막지 않는다');

    // 2. BATON_HOME 환경변수 설정 시 확인
    const envBatonHome = path.join(customHome, 'env-baton');
    process.env.BATON_HOME = envBatonHome;
    const envPaths = credentialPaths(customHome);
    assert.ok(envPaths.includes(path.join(envBatonHome, 'device-token')), 'BATON_HOME/device-token 이 포함되어야 함');
    assert.ok(envPaths.includes(path.join(customHome, '.baton', 'device-token')), '기본 홈의 토큰도 함께 포함되어야 함');
    assert.ok(!envPaths.includes(envBatonHome), 'BATON_HOME 디렉터리 자체는 막지 않는다');

    // 3. PreToolUse hook에서 Baton 디바이스 토큰 읽기 차단 확인
    const execDir = makeExecDir('h3-exec', customHome);
    const policy = PolicySchema.parse({ repository_edit: 'allow', deployment_apply: 'deny' });
    const hookPolicy = buildHookPolicy(policy, execDir, customHome);

    const tokenPath = path.join(envBatonHome, 'device-token');
    const decision = decidePreToolUse(hookPolicy, {
      tool_name: 'Read',
      tool_input: { file_path: tokenPath },
      cwd: customHome
    });
    assert.equal(decision.decision, 'deny');
    assert.ok(decision.reason?.includes('자격증명 경로 읽기 금지'));

    // 4. Claude settings에 Read(//...) 및 filesystem.denyRead 포함 확인 (파일 단위)
    const tokenFile = path.join(envBatonHome, 'device-token');
    const settings = buildClaudeSettings(policy, execDir, { node: 'node', cli: 'cli.js' }, customHome) as any;
    assert.ok(settings.permissions.deny.some((p: string) => p.includes(tokenFile)));
    assert.ok(settings.sandbox.filesystem.denyRead.includes(tokenFile));
    assert.ok(settings.sandbox.credentials.files.some((f: any) => f.path === tokenFile && f.mode === 'deny'));
    assert.ok(!settings.sandbox.filesystem.denyRead.includes(envBatonHome), '홈 디렉터리째 막으면 실행 디렉터리가 같이 막힌다');
  } finally {
    if (originalBatonHome !== undefined) process.env.BATON_HOME = originalBatonHome;
    else delete process.env.BATON_HOME;
    fs.rmSync(customHome, { recursive: true, force: true });
  }
});

test('L-1: 데몬이 다른 origin 요청 시 Authorization 헤더를 누출하지 않음', async () => {
  let server1Headers: http.IncomingHttpHeaders | null = null;
  let server2Headers: http.IncomingHttpHeaders | null = null;

  const server1 = http.createServer((req, res) => {
    server1Headers = req.headers;
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end('server1 content');
  });
  const server2 = http.createServer((req, res) => {
    server2Headers = req.headers;
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end('server2 content');
  });

  await new Promise<void>((resolve) => server1.listen(0, '127.0.0.1', () => resolve()));
  await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', () => resolve()));

  const port1 = (server1.address() as any).port;
  const port2 = (server2.address() as any).port;

  const baseUrl1 = `http://127.0.0.1:${port1}`;
  const baseUrl2 = `http://127.0.0.1:${port2}`;

  const token = 'secret-device-token-12345';
  const api = new ApiClient(baseUrl1, token);

  const testDir = tmpDir('l1-test');
  const dest1 = path.join(testDir, 'out1.txt');
  const dest2 = path.join(testDir, 'out2.txt');

  try {
    // 1. Same origin download: Authorization 헤더 전송 확인
    await api.download('/download-1', dest1);
    assert.equal(server1Headers?.authorization, `Bearer ${token}`);

    // 2. Different origin download: Authorization 헤더 미전송 확인
    await api.download(`${baseUrl2}/download-2`, dest2);
    assert.equal(server2Headers?.authorization, undefined, '다른 origin에는 디바이스 토큰이 전송되지 않아야 함');

    // 3. isSameOrigin 단위 검증
    assert.ok(api.isSameOrigin('/relative/path'));
    assert.ok(api.isSameOrigin(`${baseUrl1}/path`));
    assert.ok(!api.isSameOrigin(`${baseUrl2}/path`));
    assert.ok(!api.isSameOrigin('https://s3.amazonaws.com/bucket/file'));
  } finally {
    server1.close();
    server2.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('M-4: 자식 프로세스 환경변수 엄격한 화이트리스트 필터링 검증', () => {
  const dirtyHostEnv: NodeJS.ProcessEnv = {
    // 호스트의 민감한 시크릿들 (자식으로 새어나가지 않아야 함)
    AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    AWS_SESSION_TOKEN: 'token-val',
    GITHUB_TOKEN: 'ghp_secretToken1234567890',
    GH_TOKEN: 'ghp_secretToken2',
    KUBECONFIG: '/Users/host/.kube/config',
    UNKNOWN_HOST_SECRET: 'very-confidential',
    NODE_TEST_CONTEXT: 'test-runner-context',

    // 공통 허용 변수들
    PATH: '/usr/bin:/bin',
    HOME: '/Users/testuser',
    USER: 'testuser',
    LOGNAME: 'testuser',
    SHELL: '/bin/zsh',
    TMPDIR: '/tmp/testuser',
    LANG: 'ko_KR.UTF-8',
    TERM: 'xterm-256color',

    // 어댑터별 변수들
    ANTHROPIC_API_KEY: 'sk-ant-anthropic-key',
    OPENAI_API_KEY: 'sk-openai-key',
    GEMINI_API_KEY: 'gemini-key',
    GOOGLE_API_KEY: 'google-key',
    CODEX_HOME: '/custom/codex/home',
    AGY_HOME: '/custom/agy/home',

    // Baton 전용 변수 및 테스트 변수
    BATON_HOME: '/Users/testuser/.baton',
    BATON_CODEX_PATH: '/custom/bin/codex',
    FAKE_CODEX_PORT: '8080',
  };

  // 1. Claude Code 어댑터 환경변수 검증
  const claudeEnv = buildChildEnv('claude-code', dirtyHostEnv);
  assert.equal(claudeEnv.AWS_ACCESS_KEY_ID, undefined, 'AWS 시크릿은 제외되어야 함');
  assert.equal(claudeEnv.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(claudeEnv.GITHUB_TOKEN, undefined, 'GITHUB 토큰은 제외되어야 함');
  assert.equal(claudeEnv.KUBECONFIG, undefined, 'KUBECONFIG는 제외되어야 함');
  assert.equal(claudeEnv.UNKNOWN_HOST_SECRET, undefined);
  assert.equal(claudeEnv.NODE_TEST_CONTEXT, undefined, 'NODE_TEST_CONTEXT는 제외되어야 함');
  assert.equal(claudeEnv.OPENAI_API_KEY, undefined, 'Claude Code에는 OpenAI 키가 들어가지 않아야 함');
  assert.equal(claudeEnv.GEMINI_API_KEY, undefined, 'Claude Code에는 Gemini 키가 들어가지 않아야 함');
  assert.equal(claudeEnv.ANTHROPIC_API_KEY, 'sk-ant-anthropic-key', '자체 인증 변수는 보존되어야 함');
  assert.equal(claudeEnv.HOME, '/Users/testuser');
  assert.equal(claudeEnv.BATON_HOME, '/Users/testuser/.baton');
  assert.equal(claudeEnv.FAKE_CODEX_PORT, '8080');
  assert.ok(claudeEnv.PATH?.includes('/opt/homebrew/bin'), '기본 PATH가 보장되어야 함');

  // 2. Codex 어댑터 환경변수 검증
  const codexEnv = buildChildEnv('codex', dirtyHostEnv);
  assert.equal(codexEnv.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(codexEnv.GITHUB_TOKEN, undefined);
  assert.equal(codexEnv.ANTHROPIC_API_KEY, undefined, 'Codex에는 Anthropic 키가 들어가지 않아야 함');
  assert.equal(codexEnv.GEMINI_API_KEY, undefined, 'Codex에는 Gemini 키가 들어가지 않아야 함');
  assert.equal(codexEnv.OPENAI_API_KEY, 'sk-openai-key', 'Codex 자체 API 키는 보존되어야 함');
  assert.equal(codexEnv.CODEX_HOME, '/custom/codex/home');
  assert.equal(codexEnv.BATON_CODEX_PATH, '/custom/bin/codex');

  // 3. Antigravity 어댑터 환경변수 검증
  const agyEnv = buildChildEnv('agy', dirtyHostEnv);
  assert.equal(agyEnv.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(agyEnv.GITHUB_TOKEN, undefined);
  assert.equal(agyEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(agyEnv.OPENAI_API_KEY, undefined);
  assert.equal(agyEnv.GEMINI_API_KEY, 'gemini-key');
  assert.equal(agyEnv.GOOGLE_API_KEY, 'google-key');
  assert.equal(agyEnv.AGY_HOME, '/custom/agy/home');
});

test('L-2: PreToolUse hook matcher 및 decidePreToolUse에서 Grep·Glob 자격증명 차단 검증', () => {
  const customHome = tmpDir('l2-home');
  const projectRoot = tmpDir('l2-project');
  const execDir = makeExecDir('l2-exec', customHome);
  const policy = PolicySchema.parse({ repository_edit: 'allow', deployment_apply: 'deny' });
  const hookPolicy = buildHookPolicy(policy, execDir, projectRoot, customHome);

  try {
    // 1. buildClaudeSettings 에서 PreToolUse matcher에 Grep 및 Glob 포함 확인
    const settings = buildClaudeSettings(policy, execDir, { node: 'node', cli: 'cli.js' }, customHome) as any;
    const pretoolMatcher = settings.hooks.PreToolUse[0]?.matcher;
    assert.ok(pretoolMatcher, 'PreToolUse hook matcher가 존재해야 함');
    assert.ok(pretoolMatcher.includes('Grep'), 'matcher에 Grep이 포함되어야 함');
    assert.ok(pretoolMatcher.includes('Glob'), 'matcher에 Glob이 포함되어야 함');

    // 2. sandbox.filesystem.denyRead 에 자격증명 경로 전체(kube, docker, netrc 등) 포함 확인
    const denyReadList = settings.sandbox.filesystem.denyRead as string[];
    assert.ok(denyReadList.some((p) => p.includes('.kube')), 'denyRead에 kube 경로 포함');
    assert.ok(denyReadList.some((p) => p.includes('.docker')), 'denyRead에 docker 경로 포함');
    assert.ok(denyReadList.some((p) => p.includes('.netrc')), 'denyRead에 netrc 경로 포함');
    assert.ok(denyReadList.some((p) => p.includes('.ssh')), 'denyRead에 ssh 경로 포함');
    assert.ok(denyReadList.some((p) => p.includes('.aws')), 'denyRead에 aws 경로 포함');

    // 3. decidePreToolUse: Grep 도구로 자격증명 파일 조회 시 deny 차단 확인
    const targets = [
      path.join(customHome, '.kube', 'config'),
      path.join(customHome, '.aws', 'credentials'),
      path.join(customHome, '.netrc'),
      path.join(customHome, '.docker', 'config.json'),
      path.join(customHome, '.baton', 'device-token'),
      path.join(customHome, '.ssh', 'id_rsa'),
    ];

    for (const target of targets) {
      const grepDecision = decidePreToolUse(hookPolicy, {
        tool_name: 'Grep',
        tool_input: { path: target, pattern: 'secret' },
        cwd: projectRoot,
      });
      assert.equal(grepDecision.decision, 'deny', `Grep on ${target} must be denied`);
      assert.ok(grepDecision.reason?.includes('자격증명 경로 읽기 금지'));
    }

    // Baton 홈은 목록에서 뺀다 — 실행 디렉터리(<home>/executions/…)가 그 안에 있어서
    // 디렉터리째 막으면 에이전트가 자기 첨부·결과 경로를 다루지 못한다. 토큰 **파일** 읽기는 위에서 막았다.
    const credDirs = [
      path.join(customHome, '.kube'),
      path.join(customHome, '.aws'),
      path.join(customHome, '.docker'),
      path.join(customHome, '.ssh'),
    ];
    for (const dir of credDirs) {
      const globDecision = decidePreToolUse(hookPolicy, {
        tool_name: 'Glob',
        tool_input: { path: dir },
        cwd: projectRoot,
      });
      assert.equal(globDecision.decision, 'deny', `Glob on ${dir} must be denied`);
      assert.ok(globDecision.reason?.includes('자격증명 경로 읽기 금지'));
    }

    // 4. Glob 도구에서 pattern 인자로 자격증명 절대 경로 조회 시 deny 차단 확인
    const globPatternDecision = decidePreToolUse(hookPolicy, {
      tool_name: 'Glob',
      tool_input: { pattern: path.join(customHome, '.aws', '*') },
      cwd: projectRoot,
    });
    assert.equal(globPatternDecision.decision, 'deny', 'Glob with pattern on .aws/* must be denied');

    // 5. 정상 프로젝트 파일에 대한 Grep 및 Glob 은 pass 통과 확인
    const safeGrep = decidePreToolUse(hookPolicy, {
      tool_name: 'Grep',
      tool_input: { path: path.join(projectRoot, 'src', 'index.ts'), pattern: 'test' },
      cwd: projectRoot,
    });
    assert.equal(safeGrep.decision, 'pass', 'Safe file Grep must pass');

    const safeGlob = decidePreToolUse(hookPolicy, {
      tool_name: 'Glob',
      tool_input: { path: projectRoot },
      cwd: projectRoot,
    });
    assert.equal(safeGlob.decision, 'pass', 'Safe directory Glob must pass');
  } finally {
    fs.rmSync(customHome, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

