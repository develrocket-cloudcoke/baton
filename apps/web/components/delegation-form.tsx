'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import { Artifact, CreateDelegationDto, RequestDetailResponse } from '@/lib/types';

type Props = {
  detail: RequestDetailResponse;
  userId: string;
  onSuccess: (childId: string) => void;
  onCancel: () => void;
};

function humanError(error: any): string {
  const status = error?.status ?? error?.statusCode;
  if (status === 403) return '이 요청을 재위임할 권한이 없거나, 선택한 팀으로 보내는 경로가 허용되지 않습니다.';
  if (status === 409) return '요청 상태가 바뀌었습니다. 새로고침한 뒤 진행 중인 요청인지 확인해 주세요.';
  if (status === 400) return '선택한 첨부나 결과를 확인해 주세요. 부모 요청에 포함된 항목만 전달할 수 있습니다.';
  return error instanceof Error ? error.message : '도움 요청을 보내지 못했습니다. 다시 시도해 주세요.';
}

export function DelegationForm({ detail, userId, onSuccess, onCancel }: Props) {
  const { request, currentRevision } = detail;
  const [recipientTeamId, setRecipientTeamId] = useState('');
  const [recipientUserId, setRecipientUserId] = useState('');
  const [title, setTitle] = useState(`[도움 요청] ${request.title}`);
  const [instruction, setInstruction] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const recipients = useQuery({
    queryKey: ['delegation-recipients', request.recipientTeamId],
    queryFn: () => apiClient.getRecipients(request.recipientTeamId),
  });
  const teams = (recipients.data?.teams ?? []).filter((team) => team.id !== request.recipientTeamId);
  const selectedTeam = teams.find((team) => team.id === recipientTeamId);

  const documentRows = useMemo(() => {
    const attached = new Set(currentRevision.documentVersionIds ?? []);
    return detail.documents
      .filter((item) => item.currentVersion && attached.has(item.currentVersion.id))
      .map((item) => ({ id: item.currentVersion!.id, label: `${item.document.name} · v${item.currentVersion!.versionNo}` }));
  }, [currentRevision.documentVersionIds, detail.documents]);
  const artifactRows = useMemo(() => {
    const attached = new Set(currentRevision.artifactIds ?? []);
    return detail.artifacts.filter((item) => attached.has(item.id));
  }, [currentRevision.artifactIds, detail.artifacts]);
  const results = (detail.results ?? []).filter((result) => !!result.summary);

  const [documentVersionIds, setDocumentVersionIds] = useState<string[]>(() => documentRows.map((item) => item.id));
  const [artifactIds, setArtifactIds] = useState<string[]>(() => artifactRows.map((item) => item.id));
  const [resultIds, setResultIds] = useState<string[]>(() =>
    results.filter((result) => result.reviewStatus === 'APPROVED').map((result) => result.id),
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const dto: CreateDelegationDto = {
        recipientTeamId,
        ...(recipientUserId ? { recipientUserId } : {}),
        title: title.trim(),
        instruction: instruction.trim(),
        documentVersionIds,
        artifactIds,
        resultIds,
      };
      const child = await apiClient.createDelegation(request.id, dto);
      onSuccess(child.id);
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (items: string[], setter: (value: string[]) => void, id: string) =>
    setter(items.includes(id) ? items.filter((item) => item !== id) : [...items, id]);

  return (
    <form onSubmit={submit} className="rounded-xl border border-indigo-200 bg-white p-5 shadow-sm space-y-4">
      <div>
        <h3 className="font-bold text-slate-900">다른 팀에 도움 요청</h3>
        <p className="mt-1 text-xs text-slate-600">원본 요청의 지시와 고른 첨부·결과가 함께 전달됩니다. 받는 팀이 수락해야 실행됩니다.</p>
      </div>

      <label className="block text-sm font-medium text-slate-700">
        받는 팀
        <select required value={recipientTeamId} onChange={(e) => { setRecipientTeamId(e.target.value); setRecipientUserId(''); }}
          className="mt-1 block w-full rounded-lg border border-slate-300 bg-white p-2 text-sm">
          <option value="">팀을 선택하세요</option>
          {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
        </select>
      </label>
      {selectedTeam && <label className="block text-sm font-medium text-slate-700">
        담당자 <span className="font-normal text-slate-500">(선택 사항, 비우면 팀 전체에 전달)</span>
        <select value={recipientUserId} onChange={(e) => setRecipientUserId(e.target.value)}
          className="mt-1 block w-full rounded-lg border border-slate-300 bg-white p-2 text-sm">
          <option value="">팀 전체</option>
          {selectedTeam.members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}
        </select>
      </label>}

      <label className="block text-sm font-medium text-slate-700">제목
        <input required maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)}
          className="mt-1 block w-full rounded-lg border border-slate-300 p-2 text-sm" />
      </label>
      <label className="block text-sm font-medium text-slate-700">부탁할 내용
        <textarea required maxLength={100000} value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={5}
          className="mt-1 block w-full rounded-lg border border-slate-300 p-2 text-sm" />
      </label>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-slate-800">상속할 첨부</legend>
        {documentRows.length + artifactRows.length === 0 && <p className="text-xs text-slate-500">현재 차수에 첨부된 항목이 없습니다.</p>}
        {documentRows.map((item) => <label key={item.id} className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={documentVersionIds.includes(item.id)} onChange={() => toggle(documentVersionIds, setDocumentVersionIds, item.id)} />
          문서: {item.label}
        </label>)}
        {artifactRows.map((item: Artifact) => <label key={item.id} className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={artifactIds.includes(item.id)} onChange={() => toggle(artifactIds, setArtifactIds, item.id)} />
          파일: {item.filename}
        </label>)}
      </fieldset>

      {results.length > 0 && <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-slate-800">상속할 결과 요약</legend>
        {results.map((result) => <label key={result.id} className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" className="mt-1" checked={resultIds.includes(result.id)} onChange={() => toggle(resultIds, setResultIds, result.id)} />
          <span><span className="font-medium">{result.reviewStatus === 'APPROVED' ? '승인됨' : '검토 전'}</span> · {result.summary}</span>
        </label>)}
      </fieldset>}

      {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700">취소</button>
        <button type="submit" disabled={busy || !recipientTeamId || !title.trim() || !instruction.trim() || !userId}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
          {busy ? '보내는 중…' : '도움 요청 보내기'}
        </button>
      </div>
    </form>
  );
}
