/**
 * Baton 자체 Diff 파서 및 버전 비교 유틸리티
 * 외부 라이브러리 없이 자체 구현된 Unified Diff 파서 및 LCS 기반 줄 단위 diff
 */

export interface DiffLineItem {
  type: 'add' | 'delete' | 'hunk' | 'context' | 'header';
  text: string;
  prefix: '+' | '-' | '@' | ' ';
  oldLineNo?: number;
  newLineNo?: number;
}

export interface ParsedDiffFile {
  filename: string;
  oldFilename?: string;
  newFilename?: string;
  additions: number;
  deletions: number;
  hunks: number;
  lines: DiffLineItem[];
}

/**
 * Unified Diff 텍스트를 파일 단위로 파싱
 */
export function parseUnifiedDiff(diffText: string, defaultFilename = 'changes.patch'): ParsedDiffFile[] {
  if (!diffText || !diffText.trim()) {
    return [];
  }

  const rawLines = diffText.split('\n');
  const files: ParsedDiffFile[] = [];
  let activeFile: ParsedDiffFile = {
    filename: defaultFilename,
    additions: 0,
    deletions: 0,
    hunks: 0,
    lines: []
  };
  let hasFileContent = false;
  let currentOldLine = 0;
  let currentNewLine = 0;

  const pushActiveFile = () => {
    if (hasFileContent || activeFile.lines.length > 0) {
      files.push(activeFile);
    }
  };

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];

    // diff --git a/path b/path
    const gitMatch = line.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (gitMatch) {
      pushActiveFile();
      activeFile = {
        filename: (gitMatch[2] || gitMatch[1]).replace(/^[ab]\//, '').trim() || defaultFilename,
        additions: 0,
        deletions: 0,
        hunks: 0,
        lines: [{ type: 'header', text: line, prefix: ' ' }]
      };
      hasFileContent = true;
      currentOldLine = 0;
      currentNewLine = 0;
      continue;
    }

    // --- a/path 또는 --- path
    if (line.startsWith('--- ')) {
      const oldPath = line.substring(4).replace(/^[ab]\//, '').trim();
      activeFile.oldFilename = oldPath;
      activeFile.lines.push({ type: 'header', text: line, prefix: ' ' });
      hasFileContent = true;
      continue;
    }

    // +++ b/path 또는 +++ path
    if (line.startsWith('+++ ')) {
      const newPath = line.substring(4).replace(/^[ab]\//, '').trim();
      activeFile.newFilename = newPath;
      if (newPath && newPath !== '/dev/null') {
        activeFile.filename = newPath;
      }
      activeFile.lines.push({ type: 'header', text: line, prefix: ' ' });
      hasFileContent = true;
      continue;
    }

    // Hunk 헤더: @@ -start,len +start,len @@
    if (line.startsWith('@@')) {
      activeFile.hunks++;
      const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        currentOldLine = parseInt(hunkMatch[1], 10);
        currentNewLine = parseInt(hunkMatch[2], 10);
      }
      activeFile.lines.push({ type: 'hunk', text: line, prefix: '@' });
      hasFileContent = true;
      continue;
    }

    // 추가된 라인
    if (line.startsWith('+')) {
      activeFile.additions++;
      activeFile.lines.push({
        type: 'add',
        text: line.substring(1),
        prefix: '+',
        newLineNo: currentNewLine > 0 ? currentNewLine++ : undefined
      });
      hasFileContent = true;
      continue;
    }

    // 삭제된 라인
    if (line.startsWith('-')) {
      activeFile.deletions++;
      activeFile.lines.push({
        type: 'delete',
        text: line.substring(1),
        prefix: '-',
        oldLineNo: currentOldLine > 0 ? currentOldLine++ : undefined
      });
      hasFileContent = true;
      continue;
    }

    // 기타 컨텍스트 라인
    activeFile.lines.push({
      type: 'context',
      text: line.startsWith(' ') ? line.substring(1) : line,
      prefix: ' ',
      oldLineNo: currentOldLine > 0 ? currentOldLine++ : undefined,
      newLineNo: currentNewLine > 0 ? currentNewLine++ : undefined
    });
    hasFileContent = true;
  }

  pushActiveFile();

  return files.length > 0 ? files : [{
    filename: defaultFilename,
    additions: 0,
    deletions: 0,
    hunks: 0,
    lines: rawLines.map((l) => ({ type: 'context', text: l, prefix: ' ' }))
  }];
}

export interface LineDiffItem {
  type: 'equal' | 'add' | 'delete';
  value: string;
  oldLineNo?: number;
  newLineNo?: number;
}

export interface SideBySideRow {
  left?: {
    lineNo?: number;
    text: string;
    type: 'equal' | 'delete' | 'empty';
  };
  right?: {
    lineNo?: number;
    text: string;
    type: 'equal' | 'add' | 'empty';
  };
}

export interface DocumentDiffResult {
  unified: LineDiffItem[];
  sideBySide: SideBySideRow[];
  stats: {
    additions: number;
    deletions: number;
    unchanged: number;
  };
}

/**
 * 두 텍스트(Markdown 문서 등)의 줄 단위 diff 계산 (LCS 알고리즘)
 */
export function computeDocumentDiff(oldText: string, newText: string): DocumentDiffResult {
  const oldLines = oldText ? oldText.split('\n') : [];
  const newLines = newText ? newText.split('\n') : [];

  const M = oldLines.length;
  const N = newLines.length;

  // DP table for LCS
  const dp: number[][] = Array.from({ length: M + 1 }, () => new Array(N + 1).fill(0));
  for (let i = 1; i <= M; i++) {
    for (let j = 1; j <= N; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack
  let i = M;
  let j = N;
  const rawDiff: LineDiffItem[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      rawDiff.push({ type: 'equal', value: oldLines[i - 1], oldLineNo: i, newLineNo: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      rawDiff.push({ type: 'add', value: newLines[j - 1], newLineNo: j });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      rawDiff.push({ type: 'delete', value: oldLines[i - 1], oldLineNo: i });
      i--;
    }
  }

  const unified = rawDiff.reverse();

  let additions = 0;
  let deletions = 0;
  let unchanged = 0;

  unified.forEach((d) => {
    if (d.type === 'add') additions++;
    else if (d.type === 'delete') deletions++;
    else unchanged++;
  });

  // 좌우 비교(Side-by-Side) 테이블 구성
  const sideBySide: SideBySideRow[] = [];
  let uIndex = 0;

  while (uIndex < unified.length) {
    const item = unified[uIndex];

    if (item.type === 'equal') {
      sideBySide.push({
        left: { lineNo: item.oldLineNo, text: item.value, type: 'equal' },
        right: { lineNo: item.newLineNo, text: item.value, type: 'equal' }
      });
      uIndex++;
    } else {
      // 인접한 delete와 add 묶음 수집
      const delGroup: LineDiffItem[] = [];
      const addGroup: LineDiffItem[] = [];

      while (uIndex < unified.length && unified[uIndex].type !== 'equal') {
        if (unified[uIndex].type === 'delete') {
          delGroup.push(unified[uIndex]);
        } else if (unified[uIndex].type === 'add') {
          addGroup.push(unified[uIndex]);
        }
        uIndex++;
      }

      const maxLen = Math.max(delGroup.length, addGroup.length);
      for (let k = 0; k < maxLen; k++) {
        const delItem = delGroup[k];
        const addItem = addGroup[k];

        sideBySide.push({
          left: delItem
            ? { lineNo: delItem.oldLineNo, text: delItem.value, type: 'delete' }
            : { text: '', type: 'empty' },
          right: addItem
            ? { lineNo: addItem.newLineNo, text: addItem.value, type: 'add' }
            : { text: '', type: 'empty' }
        });
      }
    }
  }

  return {
    unified,
    sideBySide,
    stats: {
      additions,
      deletions,
      unchanged
    }
  };
}
