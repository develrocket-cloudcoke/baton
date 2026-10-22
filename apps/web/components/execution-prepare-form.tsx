import React, { useState } from 'react';
import { ModelSelect } from '@/components/model-select';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import {
  StructuredPolicy,
  DEFAULT_STRUCTURED_POLICY,
  RequestEntity,
  UnenforceableProtection,
  UnenforceableProtectionKey,
  unenforceableProtections,
} from '@/lib/types';
import { effectiveAgentCapabilities } from '@baton/shared';
import {
  Play,
  Shield,
  FolderGit2,
  Bot,
  AlertCircle,
  AlertTriangle,
  KeyRound,
  ShieldAlert,
  CheckCircle2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { RiskAcknowledgementModal } from './risk-acknowledgement-modal';

interface ExecutionPrepareFormProps {
  title?: string;
  request: RequestEntity;
  executorUserId: string;
  onSuccess: () => void;
}

export function ExecutionPrepareForm({
  title = '에이전트 실행 준비',
  request,
  executorUserId,
  onSuccess,
}: ExecutionPrepareFormProps) {
  // 기본값을 채워 두면 안 된다. 실행자가 지우지 않으면 그 지시가 **그대로 에이전트에 전달된다** —
  // 2026-09-18 테스트에서 math.js 저장소에 이 기본값이 남아, 에이전트가 있지도 않은
  // Kubernetes 설정을 찾다가 끝났다. 예시는 placeholder 로만 보여 준다.
  const [additionalInstruction, setAdditionalInstruction] = useState<string>('');
  // 사람의 판단이 필요한 지점에서 에이전트가 임의로 고르지 않게 한다. 실행 중에는 물어볼
  // 창구가 없으므로(설계 07), 고르지 말고 멈추게 하는 것이 지금 쓸 수 있는 유일한 방법이다.
  const [stopOnAmbiguity, setStopOnAmbiguity] = useState<boolean>(false);
  // mock ID 를 초기값으로 두면 목록이 늦게 오는 사이에 실서버로 그대로 나간다(400/404).
  // 빈 값이면 아래 effect 가 실제 목록의 첫 에이전트로 맞춘다.
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  // 빈 문자열이면 데몬 기본값 → CLI 기본값 순으로 떨어진다
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [policy, setPolicy] = useState<StructuredPolicy>(DEFAULT_STRUCTURED_POLICY);

  const [isRiskModalOpen, setIsRiskModalOpen] = useState(false);
  const [pendingProtections, setPendingProtections] = useState<UnenforceableProtection[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { data: allAgents } = useQuery({
    queryKey: ['agents'],
    queryFn: () => apiClient.getAgents(),
  });
  // 비활성(DISABLED) 에이전트는 고를 수 없다. 재-pairing 을 반복하면 옛 기기의 에이전트가
  // 쌓여 목록이 길어지는데, 그중 어느 것이 지금 쓰는 기기인지 화면에서 구분되지 않았다.
  const agents = React.useMemo(
    () => (allAgents ?? []).filter((a) => a.status !== 'DISABLED'),
    [allAgents]
  );

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => apiClient.getProjects(),
  });

  // 에이전트 및 프로젝트 데이터 로드 시 기본 선택값 자동 동기화
  React.useEffect(() => {
    if (agents.length > 0) {
      if (!selectedAgentId || !agents.some((a) => a.id === selectedAgentId)) {
        setSelectedAgentId(agents[0].id);
      }
    }
  }, [agents, selectedAgentId]);

  // 프로젝트는 **선택한 에이전트에 등록된 것만** 고를 수 있어야 한다. 다른 기기의
  // 프로젝트를 고르면 그 기기 데몬에 매핑이 없어 "projectId … 에 해당하는 로컬
  // 프로젝트가 이 디바이스에 없습니다" 로 실패한다 — 화면에서는 고를 수 있으니
  // 왜 실패하는지 알 수 없다 (2026-09-18 테스트에서 선택이 어렵다는 지적).
  const agentProjects = React.useMemo(
    () => (projects ?? []).filter((p) => p.agentId === selectedAgentId),
    [projects, selectedAgentId]
  );

  React.useEffect(() => {
    if (agentProjects.length === 0) {
      if (selectedProjectId) setSelectedProjectId('');
      return;
    }
    if (!agentProjects.some((p) => p.id === selectedProjectId)) {
      setSelectedProjectId(agentProjects[0].id);
    }
  }, [agentProjects, selectedProjectId]);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  const agentCapabilities = selectedAgent
    ? effectiveAgentCapabilities(selectedAgent.provider, selectedAgent.capabilities)
    : null;
  const previewProtections = agentCapabilities
    ? unenforceableProtections(agentCapabilities, policy as any)
    : [];

  const handleAgentSelect = (agentId: string) => {
    setSelectedAgentId(agentId);
    const relatedProject = projects?.find((p) => p.agentId === agentId);
    setSelectedProjectId(relatedProject ? relatedProject.id : '');
    // 모델 이름은 provider 마다 다르다. 에이전트를 바꾸면 기본값으로 되돌린다.
    setSelectedModel('');
  };

  const AMBIGUITY_RULE =
    '선택이 필요한 지점이 생기면 임의로 고르지 마세요. 파일은 고치지 말고, 선택지와 각각의 영향을 결과 문서에 정리한 뒤 끝내세요.';

  // 체크박스는 사용자가 친 글을 바꾸지 않고 제출할 때만 덧붙인다.
  const composedInstruction = () =>
    [additionalInstruction.trim(), stopOnAmbiguity ? AMBIGUITY_RULE : ''].filter(Boolean).join('\n\n');

  const handleStartExecution = async (acknowledgedRisks?: UnenforceableProtectionKey[]) => {
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      await apiClient.createExecution(request.id, executorUserId, {
        agentId: selectedAgentId,
        projectId: selectedProjectId,
        additionalInstruction: composedInstruction(),
        model: selectedModel.trim() || null,
        policy,
        acknowledgedRisks,
      });
      setIsRiskModalOpen(false);
      onSuccess();
    } catch (err: any) {
      if (err.status === 409 || err.statusCode === 409) {
        const errorData = err.data || err.response;
        const protections = errorData?.unenforceableProtections || previewProtections;
        if (protections && protections.length > 0) {
          setPendingProtections(protections);
          setIsRiskModalOpen(true);
          setIsSubmitting(false);
          return;
        }
      }
      setErrorMessage(err.message || '에이전트 실행 시작에 실패했습니다.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="rounded-xl border border-indigo-200 bg-white p-6 shadow-sm">
      <div className="flex items-center gap-2 mb-4 border-b border-slate-100 pb-3">
        <Play className="w-5 h-5 text-indigo-600 fill-indigo-600" />
        <h3 className="font-bold text-base text-slate-900">{title}</h3>
      </div>

      <p className="text-xs text-slate-600 mb-5">
        받은 사람의 Mac에서 실행되는 AI 에이전트에게 작업을 위임하기 위한 추가
        지시사항 및 보안 정책을 설정합니다.
      </p>

      {/* 1. 추가 지시사항 textarea */}
      <div className="mb-5">
        <label className="block text-xs font-semibold text-slate-700 mb-1.5 flex items-center justify-between">
          <span>실행자의 추가 지시사항</span>
          <span className="text-[11px] font-normal text-slate-500">
            원본 요청과 합쳐지지 않고 독립 스냅샷으로 보존됨
          </span>
        </label>
        <textarea
          value={additionalInstruction}
          onChange={(e) => setAdditionalInstruction(e.target.value)}
          rows={3}
          placeholder="예: 운영 환경은 변경하지 마. Kubernetes 설정만 확인하고 수정안 작성해줘"
          className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-sans"
        />
        <label className="mt-2 flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            checked={stopOnAmbiguity}
            onChange={(e) => setStopOnAmbiguity(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-semibold">판단이 필요하면 고르지 말고 멈추기</span>
            <span className="block text-slate-500">
              실행 중에는 에이전트가 사람에게 물어볼 수 없어 스스로 가정을 정하고 진행합니다. 이
              항목을 켜면 선택지만 정리하고 멈춘 뒤, 결과를 보고 추가 작업으로 이어서 지시할 수
              있습니다.
            </span>
          </span>
        </label>
      </div>

      {/* 2. 실행 Agent 및 대상 프로젝트 선택 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-3">
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1.5 flex items-center gap-1.5">
            <Bot className="w-4 h-4 text-slate-500" />
            <span>실행 대상 Agent</span>
          </label>
          <select
            data-testid="agent-select"
            value={selectedAgentId}
            onChange={(e) => handleAgentSelect(e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white p-2.5 text-sm focus:border-indigo-500 focus:outline-none"
          >
            {agents.length > 0 ? agents.map((a) => {
              const caps = effectiveAgentCapabilities(a.provider, a.capabilities);
              // 오프라인 에이전트를 고르면 실행이 QUEUED 로 앉아 있기만 한다. 목록에서 바로 보이게 한다.
              const online = a.status === 'ONLINE' || a.status === 'BUSY';
              return (
                <option key={a.id} value={a.id}>
                  {online ? '● 온라인' : '○ 오프라인'} — {a.displayName} ({a.provider} • {caps.securityTier})
                </option>
              );
            }) : <option value="">연결된 에이전트가 없습니다</option>}
          </select>
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1.5 flex items-center gap-1.5">
            <FolderGit2 className="w-4 h-4 text-slate-500" />
            <span>실행 프로젝트 (로컬 Git 워크스페이스)</span>
          </label>
          <select
            data-testid="project-select"
            value={selectedProjectId}
            onChange={(e) => setSelectedProjectId(e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white p-2.5 text-sm focus:border-indigo-500 focus:outline-none"
          >
            {agentProjects.length === 0 ? (
              <option value="">등록된 프로젝트가 없습니다</option>
            ) : (
              agentProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.localPathHint ? `${p.displayName} (${p.localPathHint})` : p.displayName}
                </option>
              ))
            )}
          </select>
          {agentProjects.length === 0 && (
            <p className="mt-1.5 text-xs text-amber-700">
              이 에이전트에 등록된 프로젝트가 없습니다. 그 컴퓨터의 메뉴바 Baton →{' '}
              <span className="font-semibold">설정 → 프로젝트 추가</span> 에서 이름과 로컬 경로를
              넣고 <span className="font-semibold">설정 저장</span> 을 누르면 여기에 나타납니다.
            </p>
          )}
          {selectedAgent && selectedAgent.status !== 'ONLINE' && selectedAgent.status !== 'BUSY' && (
            <p className="mt-1.5 text-xs text-amber-700">
              이 에이전트는 지금 오프라인입니다. 이대로 실행하면 그 컴퓨터가 붙을 때까지 대기
              상태로 남습니다.
            </p>
          )}
        </div>

        <ModelSelect agent={selectedAgent} value={selectedModel} onChange={setSelectedModel} />
      </div>

      {/* 선택된 Agent 보안 등급 뱃지 및 미지원 보호 사전 고지 배너 */}
      <div className="mb-6 space-y-2">
        {selectedAgent && agentCapabilities && (
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className="font-semibold text-slate-700">에이전트 보안 스펙:</span>
            <span className="rounded-md bg-slate-100 border border-slate-200 px-2 py-0.5 font-semibold text-slate-800">
              Provider: {selectedAgent.provider}
            </span>
            <span
              className={cn(
                'rounded-md px-2 py-0.5 font-bold',
                agentCapabilities.securityTier === 'tier_a_hardened'
                  ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                  : agentCapabilities.securityTier === 'tier_b_sandboxed'
                  ? 'bg-blue-100 text-blue-800 border border-blue-200'
                  : 'bg-amber-100 text-amber-800 border border-amber-200',
              )}
            >
              {agentCapabilities.securityTier === 'tier_a_hardened'
                ? 'Tier A (Hardened) - 완벽 강제'
                : agentCapabilities.securityTier === 'tier_b_sandboxed'
                ? 'Tier B (Sandboxed) - 부분 강제'
                : 'Tier C (Unrestricted) - 보호 미지원'}
            </span>
          </div>
        )}

        {previewProtections.length > 0 ? (
          <div
            data-testid="unenforceable-protections-preview"
            className="rounded-xl border border-amber-300 bg-amber-50/70 p-3.5 text-xs text-amber-900"
          >
            <div className="flex items-center gap-2 font-bold mb-1 text-amber-950">
              <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0" />
              <span>
                보호 조치 미지원 사전 고지 ({previewProtections.length}개 항목 강제 불가)
              </span>
            </div>
            <p className="text-[11px] text-amber-800 mb-2.5 leading-relaxed">
              선택한 Agent는 현재 보안 정책 중 아래 {previewProtections.length}개의 보호 조치를
              기술적으로 강제할 수 없습니다. 실행 시작 시 각 항목의 설명과 위험을 개별 확인하고
              승인해야 실행이 진행됩니다.
            </p>
            <div className="flex flex-wrap gap-2">
              {previewProtections.map((p) => {
                const isCrit = p.severity === 'critical';
                return (
                  <span
                    key={p.key}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold shadow-2xs',
                      isCrit
                        ? 'bg-red-100 text-red-800 border border-red-300'
                        : 'bg-white text-amber-900 border border-amber-300',
                    )}
                  >
                    {isCrit ? (
                      <KeyRound className="w-3.5 h-3.5 text-red-600 shrink-0" />
                    ) : (
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                    )}
                    <span>{p.title}</span>
                    <span
                      className={cn(
                        'text-[10px] px-1 py-0.2 rounded font-bold uppercase',
                        isCrit ? 'bg-red-200 text-red-900' : 'bg-amber-100 text-amber-800',
                      )}
                    >
                      {p.severity}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 text-xs text-emerald-800 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>
              <strong>강제 불가 보호 없음:</strong> 이 Agent는 현재 설정된 모든 보안 정책을
              완전히 강제할 수 있어 위험 승인 경고 없이 즉시 실행됩니다.
            </span>
          </div>
        )}
      </div>

      {/* 3. F4 구조화 Policy 토글 (01 §5.4.1) */}
      <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-4 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Shield className="w-4 h-4 text-indigo-600" />
          <h4 className="text-xs font-bold text-slate-900">
            F4 구조화된 Policy 설정 (보안 샌드박스 및 오인 방지 정책)
          </h4>
        </div>
        <p className="text-[11px] text-slate-500 mb-3">
          &quot;운영 변경 금지&quot;를 &quot;로컬 파일도 고치지 마&quot;로 모델이 오해하지 않도록,
          데몬과 프롬프트에 명시적으로 주입되는 구조화 정책 필드입니다.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-xs">
          {/* repository_edit */}
          <div className="rounded-md border border-slate-200 bg-white p-2.5">
            <div className="font-semibold text-slate-800 mb-1">
              로컬 파일 수정 (repository_edit)
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="repo_edit"
                  checked={policy.repository_edit === 'allow'}
                  onChange={() => setPolicy({ ...policy, repository_edit: 'allow' })}
                />
                <span className="text-emerald-700 font-medium">허용 (allow)</span>
              </label>
              <label className="flex items-center gap-1 cursor-pointer ml-2">
                <input
                  type="radio"
                  name="repo_edit"
                  checked={policy.repository_edit === 'deny'}
                  onChange={() => setPolicy({ ...policy, repository_edit: 'deny' })}
                />
                <span className="text-rose-600">차단 (deny)</span>
              </label>
            </div>
          </div>

          {/* deployment_apply */}
          <div className="rounded-md border border-slate-200 bg-white p-2.5">
            <div className="font-semibold text-slate-800 mb-1">
              운영/클러스터 배포 (deployment_apply)
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="deploy_apply"
                  checked={policy.deployment_apply === 'deny'}
                  onChange={() => setPolicy({ ...policy, deployment_apply: 'deny' })}
                />
                <span className="text-emerald-700 font-medium">차단 (deny)</span>
              </label>
              <label className="flex items-center gap-1 cursor-pointer ml-2">
                <input
                  type="radio"
                  name="deploy_apply"
                  checked={policy.deployment_apply === 'allow'}
                  onChange={() => setPolicy({ ...policy, deployment_apply: 'allow' })}
                />
                <span className="text-rose-600">허용 (allow)</span>
              </label>
            </div>
          </div>

          <div className="rounded-md border border-slate-200 bg-white p-2.5">
            <div className="font-semibold text-slate-800 mb-1">Git 쓰기 (git_write)</div>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ['deny', '금지 (기본)'],
                  ['local', '로컬 커밋·브랜치·태그'],
                  ['push', '원격 푸시·PR까지 허용'],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="git_write"
                    value={value}
                    checked={policy.git_write === value}
                    onChange={() => setPolicy({ ...policy, git_write: value })}
                  />
                  {label}
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              셸·저장소·네트워크 제한은 그대로 적용됩니다. 원격 푸시·PR은 실행 전 위험 확인이
              필요합니다.
            </p>
          </div>

          {/* network_outbound */}
          <div className="rounded-md border border-slate-200 bg-white p-2.5">
            <div className="font-semibold text-slate-800 mb-1">
              외부 네트워크 통신 (network_outbound)
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="net_out"
                  checked={policy.network_outbound === 'deny'}
                  onChange={() => setPolicy({ ...policy, network_outbound: 'deny' })}
                />
                <span className="text-emerald-700 font-medium">차단 (deny)</span>
              </label>
              <label className="flex items-center gap-1 cursor-pointer ml-2">
                <input
                  type="radio"
                  name="net_out"
                  checked={policy.network_outbound === 'allow'}
                  onChange={() => setPolicy({ ...policy, network_outbound: 'allow' })}
                />
                <span className="text-rose-600">허용 (allow)</span>
              </label>
            </div>
          </div>

          {/* outside_write */}
          <div className="rounded-md border border-slate-200 bg-white p-2.5">
            <div className="font-semibold text-slate-800 mb-1">
              프로젝트 외 쓰기 (outside_write)
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="out_write"
                  checked={policy.outside_write === 'deny'}
                  onChange={() => setPolicy({ ...policy, outside_write: 'deny' })}
                />
                <span className="text-emerald-700 font-medium">차단 (deny)</span>
              </label>
              <label className="flex items-center gap-1 cursor-pointer ml-2">
                <input
                  type="radio"
                  name="out_write"
                  checked={policy.outside_write === 'allow'}
                  onChange={() => setPolicy({ ...policy, outside_write: 'allow' })}
                />
                <span className="text-rose-600">허용 (allow)</span>
              </label>
            </div>
          </div>

          {/* shell_execution */}
          <div className="rounded-md border border-slate-200 bg-white p-2.5 sm:col-span-2">
            <div className="font-semibold text-slate-800 mb-1">
              셸 명령 실행 수준 (shell_execution)
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="shell_exec"
                  checked={policy.shell_execution === 'allow'}
                  onChange={() => setPolicy({ ...policy, shell_execution: 'allow' })}
                />
                <span className="text-emerald-700 font-medium">허용 (allow)</span>
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="shell_exec"
                  checked={policy.shell_execution === 'read_only'}
                  onChange={() => setPolicy({ ...policy, shell_execution: 'read_only' })}
                />
                <span className="text-amber-700">읽기 전용 (read_only)</span>
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="shell_exec"
                  checked={policy.shell_execution === 'deny'}
                  onChange={() => setPolicy({ ...policy, shell_execution: 'deny' })}
                />
                <span className="text-rose-600">차단 (deny)</span>
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* 실행 시작 버튼 */}
      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          data-testid="start-execution-button"
          onClick={() => handleStartExecution()}
          disabled={isSubmitting || !selectedProjectId || !selectedAgentId}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 transition disabled:opacity-50 cursor-pointer"
        >
          <Play className="w-4 h-4 fill-white" />
          <span>{isSubmitting ? '실행 명령 전달 중...' : 'Agent 실행 시작'}</span>
        </button>
      </div>

      {errorMessage && (
        <div className="mt-3 flex items-center gap-1.5 text-xs text-rose-600">
          <AlertCircle className="w-4 h-4" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* 위험 항목별 승인 모달 */}
      <RiskAcknowledgementModal
        isOpen={isRiskModalOpen}
        onClose={() => setIsRiskModalOpen(false)}
        onConfirm={(acknowledgedKeys) => {
          handleStartExecution(acknowledgedKeys);
        }}
        protections={pendingProtections}
        agentName={selectedAgent?.displayName}
        provider={selectedAgent?.provider}
        securityTier={agentCapabilities?.securityTier}
        isLoading={isSubmitting}
      />
    </div>
  );
}
