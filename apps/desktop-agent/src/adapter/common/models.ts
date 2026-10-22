import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentModels } from '@baton/shared';

const isScript = (binaryPath: string) => /\.(m?js)$/.test(binaryPath);

/** CLI 를 돌려 stdout 을 돌려준다. 실패하면 null (호출자가 내장 목록으로 떨어진다). */
async function runText(binaryPath: string, args: string[], timeoutMs: number): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)(
      isScript(binaryPath) ? process.execPath : binaryPath,
      isScript(binaryPath) ? [binaryPath, ...args] : args,
      // **반드시 저장소 밖에서 돌린다.** 조회 명령이라도 CLI 가 cwd 에 파일을 쓸 수 있다
      // (2026-09-21: 테스트용 가짜 agy 가 `models` 를 실행 모드로 보고 src/add.js 를 만들었다).
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, cwd: os.tmpdir() }
    );
    return stdout;
  } catch {
    return null;
  }
}

const titleCase = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

/**
 * Claude Code: 모델 목록 명령이 없다. `--help` 의 `--model` 설명에 최신 별칭이
 * 예시로 적혀 있어 그것을 읽는다 (2026-09-21 실측: 'fable', 'opus', 'sonnet').
 * 전체 이름(`claude-fable-5`)은 하이픈이 있어 별칭 패턴에서 빠진다.
 */
export async function claudeCodeModels(binaryPath: string): Promise<AgentModels> {
  const help = await runText(binaryPath, ['--help'], 10_000);
  const modelBlock = help?.match(/--model <model>[\s\S]{0,500}/)?.[0] ?? '';
  const aliases = [...new Set([...modelBlock.matchAll(/'([a-z][a-z0-9]{2,15})'/g)].map((m) => m[1]))];
  // `--effort <level>  Effort level for the current session (low, medium, high, xhigh, max)`
  const effortBlock = help?.match(/--effort <level>[\s\S]{0,300}/)?.[0] ?? '';
  const efforts = parseEffortList(effortBlock);
  // 기본값은 러너가 model 없이 실행할 때 쓰는 값과 같아야 한다 (claude-code/runner.ts).
  const defaultModel = 'sonnet';
  const names = aliases.length >= 2 ? aliases : ['opus', 'sonnet', 'haiku'];
  const source: AgentModels['source'] = aliases.length >= 2 ? 'cli' : 'builtin';
  if (!names.includes(defaultModel)) names.unshift(defaultModel);
  return { models: expandByEffort(names.map((id) => ({ id, label: titleCase(id) })), efforts), defaultModel, source };
}

/** `(low, medium, high, xhigh, max)` 같은 괄호 목록에서 강도 이름만 꺼낸다. */
function parseEffortList(text: string): string[] {
  const inside = text.match(/\(([^)]*\blow\b[^)]*)\)/i)?.[1] ?? '';
  return [...new Set(inside.split(/[,|]/).map((x) => x.trim().toLowerCase()).filter((x) => /^[a-z]{3,8}$/.test(x)))];
}

/** 모델 목록을 강도별 항목으로 펼친다. 강도가 없으면 그대로 둔다. */
function expandByEffort(
  models: Array<{ id: string; label: string }>,
  efforts: string[],
): AgentModels['models'] {
  if (!efforts.length) return models;
  const out: AgentModels['models'] = [];
  for (const m of models)
    for (const effort of efforts)
      out.push({ id: `${m.id}:${effort}`, label: `${m.label} (${effort})`, group: m.label, effort });
  return out;
}

/**
 * Codex: `codex debug models` 가 **현재 계정 기준** 카탈로그를 JSON 으로 준다
 * (2026-09-21 실측: 7종 중 visibility=list 5종, 0.02초).
 *
 * `--bundled` 는 CLI 에 내장된 목록이라 더 많지만 **계정에서 못 쓰는 모델이 섞인다.**
 * 고를 수 있는 것만 보여 주는 게 목적이므로 계정 카탈로그만 쓴다. 조회가 실패하면
 * (로그인 안 됨 등) 설정 파일의 기본값 한 줄로 떨어진다.
 *
 * 출력에는 모델 내부 instruction 같은 긴 필드가 함께 들어 있다(실측 346KB).
 * **slug·display_name 만 꺼내 쓰고 원문은 로그에 남기지 않는다.**
 */
export async function codexModels(binaryPath = 'codex', home = os.homedir()): Promise<AgentModels> {
  const configDefault = readCodexConfigModel(home);
  const raw = await runText(binaryPath, ['debug', 'models'], 15_000);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { models?: Array<Record<string, unknown>> };
      const listed = (parsed.models ?? []).filter(
        (m) => m.visibility === 'list' && typeof m.slug === 'string' && m.slug,
      );
      // Codex 는 같은 모델을 추론 강도(low…ultra)별로 다르게 돌린다. 강도를 안 고르면
      // 모델의 기본값으로 도는데, 그 차이가 결과 품질을 크게 가른다. 그래서 모델 하나를
      // 강도별 항목으로 펼쳐 `<slug>:<effort>` 로 싣는다 (러너가 다시 쪼갠다).
      const models: AgentModels['models'] = [];
      for (const m of listed) {
        const slug = String(m.slug);
        const display = String(m.display_name ?? slug);
        const levels = Array.isArray(m.supported_reasoning_levels)
          ? (m.supported_reasoning_levels as Array<Record<string, unknown>>)
              .map((lv) => String(lv.effort ?? ''))
              .filter(Boolean)
          : [];
        if (!levels.length) {
          models.push({ id: slug, label: display });
          continue;
        }
        const own = typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : null;
        for (const effort of levels) {
          models.push({
            id: `${slug}:${effort}`,
            label: `${display} (${effort}${effort === own ? ', 모델 기본' : ''})`,
            group: display,
            effort,
          });
        }
      }
      if (models.length) {
        // 사람이 config.toml 에 적어 둔 값이 우선이다. 없으면 priority 가 가장 앞선 것.
        const byPriority = [...listed].sort(
          (a, b) => Number(a.priority ?? 1e9) - Number(b.priority ?? 1e9),
        )[0];
        const withOwnEffort = (m: Record<string, unknown> | undefined) => {
          if (!m?.slug) return null;
          const own = typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : null;
          return own ? `${String(m.slug)}:${own}` : String(m.slug);
        };
        const configEntry = configDefault
          ? (models.find((x) => x.id === configDefault)?.id ??
            withOwnEffort(listed.find((m) => String(m.slug) === configDefault)))
          : null;
        const defaultModel = configEntry ?? withOwnEffort(byPriority) ?? models[0].id;
        return { models, defaultModel, source: 'cli' };
      }
    } catch {
      // JSON 이 아니면 아래 설정 파일 경로로 떨어진다
    }
  }
  if (configDefault) {
    return {
      models: [{ id: configDefault, label: `${configDefault} (설정 파일)` }],
      defaultModel: configDefault,
      source: 'config',
    };
  }
  return { models: [], defaultModel: null, source: 'builtin' };
}

function readCodexConfigModel(home: string): string | null {
  try {
    const text = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
    return text.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Antigravity: `agy models` 가 `<id>\t<label>` 로 전체 목록을 준다.
 * **다만 네트워크를 타서 느리다(2026-09-21 실측 33초).** 호출자는 등록을 막지 말고
 * 백그라운드로 돌려야 한다.
 */
export async function agyModels(binaryPath: string, timeoutMs = 60_000): Promise<AgentModels> {
  const out = await runText(binaryPath, ['models'], timeoutMs);
  if (!out) return { models: [], defaultModel: null, source: 'builtin' };
  const models = out
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((cols) => cols.length >= 2 && cols[0].trim() && !cols[0].includes(' '))
    .map((cols) => {
      const id = cols[0].trim();
      const label = cols[1].trim();
      // `Gemini 3.8 Flash (High)` 처럼 CLI 가 이미 모델과 변형을 나눠 적어 준다.
      // agy 는 --model 슬러그에 변형이 들어 있어 --effort 를 따로 주지 않는다.
      const m = label.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
      return m ? { id, label, group: m[1].trim(), effort: m[2].trim().toLowerCase() } : { id, label };
    });
  if (!models.length) return { models: [], defaultModel: null, source: 'builtin' };
  return { models, defaultModel: models[0].id, source: 'cli' };
}
