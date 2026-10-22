import { z } from 'zod';

/**
 * 에이전트가 쓸 수 있는 모델. **데몬이 각 CLI 에서 직접 읽어 보고한다.**
 *
 * CLI 마다 제공 수준이 달라서 `source` 로 어디서 얻은 값인지 함께 남긴다 (2026-09-21 실측):
 * - `cli`     : CLI 가 목록을 준다 (`agy models`, `claude --help` 의 별칭)
 * - `config`  : 목록은 없고 설정 파일의 기본 모델만 읽었다 (`~/.codex/config.toml`)
 * - `builtin` : CLI 에서 아무것도 못 읽어 데몬 내장 목록을 쓴다
 *
 * 목록에 없는 모델을 쓸 수도 있으므로 서버는 이 목록으로 실행을 막지 않는다.
 * 잘못된 이름은 CLI 가 거부하고 실행이 FAILED 로 끝난다.
 */
/**
 * 고를 수 있는 항목 하나. **모델과 추론 강도의 조합**이다.
 *
 * 화면은 `group`(모델) → `effort`(강도) 두 단계로 고르게 하고, 고른 항목의 `id` 를
 * 그대로 실행에 싣는다. id 안에서 둘을 어떻게 표현하는지는 provider 마다 다르며
 * (Codex·Claude Code 는 `<모델>:<강도>`, Antigravity 는 슬러그 자체가 변형이다)
 * 그 해석은 각 Adapter 가 한다.
 */
export const AgentModelSchema = z.object({
  /** 실행에 싣는 값. Adapter 가 이걸 CLI 인자로 바꾼다 */
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  /** 모델 이름. 같은 모델의 강도별 항목이 이 값으로 묶인다 */
  group: z.string().min(1).max(200).optional(),
  /** 추론 강도 (low/medium/high/…). 없으면 강도 선택이 없는 모델이다 */
  effort: z.string().min(1).max(40).optional(),
});
export type AgentModel = z.infer<typeof AgentModelSchema>;

export const AgentModelsSchema = z.object({
  models: z.array(AgentModelSchema).max(200).default([]),
  /** 모델을 고르지 않았을 때 실제로 쓰이는 모델. 모르면 null. */
  defaultModel: z.string().max(200).nullable().default(null),
  source: z.enum(['cli', 'config', 'builtin']).default('builtin'),
});
export type AgentModels = z.infer<typeof AgentModelsSchema>;

export const EMPTY_AGENT_MODELS: AgentModels = { models: [], defaultModel: null, source: 'builtin' };
