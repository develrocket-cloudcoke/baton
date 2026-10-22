'use client';

import React from 'react';
import { Cpu, Gauge } from 'lucide-react';
import { Agent, AgentModel, AgentModels } from '@baton/shared';

/** 데몬이 보고하기 전이거나 모양이 깨졌으면 빈 값으로 본다. */
function readModels(agent?: Agent | null): AgentModels | null {
  const raw = agent?.models as AgentModels | null | undefined;
  if (!raw || !Array.isArray(raw.models)) return null;
  return raw;
}

const SOURCE_NOTE: Record<string, string> = {
  cli: 'CLI 가 알려 준 목록입니다.',
  config: '이 CLI 는 모델 목록을 제공하지 않아 설정 파일의 기본값만 읽었습니다.',
  builtin: '이 CLI 에서 목록을 읽지 못해 기본 목록을 보여 줍니다.',
};

const groupOf = (m: AgentModel) => m.group ?? m.label;

/**
 * 실행에 쓸 모델과 추론 강도를 고른다.
 *
 * provider 마다 강도를 넘기는 방법이 다르지만(Claude Code·Antigravity 는 `--effort`,
 * Codex 는 `-c model_reasoning_effort`) 화면에서는 똑같이 **모델 → 강도** 두 단계다.
 * 고른 항목의 `id` 를 그대로 실어 보내고 해석은 각 Adapter 가 한다.
 *
 * 빈 문자열은 "고르지 않음" 이고, 그때는 데몬 기본값 → CLI 기본값 순으로 떨어진다.
 * **직접 입력은 받지 않는다** — 오타는 실행이 시작된 뒤에야 FAILED 로 드러난다.
 */
export function ModelSelect({
  agent,
  value,
  onChange,
}: {
  agent?: Agent | null;
  value: string;
  onChange: (model: string) => void;
}) {
  const info = readModels(agent);
  const listed = React.useMemo(() => info?.models ?? [], [info]);

  // 모델 이름(그룹) 목록. 목록에 나온 순서를 지킨다 — CLI 가 최신순으로 준다.
  const groups = React.useMemo(() => {
    const seen = new Map<string, AgentModel[]>();
    for (const m of listed) {
      const key = groupOf(m);
      const bucket = seen.get(key);
      if (bucket) bucket.push(m);
      else seen.set(key, [m]);
    }
    return [...seen.entries()];
  }, [listed]);

  const selected = listed.find((m) => m.id === value) ?? null;
  const selectedGroup = selected ? groupOf(selected) : '';
  const variants = groups.find(([name]) => name === selectedGroup)?.[1] ?? [];
  const hasEfforts = variants.some((m) => m.effort);

  // 에이전트를 바꾸면 이전 provider 의 모델 이름은 의미가 없다. 기본값으로 되돌린다.
  React.useEffect(() => {
    if (value && !listed.some((m) => m.id === value)) onChange('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id]);

  const pickGroup = (name: string) => {
    if (!name) {
      onChange('');
      return;
    }
    const items = groups.find(([g]) => g === name)?.[1] ?? [];
    // 모델을 고르면 그 모델의 기본 항목(있으면 defaultModel, 없으면 첫 강도)으로 맞춘다.
    const preferred = items.find((m) => m.id === info?.defaultModel) ?? items[0];
    if (preferred) onChange(preferred.id);
  };

  const defaultLabel = info?.defaultModel ? `기본값 (${info.defaultModel})` : '기본값';

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <label className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-700">
          <Cpu className="h-4 w-4 text-slate-500" />
          <span>모델</span>
        </label>
        <select
          data-testid="model-select"
          value={selectedGroup}
          onChange={(e) => pickGroup(e.target.value)}
          className="w-full rounded-lg border border-slate-300 bg-white p-2.5 text-sm focus:border-indigo-500 focus:outline-none"
        >
          <option value="">{defaultLabel}</option>
          {groups.map(([name]) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <p className="mt-1.5 text-xs text-slate-500">
          {info
            ? (SOURCE_NOTE[info.source] ?? '')
            : '이 에이전트가 아직 모델 목록을 보고하지 않았습니다. 기본값으로 실행됩니다.'}
        </p>
      </div>

      <div>
        <label className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-700">
          <Gauge className="h-4 w-4 text-slate-500" />
          <span>추론 강도</span>
        </label>
        <select
          data-testid="effort-select"
          value={value}
          disabled={!hasEfforts}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-lg border border-slate-300 bg-white p-2.5 text-sm focus:border-indigo-500 focus:outline-none disabled:bg-slate-100 disabled:text-slate-400"
        >
          {!selectedGroup ? (
            <option value="">모델을 먼저 고르세요</option>
          ) : !hasEfforts ? (
            <option value={variants[0]?.id ?? ''}>이 모델은 강도 선택이 없습니다</option>
          ) : (
            variants.map((m) => (
              <option key={m.id} value={m.id}>
                {m.effort}
                {info?.defaultModel === m.id ? ' — 기본' : ''}
              </option>
            ))
          )}
        </select>
        {hasEfforts && (
          <p className="mt-1.5 text-xs text-slate-500">
            높일수록 깊게 생각하지만 느리고 비쌉니다.
          </p>
        )}
      </div>
    </div>
  );
}
