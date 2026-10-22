import { spawnSync } from 'node:child_process';

export type GitFailureCode = 'git_missing' | 'project_not_git';
type Probe = (args: string[]) => { status: number | null; stdout?: string; stderr?: string; error?: unknown };

// --version도 실행해 macOS 개발 도구 shim 실패와 비 Git 폴더를 구분한다.
export function gitPreflight(projectRoot: string, probe: Probe = (args) =>
  spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8', timeout: 5_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } })
): { code: GitFailureCode; reason: string } | null {
  const version = probe(['--version']);
  if (version.error || version.status !== 0) {
    return { code: 'git_missing', reason: 'git을 실행할 수 없습니다. Mac 터미널에서 xcode-select --install로 개발 도구를 설치해 주세요.' };
  }
  const repo = probe(['rev-parse', '--is-inside-work-tree']);
  if (repo.status === 0 && repo.stdout?.trim() === 'true') return null;
  // 권한·손상·시간 초과는 비 Git으로 단정하지 않고 기존 스냅샷 실패로 남긴다.
  if (!repo.error && (repo.stdout?.trim() === 'false' || /not a git repository/i.test(repo.stderr ?? ''))) {
    return { code: 'project_not_git', reason: '이 프로젝트 폴더는 git 저장소가 아니라 Codex·Antigravity로 실행할 수 없습니다.' };
  }
  return null;
}
