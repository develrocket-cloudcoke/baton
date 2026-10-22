import {
  RequestState,
  TimelineEventType,
  User,
  Team,
  Agent,
  Project,
  RequestRevision,
  Document,
  DocumentVersion,
  Artifact,
  Execution,
  Result,
  TimelineEvent,
  RequestEntity,
  CreateRequestDto,
  ResendRequestDto,
  CreateExecutionDto,
  DEFAULT_STRUCTURED_POLICY,
  ExecutionProgressPhase,
  Organization,
  OrgRole,
  TeamRole,
  TeamMembershipDetail,
  TeamWithMembers,
  TeamLink,
  DeviceInfo,
  PairingCodeResponse,
  UserMeResponse,
  RecipientsResponse,
} from './types';
import {
  effectiveAgentCapabilities,
  unenforceableProtections,
  acknowledgementMatches,
} from '@baton/shared';

/**
 * 05 §2.1 및 태스크 요구사항 Seed 데이터
 */
export const SEED_ORG: Organization = {
  id: 'org_example_id',
  name: 'example',
  slug: 'example',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};

export const SEED_USERS: User[] = [
  {
    id: 'user_admin_id',
    email: 'admin@baton.local',
    displayName: '관리자 (Admin)',
    status: 'ACTIVE',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  },
  {
    id: 'user_a_id',
    email: 'a@example.com',
    displayName: '김백엔드 (A)',
    status: 'ACTIVE',
    createdAt: new Date('2026-09-04T00:00:00Z'),
    updatedAt: new Date('2026-09-04T00:00:00Z'),
  },
  {
    id: 'user_b_id',
    email: 'b@example.com',
    displayName: '박인프라 (B)',
    status: 'ACTIVE',
    createdAt: new Date('2026-09-04T00:00:00Z'),
    updatedAt: new Date('2026-09-04T00:00:00Z'),
  },
  {
    id: 'user_c_id',
    email: 'c@example.com',
    displayName: '이인프라 (C)',
    status: 'ACTIVE',
    createdAt: new Date('2026-09-04T00:00:00Z'),
    updatedAt: new Date('2026-09-04T00:00:00Z'),
  },
  {
    id: 'user_d_id',
    email: 'd@example.com',
    displayName: '최QA (D)',
    status: 'ACTIVE',
    createdAt: new Date('2026-09-04T00:00:00Z'),
    updatedAt: new Date('2026-09-04T00:00:00Z'),
  },
];

export const SEED_USER_ORG_ROLES: Record<string, OrgRole> = {
  user_admin_id: 'ORG_ADMIN',
  user_a_id: 'MEMBER',
  user_b_id: 'MEMBER',
  user_c_id: 'MEMBER',
  user_d_id: 'MEMBER',
};

export const SEED_TEAMS: Array<Team & { orgId: string }> = [
  {
    id: 'team_backend_id',
    orgId: 'org_example_id',
    name: 'backend',
    createdByUserId: 'user_a_id',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  },
  {
    id: 'team_infra_id',
    orgId: 'org_example_id',
    name: 'infra',
    createdByUserId: 'user_b_id',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  },
  {
    id: 'team_qa_id',
    orgId: 'org_example_id',
    name: 'qa',
    createdByUserId: 'user_d_id',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  },
];

export const SEED_TEAM_MEMBERSHIPS: TeamMembershipDetail[] = [
  {
    id: 'tm_backend_a',
    teamId: 'team_backend_id',
    userId: 'user_a_id',
    role: 'TEAM_LEAD',
    createdAt: '2026-09-01T00:00:00Z',
    user: SEED_USERS[1],
  },
  {
    id: 'tm_infra_b',
    teamId: 'team_infra_id',
    userId: 'user_b_id',
    role: 'TEAM_LEAD',
    createdAt: '2026-09-01T00:00:00Z',
    user: SEED_USERS[2],
  },
  {
    id: 'tm_infra_c',
    teamId: 'team_infra_id',
    userId: 'user_c_id',
    role: 'MEMBER',
    createdAt: '2026-09-01T00:00:00Z',
    user: SEED_USERS[3],
  },
  {
    id: 'tm_qa_d',
    teamId: 'team_qa_id',
    userId: 'user_d_id',
    role: 'TEAM_LEAD',
    createdAt: '2026-09-01T00:00:00Z',
    user: SEED_USERS[4],
  },
];

export const SEED_TEAM_LINKS: TeamLink[] = [
  {
    id: 'link_backend_to_infra',
    fromTeamId: 'team_backend_id',
    toTeamId: 'team_infra_id',
    createdAt: '2026-09-01T00:00:00Z',
  },
  {
    id: 'link_infra_to_backend',
    fromTeamId: 'team_infra_id',
    toTeamId: 'team_backend_id',
    createdAt: '2026-09-01T00:00:00Z',
  },
];

export const SEED_DEVICES: Array<DeviceInfo & { userId: string }> = [
  {
    id: 'dev_b_mac_01',
    userId: 'user_b_id',
    name: '박인프라 MacBook Pro (M3)',
    deviceFingerprint: 'fp_b_mac_m3_9281',
    platform: 'darwin',
    osVersion: 'macOS 15.0 (Sequoia)',
    appVersion: 'v0.2.0',
    status: 'ONLINE',
    lastSeenAt: new Date().toISOString(),
    createdAt: '2026-09-04T00:00:00Z',
  },
  {
    id: 'dev_b_mac_old',
    userId: 'user_b_id',
    name: '박인프라 이전 Mac mini (Intel)',
    deviceFingerprint: 'fp_b_mac_mini_1029',
    platform: 'darwin',
    osVersion: 'macOS 14.5 (Sonoma)',
    appVersion: 'v0.1.0',
    status: 'OFFLINE',
    lastSeenAt: '2026-08-15T14:20:00Z',
    createdAt: '2026-08-01T00:00:00Z',
  },
  {
    id: 'dev_b_seed_03',
    userId: 'user_b_id',
    name: 'B Desktop (Seed)',
    deviceFingerprint: 'fp_seed_dev_b_desktop',
    platform: 'darwin',
    status: 'OFFLINE',
    lastSeenAt: null,
    createdAt: '2026-09-01T00:00:00Z',
  },
  {
    id: 'dev_a_mac_01',
    userId: 'user_a_id',
    name: '김백엔드 Mac Studio (M2 Max)',
    deviceFingerprint: 'fp_a_mac_studio_3810',
    platform: 'darwin',
    osVersion: 'macOS 15.0 (Sequoia)',
    appVersion: 'v0.2.0',
    status: 'ONLINE',
    lastSeenAt: new Date().toISOString(),
    createdAt: '2026-09-04T00:00:00Z',
  },
  {
    id: 'dev_a_seed_02',
    userId: 'user_a_id',
    name: 'A Desktop (Seed)',
    deviceFingerprint: 'fp_seed_dev_a_desktop',
    platform: 'darwin',
    status: 'OFFLINE',
    lastSeenAt: null,
    createdAt: '2026-09-01T00:00:00Z',
  },
];

export const SEED_AGENT: Agent = {
  id: 'agent_b_id',
  ownerUserId: 'user_b_id',
  deviceId: 'dev_b_mac_01',
  provider: 'CLAUDE_CODE',
  displayName: 'Claude Code (Max)',
  status: 'ONLINE',
  capabilities: {
    supportsResume: true,
    supportsStructuredProgress: true,
    supportsCancel: true,
    supportsLayer1Patch: true,
    securityTier: 'tier_a_hardened',
    supportedPolicyEnforcements: {
      toolDeny: true,
      networkDeny: true,
      destructiveCommandDeny: true,
      credentialPathDeny: true,
    },
  },
  lastSeenAt: new Date(),
  createdAt: new Date('2026-09-04T00:00:00Z'),
  updatedAt: new Date('2026-09-04T00:00:00Z'),
};

export const SEED_AGENTS: Agent[] = [
  SEED_AGENT,
  {
    id: 'agent_codex_id',
    ownerUserId: 'user_b_id',
    deviceId: 'dev_b_mac_01',
    provider: 'CODEX',
    displayName: 'OpenAI Codex (Sandboxed)',
    status: 'ONLINE',
    capabilities: {
      supportsResume: false,
      supportsStructuredProgress: true,
      supportsCancel: true,
      supportsLayer1Patch: true,
      securityTier: 'tier_b_sandboxed',
      supportedPolicyEnforcements: {
        toolDeny: false,
        networkDeny: true,
        destructiveCommandDeny: false,
        credentialPathDeny: false,
      },
    },
    lastSeenAt: new Date(),
    createdAt: new Date('2026-09-04T00:00:00Z'),
    updatedAt: new Date('2026-09-04T00:00:00Z'),
  },
  {
    id: 'agent_agy_id',
    ownerUserId: 'user_b_id',
    deviceId: 'dev_b_mac_01',
    provider: 'AGY',
    displayName: 'Antigravity CLI (Local)',
    status: 'ONLINE',
    capabilities: {
      supportsResume: true,
      supportsStructuredProgress: true,
      supportsCancel: true,
      supportsLayer1Patch: false,
      securityTier: 'tier_b_sandboxed',
      supportedPolicyEnforcements: {
        toolDeny: false,
        networkDeny: false,
        destructiveCommandDeny: false,
        credentialPathDeny: false,
      },
    },
    lastSeenAt: new Date(),
    createdAt: new Date('2026-09-04T00:00:00Z'),
    updatedAt: new Date('2026-09-04T00:00:00Z'),
  },
];

export const SEED_PROJECT: Project = {
  id: 'proj_backend_id',
  ownerUserId: 'user_b_id',
  agentId: 'agent_b_id',
  displayName: 'backend-api',
  localPathHint: '/tmp/baton-test-fixtures/backend-api',
  status: 'ACTIVE',
  createdAt: new Date('2026-09-04T00:00:00Z'),
  updatedAt: new Date('2026-09-04T00:00:00Z'),
};

export const SEED_PROJECTS: Project[] = [
  SEED_PROJECT,
  {
    id: 'proj_codex_id',
    ownerUserId: 'user_b_id',
    agentId: 'agent_codex_id',
    displayName: 'backend-api (Codex)',
    localPathHint: '/tmp/baton-test-fixtures/backend-api',
    status: 'ACTIVE',
    createdAt: new Date('2026-09-04T00:00:00Z'),
    updatedAt: new Date('2026-09-04T00:00:00Z'),
  },
  {
    id: 'proj_agy_id',
    ownerUserId: 'user_b_id',
    agentId: 'agent_agy_id',
    displayName: 'backend-api (AGY)',
    localPathHint: '/tmp/baton-test-fixtures/backend-api',
    status: 'ACTIVE',
    createdAt: new Date('2026-09-04T00:00:00Z'),
    updatedAt: new Date('2026-09-04T00:00:00Z'),
  },
];

/**
 * 인메모리 저장소
 */
class MockDatabase {
  org: Organization = { ...SEED_ORG };
  users: User[] = [...SEED_USERS];
  userOrgRoles: Record<string, OrgRole> = { ...SEED_USER_ORG_ROLES };
  teams: Array<Team & { orgId: string }> = [...SEED_TEAMS];
  teamMemberships: TeamMembershipDetail[] = [...SEED_TEAM_MEMBERSHIPS];
  teamLinks: TeamLink[] = [...SEED_TEAM_LINKS];
  devices: Array<DeviceInfo & { userId: string }> = [...SEED_DEVICES];
  pairingCodes: Map<string, { code: string; expiresAt: string; userId: string }> = new Map();

  agents: Agent[] = [...SEED_AGENTS];
  projects: Project[] = [...SEED_PROJECTS];

  requests: RequestEntity[] = [];
  revisions: RequestRevision[] = [];
  documents: Document[] = [];
  documentVersions: DocumentVersion[] = [];
  artifacts: Artifact[] = [];
  executions: Execution[] = [];
  results: Result[] = [];
  timelineEvents: TimelineEvent[] = [];

  executionPhases: Map<
    string,
    { phase: ExecutionProgressPhase; message: string; stepIndex: number }
  > = new Map();

  constructor() {
    this.seedInitialData();
  }

  reset() {
    this.org = { ...SEED_ORG };
    this.users = [...SEED_USERS];
    this.userOrgRoles = { ...SEED_USER_ORG_ROLES };
    this.teams = [...SEED_TEAMS];
    this.teamMemberships = [...SEED_TEAM_MEMBERSHIPS];
    this.teamLinks = [...SEED_TEAM_LINKS];
    this.devices = [...SEED_DEVICES];
    this.pairingCodes.clear();

    this.agents = [...SEED_AGENTS];
    this.projects = [...SEED_PROJECTS];
    this.requests = [];
    this.revisions = [];
    this.documents = [];
    this.documentVersions = [];
    this.artifacts = [];
    this.executions = [];
    this.results = [];
    this.timelineEvents = [];
    this.executionPhases.clear();

    this.seedInitialData();
  }

  seedInitialData() {
    // 1. 기존 샘플 1: §33의 Redis 오류 해결 요청 (DELIVERED 상태, 개인 지정)
    const req1Id = 'req_sample_redis_01';
    const rev1Id = 'rev_sample_01';
    const doc1Id = 'doc_analysis_01';
    const docVer1Id = 'docver_analysis_01';
    const art1Id = 'art_server_log_01';

    const req1: RequestEntity = {
      id: req1Id,
      teamId: 'team_backend_id',
      senderTeamId: 'team_backend_id',
      recipientTeamId: 'team_infra_id',
      senderUserId: 'user_a_id',
      recipientUserId: 'user_b_id',
      title: '로그인 API 오류 해결 요청',
      state: RequestState.DELIVERED,
      currentRevisionNo: 1,
      currentRevisionId: rev1Id,
      returnReason: null,
      claimedAt: new Date(Date.now() - 3000 * 1000).toISOString(),
      acceptedAt: null,
      completedAt: null,
      createdAt: new Date(Date.now() - 3600 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 3000 * 1000).toISOString(),
    };

    const doc1: Document = {
      id: doc1Id,
      teamId: 'team_backend_id',
      ownerUserId: 'user_a_id',
      name: 'api-error-analysis.md',
      mimeType: 'text/markdown',
      currentVersionId: 'docver_sample_02',
      createdAt: new Date(Date.now() - 3600 * 1000),
      updatedAt: new Date(Date.now() - 1800 * 1000),
    };

    const docVer1: DocumentVersion = {
      id: docVer1Id,
      documentId: doc1Id,
      versionNo: 1,
      contentRef: `## 로그인 API 500 오류 원인 분석

### 1. 현상 요약
- 사용자 로그인 요청 시 간헐적으로 500 Internal Server Error 발생.
- 에러 로그: \`RedisConnectionException: redis-servcie: Name or service not known\`

### 2. 원인 추정
- Kubernetes \`deployment.yaml\` 내 \`REDIS_HOST\` 환경변수에 오타(\`redis-servcie\`)가 주입된 것으로 확인됨.

### 3. 인프라팀 협조 요청
- 배포 매니페스트 설정을 확인하고 \`redis-service\`로 수정안 작성 및 테스트 실행 부탁드립니다.
- **주의**: 운영 환경에 직접 배포하지 마시고, 설정 파일 및 테스트 스크립트(\`verify.sh\`) 검증 결과만 작성해주세요.`,
      contentSha256: 'abc123sha256fake',
      createdByType: 'HUMAN',
      createdByUserId: 'user_a_id',
      createdByAgentId: null,
      changeNote: '초기 작성 원본',
      createdAt: new Date(Date.now() - 3600 * 1000),
      updatedAt: new Date(Date.now() - 3600 * 1000),
    };

    const docVer2Id = 'docver_sample_02';
    const docVer2: DocumentVersion = {
      id: docVer2Id,
      documentId: doc1Id,
      versionNo: 2,
      contentRef: `## 로그인 API 500 오류 원인 분석 (v2 보완본)

### 1. 현상 요약
- 사용자 로그인 요청 시 간헐적으로 500 Internal Server Error 지속 발생.
- 에러 로그: \`RedisConnectionException: redis-servcie: Name or service not known\`
- 보완 사항: 실서버 로그(\`server.log\`) 첨부 및 네트워크 설정 확인 추가.

### 2. 원인 추정 및 추가 분석
- Kubernetes \`deployment.yaml\` 내 \`REDIS_HOST\` 환경변수에 오타(\`redis-servcie\`)가 주입된 것으로 확인됨.
- \`config/redis.conf\` 파일의 connection timeout 설정(기존 300초 -> 0 즉시 연결 유지)도 함께 점검 필요.

### 3. 인프라팀 협조 요청
- 배포 매니페스트 설정을 확인하고 \`redis-service\`로 수정안 작성 및 테스트 실행 부탁드립니다.
- **주의**: 운영 환경에 직접 배포하지 마시고, 설정 파일 및 테스트 스크립트(\`verify.sh\`) 검증 결과만 작성해주세요.`,
      contentSha256: 'def456sha256fake',
      createdByType: 'HUMAN',
      createdByUserId: 'user_a_id',
      createdByAgentId: null,
      changeNote: '반려 사유 보완 (server.log 첨부 및 redis.conf 점검 항목 추가)',
      createdAt: new Date(Date.now() - 1800 * 1000),
      updatedAt: new Date(Date.now() - 1800 * 1000),
    };

    const art1: Artifact = {
      id: art1Id,
      teamId: 'team_backend_id',
      ownerUserId: 'user_a_id',
      requestId: req1Id,
      kind: 'REQUEST_ATTACHMENT',
      filename: 'server.log',
      mimeType: 'text/plain',
      storageRef: 's3://baton-artifacts/sample/server.log',
      sha256: 'logsha256fake',
      sizeBytes: 4096,
      createdAt: new Date(Date.now() - 3500 * 1000),
      updatedAt: new Date(Date.now() - 3500 * 1000),
    };

    const rev1: RequestRevision = {
      id: rev1Id,
      requestId: req1Id,
      revisionNo: 1,
      originalInstruction:
        '로그인 API 500 오류를 분석한 문서를 첨부합니다. Kubernetes deployment 설정을 확인하고 오타를 수정해주세요.',
      documentVersionIds: [docVer1Id, docVer2Id],
      artifactIds: [art1Id],
      createdByUserId: 'user_a_id',
      sentAt: new Date(Date.now() - 3000 * 1000),
      createdAt: new Date(Date.now() - 3600 * 1000),
      updatedAt: new Date(Date.now() - 1800 * 1000),
    };

    this.requests.push(req1);
    this.documents.push(doc1);
    this.documentVersions.push(docVer1, docVer2);
    this.artifacts.push(art1);
    this.revisions.push(rev1);

    this.timelineEvents.push(
      {
        id: 'evt_1',
        requestId: req1Id,
        requestRevisionId: rev1Id,
        executionId: null,
        actorType: 'HUMAN',
        actorUserId: 'user_a_id',
        agentId: null,
        eventType: TimelineEventType.REQUEST_CREATED,
        occurredAt: new Date(Date.now() - 3600 * 1000),
        payload: { title: req1.title },
      },
      {
        id: 'evt_2',
        requestId: req1Id,
        requestRevisionId: rev1Id,
        executionId: null,
        actorType: 'HUMAN',
        actorUserId: 'user_a_id',
        agentId: null,
        eventType: TimelineEventType.REQUEST_SENT,
        occurredAt: new Date(Date.now() - 3000 * 1000),
        payload: { recipientUserId: 'user_b_id' },
      },
      {
        id: 'evt_3',
        requestId: req1Id,
        requestRevisionId: rev1Id,
        executionId: null,
        actorType: 'SERVER',
        actorUserId: null,
        agentId: null,
        eventType: TimelineEventType.REQUEST_DELIVERED,
        occurredAt: new Date(Date.now() - 2950 * 1000),
        payload: { deviceId: 'dev_b_mac_01' },
      },
    );

    // 2. 태스크 요구: 팀 뿌리기 요청 1건 사전 시딩 (recipientUserId === null, 미확정 상태)
    const reqTeamId = 'req_team_broadcast_01';
    const revTeamId = 'rev_team_broadcast_01';
    const docTeamId = 'doc_staging_redis_01';
    const docVerTeamId = 'docver_staging_redis_01';
    const artTeamId = 'art_staging_dump_01';

    const reqTeam: RequestEntity = {
      id: reqTeamId,
      teamId: 'team_backend_id',
      senderTeamId: 'team_backend_id',
      recipientTeamId: 'team_infra_id',
      senderUserId: 'user_a_id',
      recipientUserId: null, // 미확정 (팀 전체 뿌리기)
      title: '[팀 요청] 스테이징 Redis 클러스터 장애 대응 요청',
      state: RequestState.DELIVERED,
      currentRevisionNo: 1,
      currentRevisionId: revTeamId,
      returnReason: null,
      claimedAt: null,
      isBroadcast: true,
      acceptedAt: null,
      completedAt: null,
      createdAt: new Date(Date.now() - 1800 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 1800 * 1000).toISOString(),
    };

    const docTeam: Document = {
      id: docTeamId,
      teamId: 'team_backend_id',
      ownerUserId: 'user_a_id',
      name: 'staging-redis-incident.md',
      mimeType: 'text/markdown',
      currentVersionId: docVerTeamId,
      createdAt: new Date(Date.now() - 1800 * 1000),
      updatedAt: new Date(Date.now() - 1800 * 1000),
    };

    const docVerTeam: DocumentVersion = {
      id: docVerTeamId,
      documentId: docTeamId,
      versionNo: 1,
      contentRef: `## 스테이징 Redis 클러스터 노드 불일치 긴급 점검

### 1. 현황
- 스테이징 환경 배포 후 Redis Cluster 슬롯 할당 불일치 경고가 다수 발생하고 있습니다.
- 인프라팀 멤버 중 가능한 분이 클러스터 상태 점검 및 페일오버 복구 스크립트를 실행해 주시기 바랍니다.`,
      contentSha256: 'sha256_staging_redis_doc',
      createdByType: 'HUMAN',
      createdByUserId: 'user_a_id',
      createdByAgentId: null,
      changeNote: '팀 요청 생성',
      createdAt: new Date(Date.now() - 1800 * 1000),
      updatedAt: new Date(Date.now() - 1800 * 1000),
    };

    const artTeam: Artifact = {
      id: artTeamId,
      teamId: 'team_backend_id',
      ownerUserId: 'user_a_id',
      requestId: reqTeamId,
      kind: 'REQUEST_ATTACHMENT',
      filename: 'cluster-nodes.dump',
      mimeType: 'text/plain',
      storageRef: 's3://baton-artifacts/sample/cluster-nodes.dump',
      sha256: 'sha256_cluster_dump',
      sizeBytes: 2048,
      createdAt: new Date(Date.now() - 1800 * 1000),
      updatedAt: new Date(Date.now() - 1800 * 1000),
    };

    const revTeam: RequestRevision = {
      id: revTeamId,
      requestId: reqTeamId,
      revisionNo: 1,
      originalInstruction:
        '인프라팀 전체에 전달된 요청입니다. 스테이징 Redis 클러스터 노드 덤프를 확인 후 복구 조치 부탁드립니다.',
      documentVersionIds: [docVerTeamId],
      artifactIds: [artTeamId],
      createdByUserId: 'user_a_id',
      sentAt: new Date(Date.now() - 1800 * 1000),
      createdAt: new Date(Date.now() - 1800 * 1000),
      updatedAt: new Date(Date.now() - 1800 * 1000),
    };

    this.requests.push(reqTeam);
    this.documents.push(docTeam);
    this.documentVersions.push(docVerTeam);
    this.artifacts.push(artTeam);
    this.revisions.push(revTeam);

    this.timelineEvents.push(
      {
        id: 'evt_team_1',
        requestId: reqTeamId,
        requestRevisionId: revTeamId,
        executionId: null,
        actorType: 'HUMAN',
        actorUserId: 'user_a_id',
        agentId: null,
        eventType: TimelineEventType.REQUEST_CREATED,
        occurredAt: new Date(Date.now() - 1800 * 1000),
        payload: { title: reqTeam.title, recipientTeamId: 'team_infra_id', broadcast: true },
      },
      {
        id: 'evt_team_2',
        requestId: reqTeamId,
        requestRevisionId: revTeamId,
        executionId: null,
        actorType: 'HUMAN',
        actorUserId: 'user_a_id',
        agentId: null,
        eventType: TimelineEventType.REQUEST_SENT,
        occurredAt: new Date(Date.now() - 1800 * 1000),
        payload: { recipientTeamId: 'team_infra_id', broadcast: true },
      },
      {
        id: 'evt_team_3',
        requestId: reqTeamId,
        requestRevisionId: revTeamId,
        executionId: null,
        actorType: 'SERVER',
        actorUserId: null,
        agentId: null,
        eventType: TimelineEventType.REQUEST_DELIVERED,
        occurredAt: new Date(Date.now() - 1790 * 1000),
        payload: { recipientTeamId: 'team_infra_id' },
      },
    );

    // 3. 샘플 2: 이미 완료된 요청 (COMPLETED 상태)
    const req2Id = 'req_sample_done_02';
    const rev2Id = 'rev_sample_02';
    const exec2Id = 'exec_sample_02';
    const res2Id = 'res_sample_02';

    const req2: RequestEntity = {
      id: req2Id,
      teamId: 'team_backend_id',
      senderTeamId: 'team_backend_id',
      recipientTeamId: 'team_infra_id',
      senderUserId: 'user_a_id',
      recipientUserId: 'user_b_id',
      title: 'CI 파이프라인 캐시 최적화 검토',
      state: RequestState.COMPLETED,
      currentRevisionNo: 1,
      currentRevisionId: rev2Id,
      returnReason: null,
      claimedAt: new Date(Date.now() - 88000 * 1000).toISOString(),
      acceptedAt: new Date(Date.now() - 86400 * 1000).toISOString(),
      completedAt: new Date(Date.now() - 80000 * 1000).toISOString(),
      createdAt: new Date(Date.now() - 90000 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 80000 * 1000).toISOString(),
    };

    const rev2: RequestRevision = {
      id: rev2Id,
      requestId: req2Id,
      revisionNo: 1,
      originalInstruction: 'GitHub Actions pnpm 캐시 설정을 최적화해 빌드 시간을 단축해주세요.',
      documentVersionIds: [],
      artifactIds: [],
      createdByUserId: 'user_a_id',
      sentAt: new Date(Date.now() - 88000 * 1000),
      createdAt: new Date(Date.now() - 90000 * 1000),
      updatedAt: new Date(Date.now() - 88000 * 1000),
    };

    const exec2: Execution = {
      id: exec2Id,
      requestId: req2Id,
      requestRevisionId: rev2Id,
      executorUserId: 'user_b_id',
      agentId: 'agent_b_id',
      projectId: 'proj_backend_id',
      additionalInstruction: '캐시 키는 pnpm-lock.yaml 해시로 설정해주세요.',
      effectiveInstructionRef: 'eff_inst_02',
      status: 'SUCCEEDED',
      startedAt: new Date(Date.now() - 85000 * 1000),
      finishedAt: new Date(Date.now() - 82000 * 1000),
      failureReason: null,
      createdAt: new Date(Date.now() - 86000 * 1000),
      updatedAt: new Date(Date.now() - 82000 * 1000),
    };

    const res2: Result = {
      id: res2Id,
      executionId: exec2Id,
      summary:
        'GitHub Actions 워크플로에 pnpm store path 캐시 액션을 추가하여 빌드 시간을 45% 단축했습니다.',
      changedFiles: ['.github/workflows/ci.yml'],
      testSummary: '모든 CI 체크 통과 (워크플로 구문 유효성 검증 성공)',
      resultDocumentVersionId: null,
      artifactIds: [],
      reviewStatus: 'APPROVED',
      reviewedByUserId: 'user_b_id',
      reviewedAt: new Date(Date.now() - 80000 * 1000),
      sentAt: new Date(Date.now() - 80000 * 1000),
      createdAt: new Date(Date.now() - 82000 * 1000),
      updatedAt: new Date(Date.now() - 80000 * 1000),
    };

    this.requests.push(req2);
    this.revisions.push(rev2);
    this.executions.push(exec2);
    this.results.push(res2);

    // 4. 샘플 3: 결과 검토 대기 중인 요청 (RESULT_REVIEW 상태, 1차 결과 완료)
    const req3Id = 'req_sample_review_03';
    const rev3Id = 'rev_sample_03';
    const exec3Id = 'exec_sample_03';
    const res3Id = 'res_sample_03';

    const req3: RequestEntity = {
      id: req3Id,
      teamId: 'team_backend_id',
      senderTeamId: 'team_backend_id',
      recipientTeamId: 'team_infra_id',
      senderUserId: 'user_a_id',
      recipientUserId: 'user_b_id',
      title: 'Kubernetes 배포 설정 오류 및 Redis 연결 실패 해결',
      state: RequestState.RESULT_REVIEW,
      currentRevisionNo: 1,
      currentRevisionId: rev3Id,
      returnReason: null,
      claimedAt: new Date(Date.now() - 600 * 1000).toISOString(),
      acceptedAt: new Date(Date.now() - 500 * 1000).toISOString(),
      completedAt: null,
      createdAt: new Date(Date.now() - 800 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 200 * 1000).toISOString(),
    };

    const rev3: RequestRevision = {
      id: rev3Id,
      requestId: req3Id,
      revisionNo: 1,
      originalInstruction:
        'deployment.yaml 의 REDIS_HOST 설정 오류를 수정하고 verify.sh 테스트를 통과시켜주세요.',
      documentVersionIds: [docVer1Id],
      artifactIds: [art1Id],
      createdByUserId: 'user_a_id',
      sentAt: new Date(Date.now() - 700 * 1000),
      createdAt: new Date(Date.now() - 800 * 1000),
      updatedAt: new Date(Date.now() - 700 * 1000),
    };

    const exec3: Execution = {
      id: exec3Id,
      requestId: req3Id,
      requestRevisionId: rev3Id,
      executorUserId: 'user_b_id',
      agentId: 'agent_b_id',
      projectId: 'proj_backend_id',
      additionalInstruction:
        'REDIS_HOST 환경변수 오타를 redis-service로 수정하고 verify.sh 실행 결과를 확인해줘.',
      effectiveInstructionRef: 'eff_inst_03',
      status: 'SUCCEEDED',
      startedAt: new Date(Date.now() - 400 * 1000),
      finishedAt: new Date(Date.now() - 200 * 1000),
      failureReason: null,
      createdAt: new Date(Date.now() - 450 * 1000),
      updatedAt: new Date(Date.now() - 200 * 1000),
    };

    const res3: Result = {
      id: res3Id,
      executionId: exec3Id,
      summary:
        'Kubernetes deployment.yaml 내 REDIS_HOST 오타(redis-servcie -> redis-service) 수정 및 config/redis.conf timeout 설정 최적화 완료',
      changedFiles: ['k8s/deployment.yaml', 'config/redis.conf'],
      testSummary: '테스트 통과 (DEPLOYMENT_VERIFIED_SUCCESS)',
      resultDocumentVersionId: null,
      artifactIds: [],
      reviewStatus: 'PENDING',
      reviewedByUserId: null,
      reviewedAt: null,
      sentAt: null,
      createdAt: new Date(Date.now() - 200 * 1000),
      updatedAt: new Date(Date.now() - 200 * 1000),
    };

    // CLO-11: 부분 결과가 있는 취소 회차와 산출물이 없는 취소 회차를 함께 확인한다.
    this.requests.push({
      ...req3,
      id: 'req_clo11_partial',
      title: '취소된 작업의 부분 변경 확인',
      state: RequestState.READY_TO_RUN,
      currentRevisionId: 'rev_clo11',
    });
    this.revisions.push({
      ...rev3,
      id: 'rev_clo11',
      requestId: 'req_clo11_partial',
      documentVersionIds: [],
      artifactIds: [],
    });
    this.executions.push({
      ...exec3,
      id: 'exec_clo11_partial',
      requestId: 'req_clo11_partial',
      requestRevisionId: 'rev_clo11',
      status: 'CANCELLED',
    });
    this.executions.push({
      ...exec3,
      id: 'exec_clo11_empty',
      requestId: 'req_clo11_partial',
      requestRevisionId: 'rev_clo11',
      status: 'CANCELLED',
      createdAt: new Date(),
    });
    this.results.push({
      ...res3,
      id: 'result_clo11_partial',
      executionId: 'exec_clo11_partial',
      kind: 'PARTIAL',
      summary: 'Redis 호스트 오타를 수정하던 중 실행을 취소했습니다. 테스트는 완료되지 않았습니다.',
      changedFiles: ['deployment.yaml'],
      artifactIds: ['clo11-mock-patch'],
    });
    this.requests.push(req3);
    this.revisions.push(rev3);
    this.executions.push(exec3);
    this.results.push(res3);

    this.timelineEvents.push(
      {
        id: 'evt_rev3_1',
        requestId: req3Id,
        requestRevisionId: rev3Id,
        executionId: null,
        actorType: 'HUMAN',
        actorUserId: 'user_a_id',
        agentId: null,
        eventType: TimelineEventType.REQUEST_CREATED,
        occurredAt: new Date(Date.now() - 800 * 1000),
        payload: { title: req3.title },
      },
      {
        id: 'evt_rev3_2',
        requestId: req3Id,
        requestRevisionId: rev3Id,
        executionId: null,
        actorType: 'HUMAN',
        actorUserId: 'user_a_id',
        agentId: null,
        eventType: TimelineEventType.REQUEST_SENT,
        occurredAt: new Date(Date.now() - 700 * 1000),
        payload: { recipientUserId: 'user_b_id' },
      },
      {
        id: 'evt_rev3_3',
        requestId: req3Id,
        requestRevisionId: rev3Id,
        executionId: null,
        actorType: 'HUMAN',
        actorUserId: 'user_b_id',
        agentId: null,
        eventType: TimelineEventType.REQUEST_ACCEPTED,
        occurredAt: new Date(Date.now() - 500 * 1000),
        payload: {},
      },
      {
        id: 'evt_rev3_4',
        requestId: req3Id,
        requestRevisionId: rev3Id,
        executionId: exec3Id,
        actorType: 'HUMAN',
        actorUserId: 'user_b_id',
        agentId: 'agent_b_id',
        eventType: TimelineEventType.EXECUTION_QUEUED,
        occurredAt: new Date(Date.now() - 450 * 1000),
        payload: { additionalInstruction: exec3.additionalInstruction },
      },
      {
        id: 'evt_rev3_5',
        requestId: req3Id,
        requestRevisionId: rev3Id,
        executionId: exec3Id,
        actorType: 'DESKTOP_AGENT',
        actorUserId: null,
        agentId: 'agent_b_id',
        eventType: TimelineEventType.EXECUTION_STARTED,
        occurredAt: new Date(Date.now() - 400 * 1000),
        payload: {},
      },
      {
        id: 'evt_rev3_6',
        requestId: req3Id,
        requestRevisionId: rev3Id,
        executionId: exec3Id,
        actorType: 'DESKTOP_AGENT',
        actorUserId: null,
        agentId: 'agent_b_id',
        eventType: TimelineEventType.RESULT_CREATED,
        occurredAt: new Date(Date.now() - 200 * 1000),
        payload: { summary: res3.summary, changedFiles: res3.changedFiles },
      },
    );
  }

  // --- 사용자 및 권한 헬퍼 ---
  getUserById(userId: string): User | undefined {
    return this.users.find((u) => u.id === userId);
  }

  getUserOrgRole(userId: string): OrgRole {
    return this.userOrgRoles[userId] || 'MEMBER';
  }

  getUserTeams(userId: string): Array<{ teamId: string; teamName: string; role: TeamRole }> {
    const memberships = this.teamMemberships.filter((tm) => tm.userId === userId);
    return memberships.map((tm) => {
      const team = this.teams.find((t) => t.id === tm.teamId);
      return {
        teamId: tm.teamId || '',
        teamName: team ? team.name : 'Unknown Team',
        role: tm.role,
      };
    });
  }

  getMe(userId = 'user_b_id'): UserMeResponse {
    const user = this.getUserById(userId) || this.users[1];
    const orgRole = this.getUserOrgRole(user.id);
    const userTeams = this.getUserTeams(user.id);
    const teams = userTeams.map((t) => ({
      id: t.teamId,
      name: t.teamName,
      orgId: this.org.id,
      role: t.role,
      teamId: t.teamId,
      teamName: t.teamName,
    }));
    const devices = this.getDevices(user.id);

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      status: user.status || 'ACTIVE',
      user: {
        id: user.id,
        email: user.email,
        name: user.displayName,
        orgRole,
      },
      organization: this.org,
      orgRole,
      teams,
      devices,
    };
  }

  // --- 디바이스 및 페어링 ---
  getDevices(userId: string): DeviceInfo[] {
    return this.devices.filter((d) => d.userId === userId).map(({ userId: _uid, ...dev }) => dev);
  }

  createPairingCode(userId: string): PairingCodeResponse {
    // 8자리 영숫자 생성 (예: 7K9X-M2P4)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
      if (i === 4) code += '-';
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    this.pairingCodes.set(code, { code, expiresAt, userId });

    return {
      code,
      expiresAt,
    };
  }

  deleteDevice(userId: string, deviceId: string): boolean {
    const index = this.devices.findIndex((d) => d.id === deviceId && d.userId === userId);
    if (index === -1) return false;
    this.devices.splice(index, 1);
    return true;
  }

  // --- 조직 및 팀 관리 (ORG_ADMIN 권한) ---
  getOrg(): Organization {
    return this.org;
  }

  getOrgTeams(): TeamWithMembers[] {
    return this.teams.map((t) => {
      const members = this.teamMemberships
        .filter((tm) => tm.teamId === t.id)
        .map((tm) => {
          const user = this.users.find((u) => u.id === tm.userId) || tm.user;
          return {
            ...tm,
            user,
          };
        });
      return {
        ...t,
        membersCount: members.length,
        members,
      };
    });
  }

  createOrgTeam(name: string, creatorUserId = 'user_admin_id'): TeamWithMembers {
    const teamId = `team_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now().toString(36)}`;
    const newTeam: Team & { orgId: string } = {
      id: teamId,
      orgId: this.org.id,
      name,
      createdByUserId: creatorUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.teams.push(newTeam);
    return {
      ...newTeam,
      membersCount: 0,
      members: [],
    };
  }

  updateOrgTeam(teamId: string, name: string): TeamWithMembers {
    const team = this.teams.find((t) => t.id === teamId);
    if (!team) throw new Error('Team not found');
    team.name = name;
    team.updatedAt = new Date();

    const members = this.teamMemberships.filter((tm) => tm.teamId === teamId);
    return {
      ...team,
      membersCount: members.length,
      members,
    };
  }

  deleteOrgTeam(teamId: string): boolean {
    const index = this.teams.findIndex((t) => t.id === teamId);
    if (index === -1) return false;
    this.teams.splice(index, 1);
    this.teamMemberships = this.teamMemberships.filter((tm) => tm.teamId !== teamId);
    this.teamLinks = this.teamLinks.filter(
      (tl) => tl.fromTeamId !== teamId && tl.toTeamId !== teamId,
    );
    return true;
  }

  addTeamMember(teamId: string, userId: string, role: TeamRole = 'MEMBER'): TeamMembershipDetail {
    const user = this.users.find((u) => u.id === userId);
    if (!user) throw new Error('User not found');
    const existing = this.teamMemberships.find(
      (tm) => tm.teamId === teamId && tm.userId === userId,
    );
    if (existing) {
      existing.role = role;
      return existing;
    }
    const newMembership: TeamMembershipDetail = {
      id: `tm_${teamId}_${userId}`,
      teamId,
      userId,
      role,
      createdAt: new Date().toISOString(),
      user,
    };
    this.teamMemberships.push(newMembership);
    return newMembership;
  }

  removeTeamMember(teamId: string, userId: string): boolean {
    const idx = this.teamMemberships.findIndex(
      (tm) => tm.teamId === teamId && tm.userId === userId,
    );
    if (idx === -1) return false;
    this.teamMemberships.splice(idx, 1);
    return true;
  }

  createOrgUser(email: string, name: string, _tempPassword?: string): User {
    const existing = this.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
    if (existing) throw new Error('User email already exists');
    const id = `user_${Date.now().toString(36)}`;
    const newUser: User = {
      id,
      email,
      displayName: name,
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.users.push(newUser);
    this.userOrgRoles[id] = 'MEMBER';
    return newUser;
  }

  // --- 팀 링크 (통신 허용 매트릭스) ---
  getOrgTeamLinks(): TeamLink[] {
    return this.teamLinks.map((tl) => {
      const reverseExists = this.teamLinks.some(
        (l) => l.fromTeamId === tl.toTeamId && l.toTeamId === tl.fromTeamId,
      );
      return {
        ...tl,
        direction: reverseExists ? ('both' as const) : ('a-to-b' as const),
        fromTeam: this.teams.find((t) => t.id === tl.fromTeamId),
        toTeam: this.teams.find((t) => t.id === tl.toTeamId),
      };
    });
  }

  // CLO-18: direction 지원 ('both' | 'a-to-b' | 'b-to-a' | boolean)
  createOrgTeamLink(
    fromTeamId: string,
    toTeamId: string,
    direction: 'both' | 'a-to-b' | 'b-to-a' | boolean = 'both',
  ): TeamLink[] {
    const results: TeamLink[] = [];
    const dir = typeof direction === 'boolean' ? (direction ? 'both' : 'a-to-b') : direction;

    // 기존 두 팀 간 링크 초기화
    this.teamLinks = this.teamLinks.filter(
      (l) =>
        !(
          (l.fromTeamId === fromTeamId && l.toTeamId === toTeamId) ||
          (l.fromTeamId === toTeamId && l.toTeamId === fromTeamId)
        ),
    );

    const now = new Date().toISOString();
    if (dir === 'both') {
      const linkAB: TeamLink = {
        id: `link_${fromTeamId}_to_${toTeamId}`,
        fromTeamId,
        toTeamId,
        createdAt: now,
        direction: 'both',
      };
      const linkBA: TeamLink = {
        id: `link_${toTeamId}_to_${fromTeamId}`,
        fromTeamId: toTeamId,
        toTeamId: fromTeamId,
        createdAt: now,
        direction: 'both',
      };
      this.teamLinks.push(linkAB, linkBA);
      results.push(linkAB, linkBA);
    } else if (dir === 'a-to-b') {
      const linkAB: TeamLink = {
        id: `link_${fromTeamId}_to_${toTeamId}`,
        fromTeamId,
        toTeamId,
        createdAt: now,
        direction: 'a-to-b',
      };
      this.teamLinks.push(linkAB);
      results.push(linkAB);
    } else if (dir === 'b-to-a') {
      const linkBA: TeamLink = {
        id: `link_${toTeamId}_to_${fromTeamId}`,
        fromTeamId: toTeamId,
        toTeamId: fromTeamId,
        createdAt: now,
        direction: 'b-to-a',
      };
      this.teamLinks.push(linkBA);
      results.push(linkBA);
    }
    return results;
  }

  deleteOrgTeamLink(
    linkIdOrFromTeamId: string,
    toTeamId?: string,
    direction: 'both' | 'a-to-b' | 'b-to-a' | boolean = 'both',
  ): boolean {
    const dir = typeof direction === 'boolean' ? (direction ? 'both' : 'a-to-b') : direction;
    if (!toTeamId) {
      const target = this.teamLinks.find((l) => l.id === linkIdOrFromTeamId);
      if (!target) return false;
      this.teamLinks = this.teamLinks.filter((l) => l.id !== linkIdOrFromTeamId);
      return true;
    }

    if (dir === 'both') {
      this.teamLinks = this.teamLinks.filter(
        (l) =>
          !(
            (l.fromTeamId === linkIdOrFromTeamId && l.toTeamId === toTeamId) ||
            (l.fromTeamId === toTeamId && l.toTeamId === linkIdOrFromTeamId)
          ),
      );
    } else if (dir === 'a-to-b') {
      this.teamLinks = this.teamLinks.filter(
        (l) => !(l.fromTeamId === linkIdOrFromTeamId && l.toTeamId === toTeamId),
      );
    } else if (dir === 'b-to-a') {
      this.teamLinks = this.teamLinks.filter(
        (l) => !(l.fromTeamId === toTeamId && l.toTeamId === linkIdOrFromTeamId),
      );
    }
    return true;
  }

  canSendBetweenTeams(fromTeamId: string, toTeamId: string): boolean {
    if (fromTeamId === toTeamId) return true;
    return this.teamLinks.some((l) => l.fromTeamId === fromTeamId && l.toTeamId === toTeamId);
  }

  // --- 수신자 후보 조회 (§4.4) ---
  getRecipients(senderTeamId: string): RecipientsResponse {
    // 통신 허용된 팀: 자기 팀 + TeamLink(from=senderTeamId)의 toTeamId
    const allowedTeamIds = new Set<string>([senderTeamId]);
    for (const link of this.teamLinks) {
      if (link.fromTeamId === senderTeamId) {
        allowedTeamIds.add(link.toTeamId);
      }
    }

    const recipientTeams: any[] = [];
    const usersByTeam: Record<string, any[]> = {};

    for (const teamId of allowedTeamIds) {
      const team = this.teams.find((t) => t.id === teamId);
      if (!team) continue;

      const memberships = this.teamMemberships.filter((tm) => tm.teamId === teamId);
      const members: any[] = [];
      const teamUsers: any[] = [];

      for (const m of memberships) {
        const u = this.users.find((user) => user.id === m.userId) || m.user;
        const hasActiveDevice = this.devices.some(
          (d) => d.userId === u.id && d.status === 'ONLINE',
        );
        members.push({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          hasActiveDevice,
        });
        teamUsers.push({
          id: u.id,
          name: u.displayName,
          displayName: u.displayName,
          email: u.email,
          teamId: team.id,
          teamName: team.name,
          hasActiveDevice,
        });
      }

      recipientTeams.push({
        id: team.id,
        name: team.name,
        memberCount: memberships.length,
        members,
      });
      usersByTeam[team.id] = teamUsers;
    }

    return {
      senderTeamId,
      teams: recipientTeams,
      usersByTeam,
    };
  }

  // --- 요청 조회 메서드 ---
  getRequests(userId?: string): RequestEntity[] {
    const list = this.requests.map((r) => ({
      ...r,
      senderTeam: this.teams.find((t) => t.id === r.senderTeamId),
      recipientTeam: this.teams.find((t) => t.id === r.recipientTeamId),
    }));

    if (!userId) return list;

    const userTeams = this.getUserTeams(userId).map((t) => t.teamId);
    const userRole = this.getUserOrgRole(userId);
    if (userRole === 'ORG_ADMIN') {
      // 관리자는 전체 열람 가능
      return list;
    }

    return list.filter((r) => {
      // 1. 내가 보낸 요청
      if (r.senderUserId === userId) return true;
      // 2. 나에게 개인 지정된 요청
      if (r.recipientUserId === userId) return true;
      // 3. 내가 속한 팀으로 온 팀 전체 뿌리기 요청 (recipientUserId === null)
      if (r.recipientUserId === null && userTeams.includes(r.recipientTeamId)) return true;
      return false;
    });
  }

  getRequestById(requestId: string): RequestEntity | undefined {
    const req = this.requests.find((r) => r.id === requestId);
    if (!req) return undefined;
    return {
      ...req,
      senderTeam: this.teams.find((t) => t.id === req.senderTeamId),
      recipientTeam: this.teams.find((t) => t.id === req.recipientTeamId),
    };
  }

  getRequestDetail(requestId: string) {
    const request = this.getRequestById(requestId);
    if (!request) return null;

    const sender = this.users.find((u) => u.id === request.senderUserId) || this.users[0];
    const recipient = request.recipientUserId
      ? this.users.find((u) => u.id === request.recipientUserId) || null
      : null;

    const senderTeam = this.teams.find((t) => t.id === request.senderTeamId);
    const recipientTeam = this.teams.find((t) => t.id === request.recipientTeamId);

    const revisions = this.revisions.filter((r) => r.requestId === requestId);
    const currentRevision =
      revisions.find((r) => r.id === request.currentRevisionId) || revisions[revisions.length - 1];

    const currentDocVersionIds = currentRevision?.documentVersionIds || [];
    const docVersions = this.documentVersions.filter((dv) => currentDocVersionIds.includes(dv.id));

    const documentsWithVersions = this.documents
      .filter((d) => docVersions.some((dv) => dv.documentId === d.id))
      .map((doc) => {
        const versions = this.documentVersions.filter((dv) => dv.documentId === doc.id);
        const currentVersion =
          versions.find((v) => v.id === doc.currentVersionId) ||
          versions[versions.length - 1] ||
          null;
        return {
          document: doc,
          versions,
          currentVersion,
          rawContent: currentVersion?.contentRef,
        };
      });

    const currentArtifactIds = currentRevision?.artifactIds || [];
    const artifacts = this.artifacts.filter(
      (a) => currentArtifactIds.includes(a.id) || a.requestId === requestId,
    );

    const executions = this.executions.filter((e) => e.requestId === requestId);
    const latestExecution = executions[executions.length - 1] || null;

    const results = executions.flatMap((e) => {
      const res = this.results.find((r) => r.executionId === e.id);
      return res ? [res] : [];
    });

    const latestResult =
      latestExecution && latestExecution.status === 'SUCCEEDED'
        ? this.results.find((res) => res.executionId === latestExecution.id) || null
        : null;

    const timeline = this.timelineEvents
      .filter((e) => e.requestId === requestId)
      .sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());

    return {
      request,
      sender,
      recipient,
      senderTeam,
      recipientTeam,
      currentRevision,
      revisions,
      documents: documentsWithVersions,
      artifacts,
      latestExecution,
      latestResult,
      results,
      executions,
      timeline,
    };
  }

  // --- 생성 및 상태 전이 메서드 ---
  createRequest(senderUserId: string, dto: CreateRequestDto): RequestEntity {
    // 05 §3.1 통신 허용 검증
    if (!this.canSendBetweenTeams(dto.senderTeamId, dto.recipientTeamId)) {
      throw new Error('보내는 팀과 받는 팀 사이에 허용된 팀 링크가 없습니다.');
    }

    const requestId = `req_${Date.now()}`;
    const revisionId = `rev_${Date.now()}_1`;
    const now = new Date();

    const docVersionIds: string[] = [];
    if (dto.documentTitle && dto.documentContent) {
      const docId = `doc_${Date.now()}`;
      const docVerId = `docver_${Date.now()}_1`;
      const doc: Document = {
        id: docId,
        teamId: dto.senderTeamId,
        ownerUserId: senderUserId,
        name: dto.documentTitle.endsWith('.md') ? dto.documentTitle : `${dto.documentTitle}.md`,
        mimeType: 'text/markdown',
        currentVersionId: docVerId,
        createdAt: now,
        updatedAt: now,
      };
      const docVer: DocumentVersion = {
        id: docVerId,
        documentId: docId,
        versionNo: 1,
        contentRef: dto.documentContent,
        contentSha256: 'sha256_' + Math.random().toString(36).substring(2),
        createdByType: 'HUMAN',
        createdByUserId: senderUserId,
        createdByAgentId: null,
        changeNote: '초기 작성',
        createdAt: now,
        updatedAt: now,
      };
      this.documents.push(doc);
      this.documentVersions.push(docVer);
      docVersionIds.push(docVerId);
    }

    const artifactIds: string[] = [];
    if (dto.attachments && dto.attachments.length > 0) {
      for (const att of dto.attachments) {
        const artId = `art_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        const artifact: Artifact = {
          id: artId,
          teamId: dto.senderTeamId,
          ownerUserId: senderUserId,
          requestId: requestId,
          kind: 'REQUEST_ATTACHMENT',
          filename: att.filename,
          mimeType: att.mimeType,
          storageRef: `s3://baton-artifacts/${requestId}/${att.filename}`,
          sha256: 'sha256_mock_file',
          sizeBytes: att.sizeBytes,
          createdAt: now,
          updatedAt: now,
        };
        this.artifacts.push(artifact);
        artifactIds.push(artId);
      }
    }

    const revision: RequestRevision = {
      id: revisionId,
      requestId,
      revisionNo: 1,
      originalInstruction: dto.originalInstruction,
      documentVersionIds: docVersionIds,
      artifactIds,
      createdByUserId: senderUserId,
      sentAt: dto.autoSend ? now : null,
      createdAt: now,
      updatedAt: now,
    };
    this.revisions.push(revision);

    const requestState = dto.autoSend ? RequestState.DELIVERED : RequestState.DRAFT;
    const recipientUserId = dto.recipientUserId || null;
    const isBroadcast = !recipientUserId;

    const request: RequestEntity = {
      id: requestId,
      teamId: dto.senderTeamId,
      senderTeamId: dto.senderTeamId,
      recipientTeamId: dto.recipientTeamId,
      senderUserId,
      recipientUserId,
      title: dto.title,
      state: requestState,
      currentRevisionNo: 1,
      currentRevisionId: revisionId,
      returnReason: null,
      claimedAt: recipientUserId ? now.toISOString() : null,
      isBroadcast: isBroadcast,
      acceptedAt: null,
      completedAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.requests.unshift(request);

    this.addTimelineEvent(
      requestId,
      revisionId,
      null,
      'HUMAN',
      senderUserId,
      null,
      TimelineEventType.REQUEST_CREATED,
      {
        title: request.title,
        senderTeamId: dto.senderTeamId,
        recipientTeamId: dto.recipientTeamId,
        broadcast: isBroadcast,
      },
    );

    if (dto.autoSend) {
      this.addTimelineEvent(
        requestId,
        revisionId,
        null,
        'HUMAN',
        senderUserId,
        null,
        TimelineEventType.REQUEST_SENT,
        {
          recipientUserId,
          recipientTeamId: dto.recipientTeamId,
          broadcast: isBroadcast,
        },
      );
      this.addTimelineEvent(
        requestId,
        revisionId,
        null,
        'SERVER',
        null,
        null,
        TimelineEventType.REQUEST_DELIVERED,
        {
          deviceId: isBroadcast ? null : 'dev_b_mac_01',
          broadcast: isBroadcast,
        },
      );
    }

    return this.getRequestById(requestId)!;
  }

  sendRequest(requestId: string, senderUserId: string): RequestEntity {
    const req = this.requests.find((r) => r.id === requestId);
    if (!req) throw new Error('Request not found');
    if (req.state !== RequestState.DRAFT) throw new Error('Only DRAFT can be sent');

    req.state = RequestState.DELIVERED;
    req.updatedAt = new Date().toISOString();

    const rev = this.revisions.find((r) => r.id === req.currentRevisionId);
    if (rev) {
      rev.sentAt = new Date();
    }

    this.addTimelineEvent(
      requestId,
      req.currentRevisionId,
      null,
      'HUMAN',
      senderUserId,
      null,
      TimelineEventType.REQUEST_SENT,
      {
        recipientUserId: req.recipientUserId,
        recipientTeamId: req.recipientTeamId,
        broadcast: req.recipientUserId === null,
      },
    );
    this.addTimelineEvent(
      requestId,
      req.currentRevisionId,
      null,
      'SERVER',
      null,
      null,
      TimelineEventType.REQUEST_DELIVERED,
      {
        deviceId: req.recipientUserId ? 'dev_b_mac_01' : null,
      },
    );

    return this.getRequestById(requestId)!;
  }

  /**
   * 05 §3.2 Claim 로직: 팀 뿌리기 요청 확정
   * 이미 다른 팀원이 claim했으면 409 Conflict 에러 throw.
   */
  claimRequest(requestId: string, claimerUserId: string): RequestEntity {
    const req = this.requests.find((r) => r.id === requestId);
    if (!req) throw new Error('Request not found');

    const userTeams = this.getUserTeams(claimerUserId).map((t) => t.teamId);
    if (!userTeams.includes(req.recipientTeamId)) {
      throw new Error('403: 수신 팀의 멤버만 이 요청을 수락 또는 처리할 수 있습니다.');
    }

    if (req.recipientUserId && req.recipientUserId !== claimerUserId) {
      const claimer =
        this.users.find((u) => u.id === req.recipientUserId)?.displayName || '다른 팀원';
      const err = new Error(`409: 이미 ${claimer}님이 수락하여 처리 중인 요청입니다.`);
      (err as unknown as { status: number }).status = 409;
      throw err;
    }

    if (!req.recipientUserId) {
      req.recipientUserId = claimerUserId;
      req.claimedAt = new Date().toISOString();
      req.updatedAt = new Date().toISOString();

      this.addTimelineEvent(
        requestId,
        req.currentRevisionId,
        null,
        'HUMAN',
        claimerUserId,
        null,
        TimelineEventType.REQUEST_ACCEPTED,
        {
          action: 'CLAIMED',
          claimedByUserId: claimerUserId,
        },
      );
    }

    return this.getRequestById(requestId)!;
  }

  startReview(requestId: string, recipientUserId: string): RequestEntity {
    // 자동 claim 검사
    this.claimRequest(requestId, recipientUserId);

    const req = this.requests.find((r) => r.id === requestId);
    if (!req) throw new Error('Request not found');
    if (req.state !== RequestState.DELIVERED) return this.getRequestById(requestId)!;

    req.state = RequestState.REVIEWING;
    req.updatedAt = new Date().toISOString();

    this.addTimelineEvent(
      requestId,
      req.currentRevisionId,
      null,
      'HUMAN',
      recipientUserId,
      null,
      TimelineEventType.REQUEST_REVIEW_STARTED,
      {},
    );
    return this.getRequestById(requestId)!;
  }

  acceptRequest(requestId: string, recipientUserId: string): RequestEntity {
    // 자동 claim 검사 (미확정 시 recipientUserId로 확정, 다른 사람이 이미 했으면 409)
    this.claimRequest(requestId, recipientUserId);

    const req = this.requests.find((r) => r.id === requestId);
    if (!req) throw new Error('Request not found');
    if (req.state !== RequestState.REVIEWING && req.state !== RequestState.DELIVERED) {
      throw new Error(`Cannot accept request in state ${req.state}`);
    }

    req.state = RequestState.ACCEPTED;
    req.acceptedAt = new Date().toISOString();
    req.updatedAt = new Date().toISOString();

    this.addTimelineEvent(
      requestId,
      req.currentRevisionId,
      null,
      'HUMAN',
      recipientUserId,
      null,
      TimelineEventType.REQUEST_ACCEPTED,
      {},
    );
    return this.getRequestById(requestId)!;
  }

  returnRequest(requestId: string, recipientUserId: string, reason: string): RequestEntity {
    this.claimRequest(requestId, recipientUserId);

    const req = this.requests.find((r) => r.id === requestId);
    if (!req) throw new Error('Request not found');
    if (!reason || reason.trim() === '') throw new Error('반려 사유를 입력해주세요.');

    req.state = RequestState.RETURNED;
    req.returnReason = reason;
    req.updatedAt = new Date().toISOString();

    this.addTimelineEvent(
      requestId,
      req.currentRevisionId,
      null,
      'HUMAN',
      recipientUserId,
      null,
      TimelineEventType.REQUEST_RETURNED,
      {
        reason,
      },
    );
    return this.getRequestById(requestId)!;
  }

  rejectRequest(requestId: string, recipientUserId: string, reason: string): RequestEntity {
    this.claimRequest(requestId, recipientUserId);

    const req = this.requests.find((r) => r.id === requestId);
    if (!req) throw new Error('Request not found');

    req.state = RequestState.REJECTED;
    req.returnReason = reason || null;
    req.updatedAt = new Date().toISOString();

    this.addTimelineEvent(
      requestId,
      req.currentRevisionId,
      null,
      'HUMAN',
      recipientUserId,
      null,
      TimelineEventType.REQUEST_REJECTED,
      {
        reason,
      },
    );
    return this.getRequestById(requestId)!;
  }

  resendWithNewRevision(
    requestId: string,
    senderUserId: string,
    dto: ResendRequestDto,
  ): RequestEntity {
    const req = this.requests.find((r) => r.id === requestId);
    if (!req) throw new Error('Request not found');
    if (req.state !== RequestState.RETURNED) {
      throw new Error('Can only resend when request is RETURNED');
    }

    const prevRev = this.revisions.find((r) => r.id === req.currentRevisionId);
    const newRevisionNo = (req.currentRevisionNo || 1) + 1;
    const newRevId = `rev_${Date.now()}_${newRevisionNo}`;
    const now = new Date();

    const docVersionIds = [...(prevRev?.documentVersionIds || [])];

    if (dto.documentContent) {
      const docId = this.documents[0]?.id || `doc_${Date.now()}`;
      const newDocVerId = `docver_${Date.now()}_${newRevisionNo}`;
      const newDocVer: DocumentVersion = {
        id: newDocVerId,
        documentId: docId,
        versionNo: newRevisionNo,
        contentRef: dto.documentContent,
        contentSha256: 'sha256_v2_' + Math.random().toString(36).substring(2),
        createdByType: 'HUMAN',
        createdByUserId: senderUserId,
        createdByAgentId: null,
        changeNote: `반려 사유 보완 (v${newRevisionNo})`,
        createdAt: now,
        updatedAt: now,
      };
      this.documentVersions.push(newDocVer);
      docVersionIds.push(newDocVerId);

      const parentDoc = this.documents.find((d) => d.id === docId);
      if (parentDoc) {
        parentDoc.currentVersionId = newDocVerId;
      }
    }

    const artifactIds = [...(prevRev?.artifactIds || [])];
    if (dto.attachments && dto.attachments.length > 0) {
      for (const att of dto.attachments) {
        const artId = `art_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        const artifact: Artifact = {
          id: artId,
          teamId: req.senderTeamId,
          ownerUserId: senderUserId,
          requestId: requestId,
          kind: 'REQUEST_ATTACHMENT',
          filename: att.filename,
          mimeType: att.mimeType,
          storageRef: `s3://baton-artifacts/${requestId}/${att.filename}`,
          sha256: 'sha256_v2_attachment',
          sizeBytes: att.sizeBytes,
          createdAt: now,
          updatedAt: now,
        };
        this.artifacts.push(artifact);
        artifactIds.push(artId);
      }
    }

    const newRev: RequestRevision = {
      id: newRevId,
      requestId,
      revisionNo: newRevisionNo,
      originalInstruction: dto.originalInstruction || prevRev?.originalInstruction || '',
      documentVersionIds: docVersionIds,
      artifactIds,
      createdByUserId: senderUserId,
      sentAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.revisions.push(newRev);

    // CLO-19: 팀 전체에 다시 뿌리기 (reassign === 'team')
    const reassignToTeam = dto.reassign === 'team';
    if (reassignToTeam) {
      req.recipientUserId = null;
      req.claimedAt = null;
      req.claimedBy = null;
      req.isBroadcast = true;
    }

    req.currentRevisionNo = newRevisionNo;
    req.currentRevisionId = newRevId;
    req.state = RequestState.DELIVERED;
    req.returnReason = null;
    req.updatedAt = now.toISOString();

    this.addTimelineEvent(
      requestId,
      newRevId,
      null,
      'HUMAN',
      senderUserId,
      null,
      TimelineEventType.REQUEST_REVISION_CREATED,
      {
        revisionNo: newRevisionNo,
      },
    );
    this.addTimelineEvent(
      requestId,
      newRevId,
      null,
      'HUMAN',
      senderUserId,
      null,
      TimelineEventType.REQUEST_RESENT,
      {
        revisionNo: newRevisionNo,
        reassign: dto.reassign || 'same',
        reassignedToTeam: reassignToTeam,
      },
    );
    this.addTimelineEvent(
      requestId,
      newRevId,
      null,
      'SERVER',
      null,
      null,
      TimelineEventType.REQUEST_DELIVERED,
      {
        deviceId: req.recipientUserId ? 'dev_b_mac_01' : null,
      },
    );

    return this.getRequestById(requestId)!;
  }

  createExecution(requestId: string, executorUserId: string, dto: CreateExecutionDto): Execution {
    const req = this.requests.find((r) => r.id === requestId);
    if (!req) throw new Error('Request not found');

    // M-5: 수신자 검증 (요청의 recipientUserId가 지정된 경우 실행자 일치 확인)
    if (req.recipientUserId && req.recipientUserId !== executorUserId) {
      const error = new Error('403: Forbidden - 요청의 수신자만 실행을 시작할 수 있습니다.');
      Object.assign(error, { status: 403, statusCode: 403 });
      throw error;
    }

    if (
      req.state !== RequestState.ACCEPTED &&
      req.state !== RequestState.FAILED &&
      req.state !== RequestState.RESULT_REVIEW
    ) {
      throw new Error(`Cannot start execution in state ${req.state}`);
    }

    const followUp = req.state === RequestState.RESULT_REVIEW;
    const instruction = dto.followUpInstruction ?? dto.additionalInstruction;
    if (followUp && !instruction?.trim()) {
      throw new Error('추가 작업 지시가 필요합니다.');
    }

    const agent = this.agents.find((a) => a.id === dto.agentId);
    if (!agent) throw new Error('Agent not found');

    const capabilities = effectiveAgentCapabilities(agent.provider, agent.capabilities);
    const requiredProtections = unenforceableProtections(capabilities, dto.policy as any);
    const requiredKeys = requiredProtections.map((p) => p.key);
    const acknowledged = dto.acknowledgedRisks ?? [];

    if (!acknowledgementMatches(requiredKeys, acknowledged)) {
      const error = new Error(
        requiredProtections.length
          ? '이 Agent의 supportedPolicyEnforcements/securityTier로 강제할 수 없는 보호가 있습니다. 아래 항목을 모두 확인하고 acknowledgedRisks에 항목 키를 정확히 담아 다시 요청하십시오.'
          : '이 실행에는 승인이 필요한 항목이 없습니다. acknowledgedRisks를 비워서 다시 요청하십시오.',
      );
      Object.assign(error, {
        statusCode: 409,
        status: 409,
        code: 'execution.unenforceable_protections',
        error: 'Conflict',
        unenforceableProtections: requiredProtections,
        requiredAcknowledgements: requiredKeys,
        acknowledgedRisks: acknowledged,
      });
      throw error;
    }

    const execId = `exec_${Date.now()}`;
    const now = new Date();

    const previous = this.executions.filter((e) => e.requestId === requestId).at(-1);

    const execution: Execution & {
      previousExecutionId?: string | null;
      followUpInstruction?: string | null;
    } = {
      id: execId,
      requestId,
      requestRevisionId: req.currentRevisionId,
      executorUserId,
      agentId: dto.agentId,
      projectId: dto.projectId,
      additionalInstruction: followUp ? instruction : dto.additionalInstruction,
      effectiveInstructionRef: `eff_${execId}`,
      status: 'QUEUED',
      startedAt: now,
      finishedAt: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
      previousExecutionId:
        followUp || req.state === RequestState.FAILED ? (previous?.id ?? null) : null,
      followUpInstruction: followUp ? instruction : null,
      acknowledgedRisks: requiredProtections.length ? requiredProtections : undefined,
      riskAcknowledgedAt: requiredProtections.length ? now : undefined,
      riskAcknowledgedByUserId: requiredProtections.length ? executorUserId : undefined,
    };
    this.executions.push(execution);

    req.state = RequestState.READY_TO_RUN;
    req.updatedAt = now.toISOString();

    if (followUp) {
      this.addTimelineEvent(
        requestId,
        req.currentRevisionId,
        execId,
        'HUMAN',
        executorUserId,
        dto.agentId,
        TimelineEventType.EXECUTION_FOLLOW_UP_REQUESTED,
        {
          previousExecutionId: previous?.id,
          followUpInstruction: instruction,
          resumeSessionId: 'claude_session_resume_1',
        },
      );
    }

    if (requiredProtections.length > 0) {
      this.addTimelineEvent(
        requestId,
        req.currentRevisionId,
        execId,
        'HUMAN',
        executorUserId,
        dto.agentId,
        'execution.risk_acknowledged' as TimelineEventType,
        {
          acknowledgedRisks: requiredProtections.map((item) => item.key),
          protections: requiredProtections,
          agentProvider: agent.provider,
          securityTier: capabilities.securityTier,
        },
      );
    }

    this.addTimelineEvent(
      requestId,
      req.currentRevisionId,
      execId,
      'HUMAN',
      executorUserId,
      dto.agentId,
      TimelineEventType.EXECUTION_QUEUED,
      {
        projectId: dto.projectId,
        additionalInstruction: followUp ? instruction : dto.additionalInstruction,
        followUpInstruction: followUp ? instruction : undefined,
        policy: dto.policy,
      },
    );
    this.addTimelineEvent(
      requestId,
      req.currentRevisionId,
      execId,
      'SERVER',
      null,
      dto.agentId,
      TimelineEventType.EXECUTION_COMMAND_REQUESTED,
      {
        policy: dto.policy,
      },
    );

    this.executionPhases.set(execId, {
      phase: 'starting',
      message: followUp
        ? 'Desktop 데몬에 추가 작업 실행 명령 전달 중 (SessionResume 확인 완료)'
        : 'Desktop 데몬에 실행 명령 전달 중 (SessionStart canary 확인 완료)',
      stepIndex: 0,
    });

    return execution;
  }

  simulateExecutionStep(executionId: string, forceFail = false) {
    const exec = this.executions.find((e) => e.id === executionId);
    if (!exec) throw new Error('Execution not found');
    const req = this.requests.find((r) => r.id === exec.requestId);
    if (!req) throw new Error('Request not found');

    const steps: Array<{
      phase: ExecutionProgressPhase;
      message: string;
      reqState?: RequestState;
    }> = [
      { phase: 'starting', message: 'SessionStart canary hook 확인 완료 (canary.ok)' },
      { phase: 'reading_input', message: '첨부 및 명세 문서 읽는 중' },
      { phase: 'exploring', message: '프로젝트 구조 탐색 및 코드베이스 분석' },
      { phase: 'editing', message: '요청 사항에 따른 코드 및 설정 수정 중' },
      { phase: 'testing', message: '테스트 스크립트 실행 및 검증 중' },
      { phase: 'test_passed', message: '테스트 성공: ALL_VERIFIED_SUCCESS' },
      { phase: 'writing_result', message: '결과 문서(result.md) 및 unified patch 생성 중' },
      { phase: 'completed', message: '실행 완료: 결과 수집 완료 (patch, result.md)' },
    ];

    const current = this.executionPhases.get(executionId) || {
      phase: 'starting',
      message: '준비 중',
      stepIndex: 0,
    };

    if (forceFail) {
      exec.status = 'FAILED';
      exec.failureReason = '테스트 검증 실패: 설정 오류 미해결 (exit code 1)';
      exec.finishedAt = new Date();
      req.state = RequestState.FAILED;
      req.updatedAt = new Date().toISOString();
      this.executionPhases.set(executionId, {
        phase: 'failed',
        message: exec.failureReason,
        stepIndex: steps.length,
      });
      this.addTimelineEvent(
        req.id,
        req.currentRevisionId,
        exec.id,
        'DESKTOP_AGENT',
        null,
        exec.agentId,
        TimelineEventType.EXECUTION_FAILED,
        {
          reason: exec.failureReason,
        },
      );
      return {
        execution: exec,
        phase: 'failed',
        message: exec.failureReason,
        isDone: true,
        isFailed: true,
      };
    }

    const nextIndex = current.stepIndex + 1;
    if (nextIndex < steps.length) {
      const step = steps[nextIndex];
      if (req.state === RequestState.READY_TO_RUN) {
        req.state = RequestState.RUNNING;
        req.updatedAt = new Date().toISOString();
        exec.status = 'RUNNING';
        this.addTimelineEvent(
          req.id,
          req.currentRevisionId,
          exec.id,
          'DESKTOP_AGENT',
          null,
          exec.agentId,
          TimelineEventType.EXECUTION_STARTED,
          {},
        );
      }

      this.executionPhases.set(executionId, {
        phase: step.phase,
        message: step.message,
        stepIndex: nextIndex,
      });

      this.addTimelineEvent(
        req.id,
        req.currentRevisionId,
        exec.id,
        'DESKTOP_AGENT',
        null,
        exec.agentId,
        TimelineEventType.EXECUTION_PROGRESS_REPORTED,
        {
          phase: step.phase,
          message: step.message,
        },
      );

      if (step.phase === 'completed') {
        exec.status = 'SUCCEEDED';
        exec.finishedAt = new Date();
        req.state = RequestState.RESULT_REVIEW;
        req.updatedAt = new Date().toISOString();

        const isFollowUp =
          Boolean((exec as any).previousExecutionId) ||
          this.executions.filter((e) => e.requestId === req.id).length > 1;
        const followUpText = (exec as any).followUpInstruction || exec.additionalInstruction;

        const resId = `res_${Date.now()}`;
        const result: Result = isFollowUp
          ? {
              id: resId,
              executionId,
              summary: `[2차 보완 결과] 추가 작업 지시 반영 완료: "${followUpText}". verify.sh 스크립트 외에 curl 기반 엔드포인트 헬스체크(scripts/curl-test.sh) 및 로그인 API 통합 테스트 케이스(tests/auth.test.ts) 작성 및 검증 완료.`,
              changedFiles: [
                'k8s/deployment.yaml',
                'config/redis.conf',
                'scripts/curl-test.sh',
                'tests/auth.test.ts',
              ],
              testSummary:
                '모든 테스트 통과: ALL_VERIFIED_SUCCESS (curl 헬스체크 4/4 성공, 단위/통합 테스트 12/12 통과)',
              resultDocumentVersionId: null,
              artifactIds: [],
              reviewStatus: 'PENDING',
              reviewedByUserId: null,
              reviewedAt: null,
              sentAt: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            }
          : {
              id: resId,
              executionId,
              summary:
                'Kubernetes deployment.yaml 내 REDIS_HOST 오타 수정 및 config/redis.conf timeout 설정 최적화 완료',
              changedFiles: ['k8s/deployment.yaml', 'config/redis.conf'],
              testSummary: '테스트 통과 (DEPLOYMENT_VERIFIED_SUCCESS)',
              resultDocumentVersionId: null,
              artifactIds: [],
              reviewStatus: 'PENDING',
              reviewedByUserId: null,
              reviewedAt: null,
              sentAt: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
        this.results.push(result);

        this.addTimelineEvent(
          req.id,
          req.currentRevisionId,
          exec.id,
          'DESKTOP_AGENT',
          null,
          exec.agentId,
          TimelineEventType.RESULT_CREATED,
          {
            summary: result.summary,
            changedFiles: result.changedFiles,
          },
        );

        return {
          execution: exec,
          phase: step.phase,
          message: step.message,
          result,
          isDone: true,
          isFailed: false,
        };
      }

      return {
        execution: exec,
        phase: step.phase,
        message: step.message,
        isDone: false,
        isFailed: false,
      };
    }

    return {
      execution: exec,
      phase: 'completed',
      message: '실행이 이미 완료되었습니다.',
      isDone: true,
      isFailed: false,
    };
  }

  cancelExecution(executionId: string) {
    const exec = this.executions.find((e) => e.id === executionId);
    if (!exec) throw new Error('Execution not found');
    const req = this.requests.find((r) => r.id === exec.requestId);
    if (!req) throw new Error('Request not found');

    exec.status = 'CANCELLED' as any;
    exec.failureReason = '사용자에 의해 실행이 취소되었습니다.';
    exec.finishedAt = new Date();

    req.state = RequestState.FAILED;
    req.updatedAt = new Date().toISOString();

    this.executionPhases.set(executionId, {
      phase: 'failed',
      message: '사용자에 의해 실행 취소됨',
      stepIndex: 99,
    });

    this.addTimelineEvent(
      req.id,
      req.currentRevisionId,
      exec.id,
      'HUMAN',
      req.recipientUserId,
      exec.agentId,
      TimelineEventType.EXECUTION_FAILED,
      {
        reason: '사용자에 의해 실행이 취소되었습니다 (Cancel Execution).',
      },
    );

    return { ok: true, message: '실행이 취소되었습니다.' };
  }

  approveAndSendResult(resultId: string, reviewedByUserId: string): Result {
    const res = this.results.find((r) => r.id === resultId);
    if (!res) throw new Error('Result not found');
    if (res.kind === 'PARTIAL') throw new Error('부분 결과는 승인할 수 없습니다.');

    const exec = this.executions.find((e) => e.id === res.executionId);
    if (!exec) throw new Error('Execution not found');

    const req = this.requests.find((r) => r.id === exec.requestId);
    if (!req) throw new Error('Request not found');

    const now = new Date();
    res.reviewStatus = 'APPROVED';
    res.reviewedByUserId = reviewedByUserId;
    res.reviewedAt = now;
    res.sentAt = now;
    res.updatedAt = now;

    req.state = RequestState.COMPLETED;
    req.completedAt = now.toISOString();
    req.updatedAt = now.toISOString();

    this.addTimelineEvent(
      req.id,
      req.currentRevisionId,
      exec.id,
      'HUMAN',
      reviewedByUserId,
      null,
      TimelineEventType.RESULT_APPROVED,
      {
        resultId,
      },
    );
    this.addTimelineEvent(
      req.id,
      req.currentRevisionId,
      exec.id,
      'HUMAN',
      reviewedByUserId,
      null,
      TimelineEventType.RESULT_SENT,
      {
        recipientUserId: req.senderUserId,
      },
    );
    this.addTimelineEvent(
      req.id,
      req.currentRevisionId,
      exec.id,
      'SERVER',
      null,
      null,
      TimelineEventType.REQUEST_COMPLETED,
      {},
    );

    return res;
  }

  private addTimelineEvent(
    requestId: string,
    revisionId: string | null,
    executionId: string | null,
    actorType: 'HUMAN' | 'DESKTOP_AGENT' | 'SERVER',
    actorUserId: string | null,
    agentId: string | null,
    eventType: TimelineEventType,
    payload: Record<string, unknown>,
  ) {
    const event: TimelineEvent = {
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      requestId,
      requestRevisionId: revisionId,
      executionId,
      actorType,
      actorUserId,
      agentId,
      eventType,
      occurredAt: new Date(),
      payload,
    };
    this.timelineEvents.push(event);
  }
}

// 싱글톤 인스턴스 (Next.js 핫 리로드 시 유지)
const globalForMockDb = globalThis as unknown as { mockDb?: MockDatabase };
export const mockDb = globalForMockDb.mockDb ?? new MockDatabase();
if (process.env.NODE_ENV !== 'production') globalForMockDb.mockDb = mockDb;
