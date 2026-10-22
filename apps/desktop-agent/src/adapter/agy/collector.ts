import { collectAll, GitBaseline } from '../claude-code/collector';
import type { ExecDir } from '../claude-code/exec-dir';

// Antigravity는 도구 호출 단위에서 unified patch를 직접 주지 않는다.
// 계층1(스트림 패치)을 비우고 공통 계층2(Git 작업 트리 스냅샷 비교) 및 계층3(결과 마크다운 파일) 수집을 사용한다.
export function collectAgy(
  dir: ExecDir,
  projectRoot: string,
  baseline: GitBaseline | null,
  finalText: string | null
) {
  return collectAll(dir, projectRoot, [], baseline, finalText);
}
