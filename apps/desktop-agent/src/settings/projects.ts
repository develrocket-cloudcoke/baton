import path from 'node:path';
import { z } from 'zod';
import { logger } from '../util/log';

// 04 §11.1 설정 키 `projects`: 프로젝트 목록. 셸 UserDefaults 에 JSON 문자열로 저장되고,
// 데몬이 서버에 Project 로 등록한 뒤 projectId 를 채워 다시 저장한다 (projectId → 로컬 경로 매핑).
//
// 서버의 Project 는 Agent 소속이다(schema.prisma). 한 디바이스가 provider 마다 Agent 를
// 하나씩 등록하므로, 같은 로컬 경로라도 provider 마다 Project 가 따로 생긴다 →
// projectId 하나가 아니라 provider → projectId 맵으로 들고 있는다.
export const ProjectEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  // 구버전(디바이스당 provider 1개) 설정. 읽기만 하고 다시 쓰지 않는다.
  projectId: z.string().nullable().optional(),
  projectIds: z.record(z.string(), z.string().nullable()).optional()
});
export type ProjectEntryInput = z.infer<typeof ProjectEntrySchema>;
export interface ProjectEntry {
  name: string;
  path: string;
  projectIds: Record<string, string | null>;
}

// settings.projects 는 JSON 문자열(셸) 또는 배열(콘솔 모드 config.json) 둘 다 허용한다.
function rawList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      logger.warn('설정 projects 가 JSON 배열이 아님 — 빈 목록으로 취급');
      return [];
    }
  }
  return [];
}

export function parseProjects(settings: Record<string, unknown>): ProjectEntry[] {
  // 구버전 항목의 projectId 는 그때 등록돼 있던 provider 것이다. 그 provider 자리에 옮겨 둔다.
  const legacyProvider =
    typeof settings.agentProvider === 'string' && settings.agentProvider ? settings.agentProvider : 'CLAUDE_CODE';
  const out: ProjectEntry[] = [];
  const seen = new Set<string>();
  for (const item of rawList(settings.projects)) {
    const parsed = ProjectEntrySchema.safeParse(item);
    if (!parsed.success) {
      logger.warn('설정 projects 항목 오류 — 건너뜀', { issues: parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message) });
      continue;
    }
    const projectIds: Record<string, string | null> = { ...(parsed.data.projectIds ?? {}) };
    if (parsed.data.projectId && !projectIds[legacyProvider]) projectIds[legacyProvider] = parsed.data.projectId;
    const entry: ProjectEntry = { name: parsed.data.name.trim(), path: path.resolve(parsed.data.path.trim()), projectIds };
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    out.push(entry);
  }
  return out;
}

export function serializeProjects(list: ProjectEntry[]): string {
  return JSON.stringify(list.map((e) => ({ name: e.name, path: e.path, projectIds: e.projectIds })));
}

/** provider 가 이 경로를 서버에 등록해 둔 Project id */
export function projectIdFor(entry: ProjectEntry, provider: string): string | null {
  return entry.projectIds[provider] ?? null;
}

/** 실행 명령의 projectId 는 어느 provider 의 것이든 같은 로컬 경로를 가리킨다. */
export function findByProjectId(list: ProjectEntry[], projectId: string | null | undefined): ProjectEntry | null {
  if (!projectId) return null;
  return list.find((e) => Object.values(e.projectIds).includes(projectId)) ?? null;
}

/** 아직 서버에 등록되지 않은 (provider, 경로) 조합이 있는지 */
export function needsRegistration(list: ProjectEntry[], providers: string[]): boolean {
  return list.some((entry) => providers.some((p) => !entry.projectIds[p]));
}
