import { collectAll, GitBaseline } from '../claude-code/collector';
import type { ExecDir } from '../claude-code/exec-dir';

// Codex file_change는 unified patch를 주지 않는다. 계층1을 비우고 기존 계층2 스냅샷/계층3 파일 수집을 재사용한다.
export function collectCodex(dir: ExecDir, projectRoot: string, baseline: GitBaseline | null, finalText: string | null) {
  return collectAll(dir, projectRoot, [], baseline, finalText);
}
