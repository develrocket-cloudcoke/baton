import assert from 'node:assert/strict';
import test from 'node:test';
import { gitPreflight } from '../src/adapter/common/git-preflight';

test('git 실행 파일 없음과 macOS 개발 도구 shim 실패를 코드로 보고한다', () => {
  for (const result of [{ status: null, error: new Error('ENOENT') }, { status: 1, stderr: 'xcode-select: error' }]) {
    assert.equal(gitPreflight('/project', () => result)?.code, 'git_missing');
  }
});

test('git이 실행되지만 저장소가 아닌 폴더는 project_not_git이다', () => {
  const seen: string[][] = [];
  const result = gitPreflight('/project', (args) => {
    seen.push(args);
    return args[0] === '--version'
      ? { status: 0, stdout: 'git version 2.0' }
      : { status: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' };
  });
  assert.equal(result?.code, 'project_not_git');
  assert.deepEqual(seen, [['--version'], ['rev-parse', '--is-inside-work-tree']]);
});

test('정상 저장소는 통과하고 권한 오류를 비 Git으로 오인하지 않는다', () => {
  for (const result of [{ status: 0, stdout: 'true\n' }, { status: 128, stderr: 'permission denied' }, { status: null, error: new Error('timeout') }]) {
    assert.equal(gitPreflight('/project', (args) => args[0] === '--version' ? { status: 0 } : result), null);
  }
});
