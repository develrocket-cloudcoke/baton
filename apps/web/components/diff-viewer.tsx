'use client';

import React, { useState, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { parseUnifiedDiff, ParsedDiffFile } from '@/lib/diff-utils';
import {
  FileCode,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Plus,
  Minus,
  Layers,
  FoldVertical,
  UnfoldVertical
} from 'lucide-react';

export const SAMPLE_DIFF = `--- a/deployment.yaml
+++ b/deployment.yaml
@@ -7,5 +7,5 @@
     spec:
       containers:
       - name: api
         image: backend-api:latest
         env:
-        - name: REDIS_HOST
-          value: redis-servcie # ← 오타 주입 (의도된 결함)
+        - name: REDIS_HOST
+          value: redis-service # ← 오타 수정 완료`;

export const SAMPLE_MULTI_FILE_DIFF = `diff --git a/k8s/deployment.yaml b/k8s/deployment.yaml
index 1a2b3c..4d5e6f 100644
--- a/k8s/deployment.yaml
+++ b/k8s/deployment.yaml
@@ -7,5 +7,5 @@
     spec:
       containers:
       - name: api
         image: backend-api:latest
         env:
-        - name: REDIS_HOST
-          value: redis-servcie # ← 오타 주입 (의도된 결함)
+        - name: REDIS_HOST
+          value: redis-service # ← 오타 수정 완료
diff --git a/config/redis.conf b/config/redis.conf
index 9f8e7d..3c2b1a 100644
--- a/config/redis.conf
+++ b/config/redis.conf
@@ -12,4 +12,4 @@
 # Redis network configuration
 bind 127.0.0.1
 port 6379
-timeout 300
+timeout 0`;

export const SAMPLE_FOLLOW_UP_MULTI_FILE_DIFF = `diff --git a/k8s/deployment.yaml b/k8s/deployment.yaml
index 1a2b3c..4d5e6f 100644
--- a/k8s/deployment.yaml
+++ b/k8s/deployment.yaml
@@ -7,5 +7,5 @@
     spec:
       containers:
       - name: api
         image: backend-api:latest
         env:
-        - name: REDIS_HOST
-          value: redis-servcie # ← 오타 주입 (의도된 결함)
+        - name: REDIS_HOST
+          value: redis-service # ← 오타 수정 완료
diff --git a/config/redis.conf b/config/redis.conf
index 9f8e7d..3c2b1a 100644
--- a/config/redis.conf
+++ b/config/redis.conf
@@ -12,4 +12,4 @@
 # Redis network configuration
 bind 127.0.0.1
 port 6379
-timeout 300
+timeout 0
diff --git a/scripts/curl-test.sh b/scripts/curl-test.sh
new file mode 100755
index 000000..7a8b9c
--- /dev/null
+++ b/scripts/curl-test.sh
@@ -0,0 +1,9 @@
+#!/usr/bin/env bash
+set -euo pipefail
+echo "=== [2차 추가 테스트] Redis 및 Auth 엔드포인트 헬스체크 ==="
+echo "[1/2] Checking /healthz endpoint..."
+curl -s -f http://127.0.0.1:3001/healthz | grep -q "ok"
+echo "[2/2] Checking /v1/auth/login endpoint..."
+curl -s -f -X POST http://127.0.0.1:3001/v1/auth/login -H "Content-Type: application/json" -d '{"email":"b@baton.local","password":"pass"}'
+echo "All health checks and auth tests passed successfully!"
diff --git a/tests/auth.test.ts b/tests/auth.test.ts
new file mode 100644
index 000000..6b5a4d
--- /dev/null
+++ b/tests/auth.test.ts
@@ -0,0 +1,6 @@
+describe('Auth Login Fallback Integration Test', () => {
+  it('should recover gracefully when redis service hostname is corrected', async () => {
+    const res = await request(app.getHttpServer()).post('/v1/auth/login').send(validCredentials);
+    expect(res.status).toBe(200);
+  });
+});`;

interface DiffViewerProps {
  filename?: string;
  diffText?: string;
  className?: string;
}

export function DiffViewer({
  filename = 'changes.patch',
  diffText = SAMPLE_MULTI_FILE_DIFF,
  className
}: DiffViewerProps) {
  // 자체 Unified Diff 파서로 파일별 분리
  const files: ParsedDiffFile[] = useMemo(() => {
    return parseUnifiedDiff(diffText, filename);
  }, [diffText, filename]);

  // 파일별 접기/펼치기 상태 관리
  const [collapsedState, setCollapsedState] = useState<Record<string, boolean>>({});

  const toggleCollapse = (fileKey: string) => {
    setCollapsedState((prev) => ({
      ...prev,
      [fileKey]: !prev[fileKey]
    }));
  };

  const collapseAll = () => {
    const next: Record<string, boolean> = {};
    files.forEach((f, idx) => {
      next[`${f.filename}_${idx}`] = true;
    });
    setCollapsedState(next);
  };

  const expandAll = () => {
    setCollapsedState({});
  };

  const totalAdditions = useMemo(() => files.reduce((acc, f) => acc + f.additions, 0), [files]);
  const totalDeletions = useMemo(() => files.reduce((acc, f) => acc + f.deletions, 0), [files]);

  return (
    <div className={cn('space-y-3 font-mono text-xs', className)}>
      {/* 최상단 요약 바 */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 font-bold text-slate-800">
            <Layers className="w-4 h-4 text-indigo-600" />
            <span>총 {files.length}개 변경 파일</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-0.5 rounded bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800">
              <Plus className="w-3 h-3" />
              {totalAdditions} 줄 추가
            </span>
            <span className="inline-flex items-center gap-0.5 rounded bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-800">
              <Minus className="w-3 h-3" />
              {totalDeletions} 줄 삭제
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 text-[11px]">
          <button
            type="button"
            onClick={expandAll}
            className="flex items-center gap-1 rounded px-2 py-1 text-slate-600 hover:bg-slate-200 transition"
          >
            <UnfoldVertical className="w-3.5 h-3.5" />
            <span>모두 펼치기</span>
          </button>
          <span className="text-slate-300">|</span>
          <button
            type="button"
            onClick={collapseAll}
            className="flex items-center gap-1 rounded px-2 py-1 text-slate-600 hover:bg-slate-200 transition"
          >
            <FoldVertical className="w-3.5 h-3.5" />
            <span>모두 접기</span>
          </button>
        </div>
      </div>

      {/* 파일별 Diff 카드 목록 */}
      {files.map((file, fileIdx) => {
        const fileKey = `${file.filename}_${fileIdx}`;
        const isCollapsed = Boolean(collapsedState[fileKey]);

        return (
          <div
            key={fileKey}
            className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden"
          >
            {/* 파일 헤더 */}
            <div
              onClick={() => toggleCollapse(fileKey)}
              className="flex items-center justify-between border-b border-slate-200 bg-slate-50/90 px-4 py-3 cursor-pointer hover:bg-slate-100/80 transition select-none"
            >
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="text-slate-500 hover:text-slate-800"
                  aria-label={isCollapsed ? '펼치기' : '접기'}
                >
                  {isCollapsed ? (
                    <ChevronRight className="w-4 h-4 text-slate-600" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-slate-600" />
                  )}
                </button>
                <FileCode className="w-4 h-4 text-indigo-600" />
                <span className="font-bold text-slate-900 text-xs tracking-tight">
                  {file.filename}
                </span>
                <span className="rounded bg-slate-200/80 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                  파일 {fileIdx + 1}/{files.length}
                </span>
              </div>

              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold font-mono">
                  {file.additions > 0 && (
                    <span className="text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.2">
                      +{file.additions}
                    </span>
                  )}
                  {file.deletions > 0 && (
                    <span className="text-rose-700 bg-rose-50 border border-rose-200 rounded px-1.5 py-0.2">
                      -{file.deletions}
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-slate-400">
                  {isCollapsed ? '펼치기' : '접기'}
                </span>
              </div>
            </div>

            {/* 파일별 Diff 본문 */}
            {!isCollapsed && (
              <div className="p-3 overflow-x-auto bg-slate-950 text-slate-100 leading-5">
                {file.lines.map((line, lineIdx) => {
                  const isAdded = line.type === 'add';
                  const isDeleted = line.type === 'delete';
                  const isHunk = line.type === 'hunk';
                  const isHeader = line.type === 'header';

                  return (
                    <div
                      key={lineIdx}
                      className={cn('flex items-start px-2 py-0.5 rounded-sm', {
                        'bg-emerald-950/70 text-emerald-300 font-medium': isAdded,
                        'bg-rose-950/70 text-rose-300 font-medium line-through decoration-rose-500/50': isDeleted,
                        'bg-sky-950/50 text-sky-300 font-semibold my-1 border-y border-sky-900/40': isHunk,
                        'text-slate-500 italic text-[11px] py-0': isHeader,
                        'text-slate-300': !isAdded && !isDeleted && !isHunk && !isHeader
                      })}
                    >
                      {/* 이전 라인 번호 */}
                      <span className="w-8 select-none text-slate-500 text-right pr-2 shrink-0">
                        {line.oldLineNo ?? ''}
                      </span>
                      {/* 새 라인 번호 */}
                      <span className="w-8 select-none text-slate-500 text-right pr-3 shrink-0">
                        {line.newLineNo ?? ''}
                      </span>
                      {/* 기호 (+, -, @@, ' ') */}
                      <span
                        className={cn('w-4 select-none text-center font-bold shrink-0', {
                          'text-emerald-400': isAdded,
                          'text-rose-400': isDeleted,
                          'text-sky-400': isHunk,
                          'text-slate-600': !isAdded && !isDeleted && !isHunk
                        })}
                      >
                        {isAdded ? '+' : isDeleted ? '-' : isHunk ? '@@' : ' '}
                      </span>
                      {/* 코드 내용 */}
                      <span className="flex-1 whitespace-pre pl-1">{line.text}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
