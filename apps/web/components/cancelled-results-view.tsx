'use client';
import { useQuery } from '@tanstack/react-query';
import { apiClient, API_MODE } from '@/lib/api-client';
import { Execution, Result } from '@/lib/types';
import { DiffViewer, SAMPLE_DIFF } from './diff-viewer';

function CancelledRound({
  execution,
  result,
  round,
}: {
  execution: Execution;
  result?: Result;
  round: number;
}) {
  const artifacts = useQuery({
    queryKey: ['partial-artifacts', result?.id, ...(result?.artifactIds ?? [])],
    queryFn: () =>
      Promise.all((result?.artifactIds ?? []).map((id) => apiClient.getArtifactText(id))),
    enabled: API_MODE === 'real' && !!result?.artifactIds.length,
  });
  const patches = artifacts.data?.filter((item) => item.artifact.kind === 'PATCH') ?? [];
  return (
    <article
      className="rounded-xl border border-slate-300 bg-white p-5 shadow-sm"
      data-testid="cancelled-result"
    >
      <h3 className="text-base font-bold text-slate-800">
        {round}차 실행 · {result ? '취소됨 · 부분 결과' : '취소됨 (수집된 변경 없음)'}
      </h3>
      <p className="mt-2 text-sm text-slate-600">
        취소 시점까지 수집된 변경입니다. 최종 결과가 아니며 승인할 수 없습니다.
      </p>
      {result && (
        <>
          <p className="mt-4 whitespace-pre-wrap text-sm text-slate-900">{result.summary}</p>
          <h4 className="mt-4 text-sm font-semibold">
            부분 변경 파일 ({result.changedFiles.length})
          </h4>
          <ul className="my-2 space-y-1 text-sm font-mono text-slate-700">
            {result.changedFiles.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
          {artifacts.isPending && API_MODE === 'real' && !!result.artifactIds.length && (
            <p>부분 변경을 불러오는 중…</p>
          )}
          {artifacts.isError && (
            <p role="alert" className="text-rose-700">
              부분 변경 파일을 불러오지 못했습니다.
            </p>
          )}
          {patches.map(({ artifact, text }) => (
            <DiffViewer key={artifact.id} filename={artifact.filename} diffText={text} />
          ))}
          {API_MODE === 'mock' && result.artifactIds.includes('clo11-mock-patch') && (
            <DiffViewer filename="deployment.yaml" diffText={SAMPLE_DIFF} />
          )}
          {!result.artifactIds.length && (
            <p className="mt-3 text-sm text-slate-500">수집된 patch 없음</p>
          )}
        </>
      )}
    </article>
  );
}

export function CancelledResultsView({
  executions = [],
  results = [],
}: {
  executions?: Execution[];
  results?: Result[];
}) {
  const cancelled = executions
    .map((execution, index) => ({ execution, round: index + 1 }))
    .filter(({ execution }) => execution.status === 'CANCELLED');
  if (!cancelled.length) return null;
  return (
    <section className="mb-6 space-y-3" aria-label="취소된 실행 결과 이력">
      <h2 className="text-lg font-semibold text-slate-900">취소된 실행 결과 이력</h2>
      {cancelled.map(({ execution, round }) => (
        <CancelledRound
          key={execution.id}
          execution={execution}
          round={round}
          result={results.find(
            (result) => result.executionId === execution.id && result.kind === 'PARTIAL',
          )}
        />
      ))}
    </section>
  );
}
