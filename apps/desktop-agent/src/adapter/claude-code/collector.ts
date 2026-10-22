import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ExecDir } from './exec-dir';
import { scanSecrets, SecretFinding } from '../common/secret-scan';

// 02 §5 결과 3계층: (1) stream 의 structuredPatch (2) git diff (3) result.md
type Json = Record<string, unknown>;

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface Layer1Result {
  files: string[];
  patch: string;
}

export interface GitBaseline {
  head: string | null;
  dirty: string[];
  // 이번 회차 시작 시점의 워킹트리 스냅샷 tree (임시 인덱스로 만든다). §18 추가 작업처럼 같은 프로젝트에서
  // 여러 회차를 이어 실행할 때 `git diff HEAD` 를 쓰면 이전 회차 변경까지 다시 잡히므로 이 tree 를 기준으로 쓴다.
  tree: string | null;
}

export interface Layer2Result {
  changed: { status: string; path: string }[];
  patch: string;
  preexistingDirty: string[];
}

function toUnifiedDiff(filePath: string, hunks: Hunk[], projectRoot: string): string {
  const rel = path.relative(projectRoot, filePath);
  let s = `--- a/${rel}\n+++ b/${rel}\n`;
  for (const h of hunks) s += `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}\n`;
  return s;
}

// 계층1. 프로젝트 루트 안의 파일만 patch 에 넣는다 (output/result.md 는 제외, 02 §5.1 보정)
export function collectFromStream(events: Json[], projectRoot: string): Layer1Result {
  const files = new Map<string, { hunks: Hunk[]; created?: string }>();
  for (const ev of events) {
    if (ev.type !== 'user' || ev.parent_tool_use_id != null) continue;
    const r = ev.tool_use_result as Json | undefined;
    if (!r || typeof r !== 'object') continue;
    const fp = r.filePath as string | undefined;
    if (!fp || !(fp === projectRoot || fp.startsWith(projectRoot + path.sep))) continue;
    if (Array.isArray(r.structuredPatch) && r.structuredPatch.length) {
      const f = files.get(fp) ?? { hunks: [] };
      f.hunks.push(...(r.structuredPatch as Hunk[]));
      files.set(fp, f);
    } else if (r.type === 'create') {
      const f = files.get(fp) ?? { hunks: [] };
      f.created = String(r.content ?? '');
      files.set(fp, f);
    }
  }
  let patch = '';
  for (const [fp, f] of files) {
    if (f.hunks.length) patch += toUnifiedDiff(fp, f.hunks, projectRoot);
    else if (f.created !== undefined) {
      const lines = f.created.split('\n');
      patch += `--- /dev/null\n+++ b/${path.relative(projectRoot, fp)}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => '+' + l).join('\n')}\n`;
    }
  }
  return { files: [...files.keys()], patch };
}

function git(projectRoot: string, args: string[], env?: NodeJS.ProcessEnv): { ok: boolean; out: string } {
  const r = spawnSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8', env });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

// 워킹트리(추적 파일 + untracked, .gitignore 는 제외)를 tree object 하나로 스냅샷한다.
// 사용자의 인덱스를 절대 건드리지 않도록 인덱스 사본을 GIT_INDEX_FILE 로 쓴다(사본이 없으면 빈 인덱스에서 시작).
// 커밋은 만들지 않고 blob/tree 만 쓰므로 참조되지 않은 객체로 남았다가 git gc 때 정리된다.
export function snapshotTree(projectRoot: string, indexFile: string): string | null {
  try {
    fs.rmSync(indexFile, { force: true });
    const rel = git(projectRoot, ['rev-parse', '--git-path', 'index']).out.trim();
    if (rel) {
      const abs = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
      if (fs.existsSync(abs)) {
        fs.copyFileSync(abs, indexFile);
        // 사본의 mtime 을 원본과 같게 둔다. git 은 "인덱스와 같은 초에 수정된 항목"을 stat 이 같아도
        // 다시 해시하는데(racy-git), 그 기준이 인덱스 파일의 mtime 이다. 복사로 mtime 이 새로 찍히면
        // 기준이 뒤로 밀려, 같은 초에 같은 크기로 고친 파일(`a - b`→`a + b`)을 기존 blob 으로 수집했다
        // (2026-09-23 Linux CI 에서 changedFiles=[]). 소수점 아래는 내림 — 기준이 이르면 더 많이 해시할 뿐 안전하다.
        const st = fs.statSync(abs);
        fs.utimesSync(indexFile, Math.floor(st.atimeMs) / 1000, Math.floor(st.mtimeMs) / 1000);
      }
    }
    const env = { ...process.env, GIT_INDEX_FILE: indexFile };
    if (!git(projectRoot, ['add', '-A'], env).ok) return null;
    const tree = git(projectRoot, ['write-tree'], env);
    return tree.ok ? tree.out.trim() || null : null;
  } catch {
    return null;
  }
}

// `git diff --name-status -z` 파싱. 이름 변경(R/C)은 경로가 2개 오므로 새 경로를 쓴다.
function parseNameStatus(out: string): { status: string; path: string }[] {
  const parts = out.split('\0').filter((x) => x !== '');
  const changed: { status: string; path: string }[] = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    const from = parts[i++];
    const to = /^[RC]/.test(status) ? parts[i++] : undefined;
    if (from === undefined) break;
    changed.push({ status, path: to ?? from });
  }
  return changed;
}

// 계층2 baseline (실행 전). git 이 아니면 null. indexFile 을 주면 이번 회차 기준 tree 도 함께 남긴다.
export function gitBaseline(projectRoot: string, indexFile?: string): GitBaseline | null {
  if (!git(projectRoot, ['rev-parse', '--is-inside-work-tree']).ok) return null;
  const head = git(projectRoot, ['rev-parse', 'HEAD']);
  return {
    head: head.ok ? head.out.trim() || null : null,
    dirty: git(projectRoot, ['status', '--porcelain=v1', '-z']).out.split('\0').filter(Boolean),
    tree: indexFile ? snapshotTree(projectRoot, indexFile) : null
  };
}

// 계층2 수집 (실행 후).
// (1) baseline.tree 가 있으면 실행 후 워킹트리를 한 번 더 스냅샷해 두 tree 의 diff 를 쓴다 → **이번 회차 변경만** 잡힌다.
// (2) tree 를 못 만든 저장소(권한·손상 등)에서는 예전 방식으로 떨어진다: add -N → diff HEAD → reset 으로 사용자 인덱스를 원상 복구.
export function gitCollect(projectRoot: string, baseline: GitBaseline | null, indexFile?: string): Layer2Result | null {
  if (!baseline) return null;
  if (baseline.tree && indexFile) {
    const after = snapshotTree(projectRoot, indexFile);
    if (after) {
      const changed = parseNameStatus(git(projectRoot, ['diff', '--name-status', '-z', baseline.tree, after]).out);
      const patch = git(projectRoot, ['diff', '--binary', baseline.tree, after]).out;
      fs.rmSync(indexFile, { force: true });
      return { changed, patch, preexistingDirty: baseline.dirty };
    }
  }
  const now = git(projectRoot, ['status', '--porcelain=v1', '-z']).out.split('\0').filter(Boolean);
  const before = new Set(baseline.dirty);
  const changed = now.filter((l) => !before.has(l)).map((l) => ({ status: l.slice(0, 2), path: l.slice(3) }));
  const untracked = changed.filter((c) => c.status === '??').map((c) => c.path);
  if (untracked.length) git(projectRoot, ['add', '-N', '--', ...untracked]);
  const patch = baseline.head ? git(projectRoot, ['diff', '--binary', 'HEAD']).out : git(projectRoot, ['diff', '--binary']).out;
  if (untracked.length) git(projectRoot, ['reset', '-q', '--', ...untracked]);
  return { changed, patch, preexistingDirty: baseline.dirty };
}

export interface CollectedResult {
  layer1: Layer1Result;
  layer2: Layer2Result | null;
  resultMd: string | null;
  changedFiles: string[];
  patch: string;
  testSummary: string | null;
  // CLO-110 H-4-④: 결과물에 섞여 나가는 시크릿 점검 결과. 비어 있으면 걸린 게 없다는 뜻이다.
  secretFindings: SecretFinding[];
}

export function collectAll(dir: ExecDir, projectRoot: string, events: Json[], baseline: GitBaseline | null, finalText: string | null): CollectedResult {
  const layer1 = collectFromStream(events, projectRoot);
  fs.writeFileSync(dir.streamPatchPath, layer1.patch);
  const layer2 = gitCollect(projectRoot, baseline, dir.gitIndexPath);
  if (layer2) fs.writeFileSync(dir.gitPatchPath, layer2.patch);
  // 계층3: result.md 가 없으면 최종 텍스트로 대체 (02 §5.3)
  let resultMd: string | null = fs.existsSync(dir.resultMdPath) ? fs.readFileSync(dir.resultMdPath, 'utf8') : null;
  // 빈 파일은 "없음"으로 본다. 차단된 `cat > result.md` 가 0바이트 파일만 남기고 끝나는 경우가 있는데,
  // 그때 이 파일을 결과로 인정하면 최종 응답 폴백이 건너뛰어져 요약이 통째로 비어 나간다(2026-09-14 실측).
  if (resultMd !== null && !resultMd.trim()) resultMd = null;
  if (resultMd === null && finalText) {
    resultMd = `## 요약\n\n${finalText}\n\n## 미완료·주의\n\n- Agent 가 result.md 를 작성하지 않아 최종 응답으로 대체함\n`;
    fs.writeFileSync(dir.resultMdPath, resultMd);
  }
  const changedFiles = layer2 ? layer2.changed.map((c) => c.path) : layer1.files.map((f) => path.relative(projectRoot, f));
  const patch = layer2 && layer2.patch.trim() ? layer2.patch : layer1.patch;
  const testSection = resultMd?.match(/## 테스트\s*\n([\s\S]*?)(\n## |$)/);
  // 인젝션을 못 막아도 마지막 홉은 점검한다. 결과를 버리지는 않고 발견 사실만 올려 보낸다.
  const secretFindings = [...scanSecrets(resultMd, 'result.md'), ...scanSecrets(patch, 'patch')];
  return { layer1, layer2, resultMd, changedFiles, patch, testSummary: testSection ? testSection[1].trim().slice(0, 4000) : null, secretFindings };
}
