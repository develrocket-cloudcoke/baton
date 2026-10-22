import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { UsersController } from './users/users.controller';

// 2026-09-22: 비활성(DISABLED) Agent 및 관련 Project API 응답 누적 방지 테스트
// 앱 재설치나 재-pairing 시 예전 Agent 가 DISABLED 로 남는데,
// GET /v1/agents 응답에 기본적으로 실려 나가지 않도록 걸러야 한다.

test("GET /v1/agents 는 기본적으로 DISABLED 상태인 Agent 를 제외하고 반환한다", async () => {
  let capturedWhere: any = null;

  const mockPrisma: any = {
    device: {
      findMany: async () => [],
    },
    agent: {
      updateMany: async () => ({ count: 0 }),
      findMany: async (args: any) => {
        capturedWhere = args.where;
        const allAgents = [
          { id: 'agt_online', status: 'ONLINE', ownerUserId: 'usr_1', provider: 'CLAUDE_CODE', capabilities: {} },
          { id: 'agt_offline', status: 'OFFLINE', ownerUserId: 'usr_1', provider: 'CODEX', capabilities: {} },
          { id: 'agt_disabled', status: 'DISABLED', ownerUserId: 'usr_1', provider: 'AGY', capabilities: {} },
        ];
        // where 조건 시뮬레이션
        return allAgents.filter((a) => {
          if (args.where.status?.not && a.status === args.where.status.not) return false;
          return true;
        });
      },
    },
    $transaction: async (fn: any) => (typeof fn === 'function' ? fn(mockPrisma) : fn),
  };

  const mockAuth: any = {
    current: async () => ({ sub: 'usr_1' }),
  };

  const controller = new UsersController(mockAuth, mockPrisma);
  const result = await controller.agents('Bearer token');

  // 기본 조회 시 status: { not: 'DISABLED' } 조건이 where 에 들어가야 한다
  assert.deepEqual(capturedWhere.status, { not: 'DISABLED' });
  assert.equal(result.length, 2);
  assert.ok(result.every((a) => a.status !== 'DISABLED'));
});

test("GET /v1/agents?includeDisabled=true 시 DISABLED 상태인 Agent 도 포함하여 반환한다", async () => {
  let capturedWhere: any = null;

  const mockPrisma: any = {
    device: {
      findMany: async () => [],
    },
    agent: {
      updateMany: async () => ({ count: 0 }),
      findMany: async (args: any) => {
        capturedWhere = args.where;
        return [
          { id: 'agt_online', status: 'ONLINE', ownerUserId: 'usr_1', provider: 'CLAUDE_CODE', capabilities: {} },
          { id: 'agt_disabled', status: 'DISABLED', ownerUserId: 'usr_1', provider: 'AGY', capabilities: {} },
        ];
      },
    },
    $transaction: async (fn: any) => (typeof fn === 'function' ? fn(mockPrisma) : fn),
  };

  const mockAuth: any = {
    current: async () => ({ sub: 'usr_1' }),
  };

  const controller = new UsersController(mockAuth, mockPrisma);
  const result = await controller.agents('Bearer token', 'true');

  // includeDisabled=true 시 status 필터가 걸리지 않아야 한다 (모두 포함)
  assert.equal(capturedWhere.status, undefined);
  assert.equal(result.length, 2);
  assert.ok(result.some((a) => a.status === 'DISABLED'));
});

test("GET /v1/projects 는 기본적으로 ACTIVE 및 agent.status != DISABLED 조건으로 필터링한다", async () => {
  let capturedWhere: any = null;

  const mockPrisma: any = {
    project: {
      findMany: async (args: any) => {
        capturedWhere = args.where;
        return [];
      },
    },
  };

  const mockAuth: any = {
    current: async () => ({ sub: 'usr_1' }),
  };

  const controller = new UsersController(mockAuth, mockPrisma);
  await controller.projects('Bearer token');

  // 기본 조회 시 ACTIVE 상태이고 agent.status != DISABLED 인 프로젝트만 조회
  assert.equal(capturedWhere.ownerUserId, 'usr_1');
  assert.equal(capturedWhere.status, 'ACTIVE');
  assert.deepEqual(capturedWhere.agent, { status: { not: 'DISABLED' } });
});

test("GET /v1/projects 는 includeDisabled 및 agentId 파라미터를 올바르게 반영한다", async () => {
  let capturedWhere: any = null;

  const mockPrisma: any = {
    project: {
      findMany: async (args: any) => {
        capturedWhere = args.where;
        return [];
      },
    },
  };

  const mockAuth: any = {
    current: async () => ({ sub: 'usr_1' }),
  };

  const controller = new UsersController(mockAuth, mockPrisma);
  await controller.projects('Bearer token', 'true', 'agt_specific_123');

  // includeDisabled=true 시 ACTIVE/agent 필터가 해제되고 agentId 가 추가됨
  assert.equal(capturedWhere.ownerUserId, 'usr_1');
  assert.equal(capturedWhere.status, undefined);
  assert.equal(capturedWhere.agent, undefined);
  assert.equal(capturedWhere.agentId, 'agt_specific_123');
});

test("users.controller.ts 소스 코드에 includeDisabled 데코레이터와 필터가 명시되어 있다", () => {
  const code = readFileSync(path.join(__dirname, 'users/users.controller.ts'), 'utf8');
  assert.ok(code.includes("@Query('includeDisabled') includeDisabled?: string"));
  assert.ok(code.includes("showDisabled ? {} : { status: { not: 'DISABLED' } }"));
});
