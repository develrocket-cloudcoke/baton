import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { gitBaseline, gitCollect } from '../src/adapter/claude-code/collector';
import { makeProject, tmpDir } from './helpers';

// 2026-09-23 Linux CI 에서 fake-claude 의 같은 크기 편집(`a - b`→`a + b`)이 changedFiles=[] 로 수집됐다.
// 스냅샷용 인덱스 사본의 mtime 이 새로 찍혀 git 의 racy-git 재해시 기준이 밀린 탓이다.
// 파일시스템 시간 정밀도에 기대지 않도록, "인덱스와 같은 초에 같은 크기로 고친 파일"을 시각을 고정해 만든다.
test('스냅샷은 인덱스와 같은 초에 같은 크기로 고친 파일도 수집하고 사용자 인덱스를 보존한다', () => {
  const root = makeProject(tmpDir('collector'));
  const home = tmpDir('collector-index');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  try {
    git('config', 'core.trustctime', 'false');
    git('config', 'core.checkStat', 'minimal');
    const file = path.join(root, 'src/add.js');
    const indexPath = path.join(root, '.git/index');
    const t = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(file, t, t);
    git('add', '-A');
    const index = path.join(home, 'index');
    const baseline = gitBaseline(root, index); // 안의 git status 가 사용자 인덱스를 다시 쓸 수 있다
    // 그 뒤 "인덱스가 쓰인 초와 같은 초에 에이전트가 고친" 상황을 만든다. git 은 이 항목을 racy 로 보고
    // 다시 해시하므로 git status 로는 보인다. 스냅샷도 같은 판단을 해야 한다.
    fs.utimesSync(indexPath, t, t);
    const userIndex = fs.readFileSync(indexPath);

    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('a - b', 'a + b'));
    fs.utimesSync(file, t, t); // 크기·mtime 모두 캐시와 같다
    fs.writeFileSync(path.join(root, 'new.txt'), 'new\n');
    fs.unlinkSync(path.join(root, 'README.md'));
    const result = gitCollect(root, baseline, index)!;

    assert.deepEqual(result.changed.map((c) => c.path).sort(), ['README.md', 'new.txt', 'src/add.js']);
    assert.ok(result.patch.includes('+  return a + b;'));
    assert.deepEqual(fs.readFileSync(indexPath), userIndex, '사용자 인덱스는 바이트 단위로 그대로');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
