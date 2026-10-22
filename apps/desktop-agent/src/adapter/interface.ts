import type { AgentCapabilities, AgentModels, AgentProvider } from '@baton/shared';
import type { Attachment, Policy } from '../transport/events';
import type { CollectedResult } from './claude-code/collector';
import type { ExecDir } from './claude-code/exec-dir';
import type { ProgressEvent } from './claude-code/stream-mapper';

// 기존 산출물 경로와 3계층 결과 형식은 유지한다. 타입 참조만 사용하므로 구현은 로드하지 않는다.
export type { ProgressEvent } from './claude-code/stream-mapper';

export interface AdapterCapabilities extends AgentCapabilities {
  provider: AgentProvider;
  displayName: string;
  version: string;
}

export interface ExecutionContext {
  approvalRequest?: (method: string, path: string, body: unknown, signal: AbortSignal) => Promise<unknown>;
  executionId: string;
  requestId: string;
  title?: string;
  senderName?: string;
  originalInstruction?: string;
  previousWork?: string;
  additionalInstruction?: string;
  // 기획서 §18 추가 작업: resumeSessionId 가 있으면 그 세션을 `--resume` 으로 이어가고 프롬프트엔 followUpInstruction 만 싣는다.
  followUpInstruction?: string | null;
  resumeSessionId?: string | null;
  policy: Policy;
  projectRoot: string;
  attachments: Attachment[];
  sessionId?: string;
  maxTurns?: number;
  model?: string;
  maxBudgetUsd?: number;
  acknowledgedRisks?: string[];
  inheritedRiskKeys?: string[];
}

export type RunOutcome = 'success' | 'partial' | 'failed' | 'cancelled';

export interface ExecutionRunResult {
  outcome: RunOutcome;
  exitCode: number | null;
  failureReason: string | null;
  failureCode?: 'project_not_git' | 'git_missing';
  dir: ExecDir;
  // 실제 claude 세션 id. stream-json 의 system/init 에서 읽은 값이 우선이고, 못 읽으면 우리가 발급/요청한 값이다.
  sessionId: string;
  // 이어가기를 시도한 이전 세션 id (없으면 null), resume 실패로 새 세션에 원본 맥락을 다시 실었는지 여부
  resumedFrom: string | null;
  resumeFallback: boolean;
  numTurns: number | null;
  costUsd: number | null;
  durationMs: number;
  collected: CollectedResult;
  manifest: Record<string, unknown>;
}

export interface RunnerCallbacks {
  onProgress: (event: ProgressEvent) => void;
  onLogChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

// 준비·정책 강제·기동·스트림 파싱·3계층 수집·세션 재개는 각 러너의 실행 루프가 담당한다.
export interface AgentRunner {
  readonly isCancelled: boolean;
  run(ctx: ExecutionContext, callbacks: RunnerCallbacks): Promise<ExecutionRunResult>;
  cancel(graceMs?: number): void;
  interrupt(): void;
}

export interface AgentAdapter {
  readonly provider: AgentProvider;
  detect(): Promise<{ available: boolean; binaryPath?: string; version?: string; reason?: string }>;
  /**
   * 쓸 수 있는 모델을 CLI 에서 직접 읽는다.
   * **느릴 수 있다** (agy 는 네트워크를 타서 실측 33초) — 등록 경로에서 기다리지 말 것.
   */
  listModels(): Promise<AgentModels>;
  getCapabilities(): AdapterCapabilities;
  createRunner(): AgentRunner;
}

// 서버 계약에는 로컬 Adapter 식별 메타데이터를 섞지 않는다.
export function registrationCapabilities(adapter: AgentAdapter): AgentCapabilities {
  const { provider, displayName, version, ...capabilities } = adapter.getCapabilities();
  return capabilities;
}
