import { RETURN_TO_KEY, validReturnTo, singleFlight, shouldRefreshSession } from './auth-navigation';
import { previewKind } from './attachment-preview';
import {
  User,
  Agent,
  Project,
  RequestEntity,
  RequestDetailResponse,
  CreateRequestDto,
  CreateDelegationDto,
  ResendRequestDto,
  CreateExecutionDto,
  Execution,
  ExecutionApproval,
  Result,
  ExecutionProgressPhase,
  StructuredPolicy,
  DEFAULT_STRUCTURED_POLICY,
  TimelineEvent,
  RequestRevision,
  Artifact,
  Organization,
  OrgRole,
  TeamRole,
  TeamMembershipDetail,
  TeamWithMembers,
  TeamLink,
  TeamLinkDirection,
  DeviceInfo,
  PairingCodeResponse,
  UserMeResponse,
  RecipientsResponse,
  OrgMember,
} from './types';
import { isUsableTempPassword, MIN_TEMP_PASSWORD_LENGTH } from './temp-password';

// M-5-1: API 모드 기본값을 실서버('real')로 전환하고 mock 은 NEXT_PUBLIC_API_MODE === 'mock' 일 때만 활성화한다.
export const API_MODE = process.env.NEXT_PUBLIC_API_MODE === 'mock' ? 'mock' : 'real';
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:3001';

// 토큰 보관 (메모리 및 로컬 스토리지 동기화)
let currentAuthToken: string | null = null;
let expiryRedirecting = false;
let authGeneration = 0;

export function isSessionExpiryRedirecting(): boolean { return expiryRedirecting; }

function redirectExpiredSession(path: string, sentToken: string | null) {
  if (typeof window === 'undefined' || expiryRedirecting || /^\/v1\/auth(?:\/|\?|$)/.test(path)) return;
  // 이전 계정의 늦은 응답으로 새로 발급받은 토큰을 지우지 않는다.
  if (getAuthToken() !== sentToken) return;
  expiryRedirecting = true;
  try { setAuthToken(null); } catch { /* 메모리 토큰은 이미 지웠다. */ }
  try {
    const returnTo = validReturnTo(window.location.pathname + window.location.search);
    if (returnTo) window.sessionStorage.setItem(RETURN_TO_KEY, returnTo);
  } catch { /* 저장소가 차단되어도 로그인 화면으로 이동한다. */ }
  try { window.location.replace('/login?expired=1'); } catch { /* 원래 API 오류를 보존한다. */ }
}


export function setAuthToken(token: string | null) {
  authGeneration += 1;
  // 토큰이 바뀌면 사람도 바뀐다. 이름 캐시를 비운다.
  if (token !== currentAuthToken) cachedRealUsers = null;
  currentAuthToken = token;
  if (typeof window !== 'undefined') {
    if (token) {
      localStorage.setItem('baton_token', token);
    } else {
      localStorage.removeItem('baton_token');
    }
  }
}

export function getAuthToken(): string | null {
  if (currentAuthToken) return currentAuthToken;
  if (typeof window !== 'undefined') {
    currentAuthToken = localStorage.getItem('baton_token');
  }
  return currentAuthToken;
}

/**
 * SHA-256 해시 계산 유틸리티
 */
async function computeSha256Hex(data: Uint8Array): Promise<string> {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c && c.subtle) {
    const hashBuffer = await c.subtle.digest('SHA-256', data as any);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return '0000000000000000000000000000000000000000000000000000000000000000';
}

/**
 * 모드에 따른 기본 URL 반환
 */
function getBaseUrl(): string {
  if (typeof window !== 'undefined') {
    return API_MODE === 'mock' ? '/api/mock' : API_URL;
  }
  return API_MODE === 'mock' ? 'http://127.0.0.1:3000/api/mock' : API_URL;
}

// ngrok 무료 플랜은 **브라우저 User-Agent 의 GET** 에 경고 페이지(ERR_NGROK_6024)를 돌려준다.
// 그 응답에는 CORS 헤더가 없어서 브라우저가 "Failed to fetch" 로 버리고, 화면은 에러 없이 빈 목록으로만 보인다.
// 이 헤더 하나면 통과한다(값은 무엇이든 된다). ngrok 이 아닌 환경에서는 무시되는 헤더라 그대로 둬도 안전하다.
// 2026-09-14 실측: POST 는 경고 없이 통과하고 GET 만 막힌다 — 그래서 로그인만 되고 목록이 비는 증상이 나온다.
const NGROK_SKIP_HEADER = { 'ngrok-skip-browser-warning': 'true' } as const;

export const refreshAuthToken = singleFlight(async (): Promise<string> => {
  const generation = authGeneration;
  const response = await fetch(`${getBaseUrl()}/v1/auth/refresh`, {
    method: 'POST', credentials: 'include', headers: { ...NGROK_SKIP_HEADER },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw Object.assign(new Error('로그인을 갱신하지 못했습니다.'), { status: response.status });
  const body = await response.json();
  if (typeof body?.token !== 'string' || !body.token) throw new Error('갱신 응답이 올바르지 않습니다.');
  // 로그아웃·계정 전환 뒤 도착한 갱신 응답으로 로그인 상태를 되살리지 않는다.
  if (generation !== authGeneration) throw new Error('인증 상태가 변경되었습니다.');
  setAuthToken(body.token);
  return body.token;
});

async function request<T>(path: string, options?: RequestInit, retried = false): Promise<T> {
  const base = getBaseUrl();
  const url = `${base}${path}`;
  const token = getAuthToken();
  const generation = authGeneration;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...NGROK_SKIP_HEADER,
    ...((options?.headers as Record<string, string>) || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    ...options,
    credentials: 'include',
    headers,
  });

  if (!res.ok) {
    if (!expiryRedirecting && shouldRefreshSession(path, res.status, retried) &&
        (generation === authGeneration || getAuthToken() !== null)) {
      let renewed = false;
      // 먼저 끝난 다른 요청이 이미 갱신했다면 새 토큰으로 재시도만 한다.
      if (getAuthToken() && getAuthToken() !== token) renewed = true;
      else {
        try { await refreshAuthToken(); renewed = true; } catch { /* 아래에서 원래 401을 처리한다. */ }
      }
      if (renewed) return request<T>(path, options, true);
    }
    let errorMsg = `API Error: ${res.status} ${res.statusText}`;
    let errBody: any = null;
    try {
      errBody = await res.json();
      if (errBody?.message) {
        errorMsg = Array.isArray(errBody.message) ? errBody.message.join(', ') : errBody.message;
      }
    } catch {
      // ignore
    }
    if (res.status === 401) redirectExpiredSession(path, token);
    // 화면에서 상태 코드로 분기할 수 있게 status 와 응답 데이터를 함께 실어 준다 (예: 409 위험 미승인 에러).
    throw Object.assign(new Error(errorMsg), {
      status: res.status,
      statusCode: res.status,
      data: errBody,
      response: errBody,
    });
  }

  return res.json() as Promise<T>;
}

// 캐시된 실서버 사용자 목록
let cachedRealUsers: User[] | null = null;

const SEED_TEAM_ID = '00000000-0000-4000-8000-000000000001';

export const apiClient = {
  // 모드 확인
  getMode(): string {
    return API_MODE;
  },

  setToken(token: string | null) {
    setAuthToken(token);
  },

  getToken(): string | null {
    return getAuthToken();
  },

  // 실서버 로그인
  /// 인증 제공자가 무엇이고 로그인 화면을 어떻게 그려야 하는지 (설계 08 §6)
  async describeAuth(): Promise<{
    providerId: string;
    kind: 'password' | 'redirect';
    authorizeUrl?: string;
    logoutUrl?: string;
  }> {
    return request<{
      providerId: string;
      kind: 'password' | 'redirect';
      authorizeUrl?: string;
      logoutUrl?: string;
    }>('/v1/auth/describe');
  },

  async logout(): Promise<void> {
    await request('/v1/auth/logout', { method: 'POST', signal: AbortSignal.timeout(10_000) });
  },

  // 비밀번호에 기본값을 두지 않는다. 기본값이 있으면 호출부가 빠뜨린 것을 눈치채지 못한다.
  async login(email: string, password: string): Promise<{ token: string; user: any }> {
    const res = await fetch(`${API_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      throw new Error(`Login failed: ${res.status}`);
    }

    const data = await res.json();
    if (data.token) {
      setAuthToken(data.token);
    }
    return data;
  },

  // 현재 로그인한 사용자 정보 (GET /v1/me)
  async getMe(userId?: string): Promise<UserMeResponse> {
    if (API_MODE === 'mock') {
      const query = userId ? `?userId=${encodeURIComponent(userId)}` : '';
      return request<UserMeResponse>(`/v1/me${query}`);
    }

    const res = await request<any>('/v1/me');
    return {
      ...res,
      user: {
        id: res.id,
        email: res.email,
        name: res.displayName,
        orgRole: res.orgRole,
      },
      teams: (res.teams || []).map((t: any) => ({
        ...t,
        teamId: t.id,
        teamName: t.name,
      })),
    };
  },

  // 디바이스 목록 (GET /v1/me/devices)
  async getDevices(userId?: string): Promise<DeviceInfo[]> {
    if (API_MODE === 'mock') {
      const query = userId ? `?userId=${encodeURIComponent(userId)}` : '';
      return request<DeviceInfo[]>(`/v1/me/devices${query}`);
    }
    // 실서버는 revoke 되지 않은 디바이스만 주고 status(ONLINE/OFFLINE, 2분 무응답 기준)를 직접 계산해 준다.
    // status 가 없으면 마지막 접속을 모른다는 뜻이므로 ONLINE 으로 낙관하지 않는다.
    const rows = await request<any[]>('/v1/me/devices');
    return rows.map((d) => ({
      ...d,
      status: d.revokedAt ? 'DISABLED' : d.status || 'OFFLINE',
    }));
  },

  // 페어링 코드 발급 (POST /v1/me/pairing-codes)
  async createPairingCode(userId?: string): Promise<PairingCodeResponse> {
    if (API_MODE === 'mock') {
      return request<PairingCodeResponse>('/v1/me/pairing-codes', {
        method: 'POST',
        body: JSON.stringify({ userId }),
      });
    }
    return request<PairingCodeResponse>('/v1/me/pairing-codes', {
      method: 'POST',
    });
  },

  // 디바이스 연결 해제 (DELETE /v1/me/devices/:id)
  async deleteDevice(deviceId: string, userId?: string): Promise<{ success: boolean }> {
    if (API_MODE === 'mock') {
      const query = userId ? `?userId=${encodeURIComponent(userId)}` : '';
      return request<{ success: boolean }>(`/v1/me/devices/${deviceId}${query}`, {
        method: 'DELETE',
      });
    }
    await request(`/v1/me/devices/${deviceId}`, {
      method: 'DELETE',
    });
    return { success: true };
  },

  // 조직 정보 (GET /v1/org)
  async getOrg(): Promise<Organization> {
    return request<Organization>('/v1/org');
  },

  // 팀 목록 (GET /v1/org/teams)
  async getOrgTeams(): Promise<TeamWithMembers[]> {
    const rows = await request<any[]>('/v1/org/teams');
    return rows.map((t) => {
      const members = (t.memberships || t.members || []).map((m: any) => ({
        ...m,
        user: m.user || {
          id: m.userId,
          email: m.email || '',
          displayName: m.displayName || m.userId,
        },
      }));
      return {
        ...t,
        membersCount: members.length,
        members,
        memberships: members,
      };
    });
  },

  // 팀 생성 (POST /v1/org/teams)
  async createOrgTeam(name: string): Promise<TeamWithMembers> {
    return request<TeamWithMembers>('/v1/org/teams', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  },

  // 팀 수정 (PATCH /v1/org/teams/:id)
  async updateOrgTeam(teamId: string, name: string): Promise<TeamWithMembers> {
    return request<TeamWithMembers>(`/v1/org/teams/${teamId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
  },

  // 팀 삭제 (DELETE /v1/org/teams/:id)
  async deleteOrgTeam(teamId: string): Promise<{ success: boolean }> {
    await request(`/v1/org/teams/${teamId}`, {
      method: 'DELETE',
    });
    return { success: true };
  },

  // 실서버 팀원 API 는 email 만 받는다(W5a 계약). userId 로 받으면 사용자 목록에서 email 을 찾는다 (W5d-2 수정: 이전에는 { userId } 를 보내 400).
  async resolveMemberEmail(emailOrUserId: string): Promise<string> {
    if (emailOrUserId.includes('@')) return emailOrUserId;
    const users = await this.getUsers();
    const found = users.find((u) => u.id === emailOrUserId);
    if (!found) throw new Error('사용자를 찾을 수 없습니다 (email 을 확인하세요)');
    return found.email;
  },

  // 팀원 추가 (POST /v1/org/teams/:id/members) — body { email, role? }
  async addTeamMember(
    teamId: string,
    emailOrUserId: string,
    role: TeamRole = 'MEMBER',
  ): Promise<TeamMembershipDetail> {
    const body =
      API_MODE === 'mock' && !emailOrUserId.includes('@')
        ? { userId: emailOrUserId, role }
        : { email: await this.resolveMemberEmail(emailOrUserId), role };
    return request<TeamMembershipDetail>(`/v1/org/teams/${teamId}/members`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  // 팀원 제거 (DELETE /v1/org/teams/:id/members) — body { email }
  async removeTeamMember(teamId: string, emailOrUserId: string): Promise<{ success: boolean }> {
    const isEmail = emailOrUserId.includes('@');
    if (API_MODE === 'mock' && !isEmail) {
      return request<{ success: boolean }>(`/v1/org/teams/${teamId}/members/${emailOrUserId}`, {
        method: 'DELETE',
      });
    }
    await request(`/v1/org/teams/${teamId}/members`, {
      method: 'DELETE',
      body: JSON.stringify({ email: await this.resolveMemberEmail(emailOrUserId) }),
    });
    return { success: true };
  },

  // 사용자 생성 (POST /v1/org/users)
  // 임시 비밀번호는 **호출부가 반드시 준다.** 예전에는 비어 있으면 'baton-dev-password' 를
  // 채워 넣어서, 입력창을 지우고 제출한 계정이 알려진 비밀번호로 만들어졌다
  // (2026-09-21 전수조사 결함 3). 값이 없으면 계정을 만들지 않는 쪽이 맞다.
  async createOrgUser(
    email: string,
    displayName: string,
    temporaryPassword: string,
  ): Promise<User> {
    if (!isUsableTempPassword(temporaryPassword ?? ''))
      throw new Error(`임시 비밀번호는 ${MIN_TEMP_PASSWORD_LENGTH}자 이상이어야 합니다.`);
    return request<User>('/v1/org/users', {
      method: 'POST',
      body: JSON.stringify({
        email,
        displayName,
        temporaryPassword: temporaryPassword.trim(),
      }),
    });
  },

  // 팀 링크 매트릭스 (GET /v1/org/team-links)
  async getOrgTeamLinks(): Promise<TeamLink[]> {
    return request<TeamLink[]>('/v1/org/team-links');
  },

  // 팀 링크 허용 (POST /v1/org/team-links)
  async createOrgTeamLink(
    teamAId: string,
    teamBId: string,
    direction: TeamLinkDirection | boolean = 'both',
  ): Promise<TeamLink[]> {
    const dir: TeamLinkDirection =
      typeof direction === 'boolean' ? (direction ? 'both' : 'a-to-b') : direction;
    if (API_MODE === 'mock') {
      return request<TeamLink[]>('/v1/org/team-links', {
        method: 'POST',
        body: JSON.stringify({
          teamAId,
          teamBId,
          fromTeamId: teamAId,
          toTeamId: teamBId,
          bidirectional: dir === 'both',
          direction: dir,
        }),
      });
    }
    return request<TeamLink[]>('/v1/org/team-links', {
      method: 'POST',
      body: JSON.stringify({ teamAId, teamBId, direction: dir }),
    });
  },

  // 팀 링크 해제 (DELETE /v1/org/team-links/:id)
  async deleteOrgTeamLink(
    linkIdOrFromTeamId: string,
    toTeamId?: string,
    direction: TeamLinkDirection | boolean = 'both',
  ): Promise<{ success: boolean; ok?: boolean }> {
    const dir: TeamLinkDirection =
      typeof direction === 'boolean' ? (direction ? 'both' : 'a-to-b') : direction;
    let linkId = linkIdOrFromTeamId;
    if (toTeamId) {
      try {
        const links = await this.getOrgTeamLinks();
        // 정확히 from -> to 인 행을 우선 찾고, 없으면 to -> from 인 행을 찾음
        const match =
          links.find((l) => l.fromTeamId === linkIdOrFromTeamId && l.toTeamId === toTeamId) ||
          links.find((l) => l.fromTeamId === toTeamId && l.toTeamId === linkIdOrFromTeamId);
        if (match) {
          linkId = match.id;
        }
      } catch (e) {
        console.warn('Could not resolve linkId from teamIds:', e);
      }
    }

    if (API_MODE === 'mock' && toTeamId && linkId === linkIdOrFromTeamId) {
      return request<{ success: boolean }>(
        `/v1/org/team-links?fromTeamId=${encodeURIComponent(linkIdOrFromTeamId)}&toTeamId=${encodeURIComponent(toTeamId)}&direction=${encodeURIComponent(dir)}&bidirectional=${dir === 'both'}`,
        {
          method: 'DELETE',
          body: JSON.stringify({
            fromTeamId: linkIdOrFromTeamId,
            toTeamId,
            direction: dir,
            bidirectional: dir === 'both',
          }),
        },
      );
    }

    const res = await request<{ ok?: boolean; success?: boolean }>(`/v1/org/team-links/${linkId}`, {
      method: 'DELETE',
      body: JSON.stringify({ direction: dir }),
    });
    return { success: res?.ok ?? res?.success ?? true };
  },

  // 수신자 후보 조회 (GET /v1/recipients?senderTeamId=)
  async getRecipients(senderTeamId: string): Promise<RecipientsResponse> {
    return request<RecipientsResponse>(
      `/v1/recipients?senderTeamId=${encodeURIComponent(senderTeamId)}`,
    );
  },

  // 팀 뿌리기 요청 claim 선점 (POST /v1/requests/:id/accept 또는 /claim)
  async claimRequest(requestId: string, userId?: string): Promise<RequestEntity> {
    if (API_MODE === 'mock') {
      return request<RequestEntity>(`/v1/requests/${requestId}/claim`, {
        method: 'POST',
        body: JSON.stringify({ userId }),
      });
    }
    // real 모드: 상태가 REVIEWING 전이면 review/start 먼저 호출하여 유효한 상태 전이 보장
    try {
      const detail = await request<any>(`/v1/requests/${requestId}`);
      if (detail.state === 'SENT' || detail.state === 'DELIVERED') {
        await request(`/v1/requests/${requestId}/review/start`, { method: 'POST' });
      }
    } catch (e: any) {
      if (e.status === 409 || e.message?.includes('409') || e.message?.includes('이미 다른 팀원')) {
        throw e;
      }
    }
    return request<RequestEntity>(`/v1/requests/${requestId}/accept`, {
      method: 'POST',
    });
  },

  /** 조직 구성원 명부. 관리자가 아니어도 볼 수 있다 (GET /v1/org/members). */
  async getOrgMembers(): Promise<OrgMember[]> {
    if (API_MODE === 'mock') return [];
    return request<OrgMember[]>('/v1/org/members');
  },

  // 사용자 목록 (이름 표시용)
  async getUsers(): Promise<User[]> {
    if (API_MODE === 'mock') {
      return request<User[]>('/v1/users');
    }
    if (cachedRealUsers && cachedRealUsers.length > 0) return cachedRealUsers;
    try {
      // 예전에는 ORG_ADMIN 전용 `/v1/org/users` 를 찌르고, 403 이 나면 **a@·b@·admin@ 으로
      // 각각 로그인해서** 목록을 지어냈다. 실제 로그인을 붙인 지금은 남의 계정으로 인증하는
      // 코드가 남아 있을 이유가 없다. 멤버가 볼 수 있는 명부로 대체한다 (2026-09-21).
      const members = await this.getOrgMembers();
      cachedRealUsers = members.map((m) => ({
        id: m.id,
        email: m.email,
        displayName: m.displayName,
        status: m.status,
        createdAt: new Date(),
        updatedAt: new Date(),
      })) as User[];
      return cachedRealUsers;
    } catch (e) {
      console.warn('조직 구성원 조회 실패:', e);
      return [];
    }
  },

  // 에이전트 목록 (기본값은 DISABLED 제외. includeDisabled: true 시 비활성 에이전트도 포함)
  async getAgents(options?: { includeDisabled?: boolean }): Promise<Agent[]> {
    const query = options?.includeDisabled ? '?includeDisabled=true' : '';
    if (API_MODE === 'mock') {
      return request<Agent[]>(`/v1/agents${query}`);
    }

    // real 모드: 로그인 사용자가 소유한 Agent (메뉴바 데몬이 pairing 후 등록한 것). 서버가 ONLINE/BUSY 를 앞에 정렬한다.
    const rows = await request<any[]>(`/v1/agents${query}`);
    return rows.map((a) => ({
      id: a.id,
      ownerUserId: a.ownerUserId,
      deviceId: a.deviceId,
      provider: a.provider ?? 'CLAUDE_CODE',
      capabilities: a.capabilities,
      // 데몬이 보고한 모델 목록. 여기서 빠뜨리면 실행 준비 화면의 모델 선택이
      // "기본값 / 직접 입력" 만 남는다 (서버에는 들어와 있는데 화면에서 사라진다).
      models: a.models ?? null,
      displayName: a.device?.name ? `${a.displayName} · ${a.device.name}` : a.displayName,
      status: a.status,
      lastSeenAt: a.lastSeenAt ? new Date(a.lastSeenAt) : null,
      createdAt: new Date(a.createdAt),
      updatedAt: new Date(a.updatedAt),
    }));
  },

  // 프로젝트 목록
  async getProjects(options?: { includeDisabled?: boolean; agentId?: string }): Promise<Project[]> {
    const params = new URLSearchParams();
    if (options?.includeDisabled) params.set('includeDisabled', 'true');
    if (options?.agentId) params.set('agentId', options.agentId);
    const qs = params.toString();
    const query = qs ? `?${qs}` : '';

    if (API_MODE === 'mock') {
      return request<Project[]>(`/v1/projects${query}`);
    }

    // real 모드: 로그인 사용자가 소유한 Project (데몬이 설정의 프로젝트 목록으로 등록, 04 §11.1)
    // displayName 에 경로를 덧붙이지 않는다. 화면에서 `이름 (경로)` 로 조합하므로 경로가 두 번 찍힌다.
    const rows = await request<any[]>(`/v1/projects${query}`);
    return rows.map((p) => ({
      id: p.id,
      ownerUserId: p.ownerUserId,
      agentId: p.agentId,
      displayName: p.displayName,
      localPathHint: p.localPathHint ?? null,
      status: p.status,
      createdAt: new Date(p.createdAt),
      updatedAt: new Date(p.updatedAt),
    }));
  },

  // Artifact 메타데이터 (downloadUrl 은 서버 상대 경로)
  async getArtifact(artifactId: string, disposition: 'inline' | 'attachment' = 'attachment'): Promise<Artifact & { downloadUrl?: string }> {
    return request<Artifact & { downloadUrl?: string }>(`/v1/artifacts/${artifactId}?disposition=${disposition}`);
  },

  // Artifact 본문 텍스트 (patch, result.md 등)
  async getArtifactText(artifactId: string): Promise<{ artifact: Artifact; text: string }> {
    const artifact = await this.getArtifact(artifactId);
    const kind = previewKind(artifact.mimeType, artifact.filename);
    if (!artifact.downloadUrl || !['text', 'markdown'].includes(kind ?? '')) return { artifact, text: '' };
    if (artifact.sizeBytes > 2 * 1024 * 1024) return { artifact, text: '' };
    const url = artifact.downloadUrl.startsWith('http')
      ? artifact.downloadUrl
      : `${API_URL}${artifact.downloadUrl}`;
    const res = await fetch(url, artifact.downloadUrl.startsWith('http')
      ? { credentials: 'omit' }
      : { credentials: 'include', headers: { ...NGROK_SKIP_HEADER } });
    return { artifact, text: res.ok ? await res.text() : '' };
  },

  // 파일 업로드 (POST /v1/uploads -> PUT /v1/storage/local/...)
  async uploadAttachment(params: {
    teamId: string;
    requestId?: string;
    filename: string;
    mimeType: string;
    content: string | Uint8Array;
  }): Promise<{ artifactId: string; filename: string }> {
    const bytes =
      typeof params.content === 'string'
        ? new TextEncoder().encode(params.content)
        : params.content;
    const sha256 = await computeSha256Hex(bytes);
    const sizeBytes = bytes.byteLength;

    // 1. 발급: POST /v1/uploads
    const uploadRes = await request<{
      artifact: { id: string };
      uploadUrl: string;
      downloadUrl: string;
    }>('/v1/uploads', {
      method: 'POST',
      body: JSON.stringify({
        teamId: params.teamId,
        requestId: params.requestId,
        kind: 'REQUEST_ATTACHMENT',
        filename: params.filename,
        mimeType: params.mimeType,
        sha256,
        sizeBytes,
      }),
    });

    // 2. 파일 전송: PUT /v1/storage/local/...
    const putUrl = uploadRes.uploadUrl.startsWith('http')
      ? uploadRes.uploadUrl
      : `${API_URL}${uploadRes.uploadUrl}`;

    const putRes = await fetch(putUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': params.mimeType,
        'Content-Length': sizeBytes.toString(),
      },
      body: bytes as any,
      credentials: 'include',
    });

    if (!putRes.ok) {
      throw new Error(`Upload PUT failed: ${putRes.status} ${putRes.statusText}`);
    }

    return { artifactId: uploadRes.artifact.id, filename: params.filename };
  },

  // Request 목록
  async getRequests(userId?: string): Promise<RequestEntity[]> {
    if (API_MODE === 'mock') {
      const query = userId ? `?userId=${encodeURIComponent(userId)}` : '';
      return request<RequestEntity[]>(`/v1/requests${query}`);
    }

    // real 모드에서는 박스 필터 없이 전체 조회하여 클라이언트에서 필터링
    return request<RequestEntity[]>('/v1/requests');
  },

  // Request 상세
  async getRequestDetail(requestId: string): Promise<RequestDetailResponse> {
    if (API_MODE === 'mock') {
      return request<RequestDetailResponse>(`/v1/requests/${requestId}`);
    }

    // real 모드 서버: GET /v1/requests/:id
    const raw = await request<any>(`/v1/requests/${requestId}`);

    // 사람 정보는 **응답에 실려 온 것을 먼저 쓴다.** 조직 사용자 목록(getUsers)은
    // ORG_ADMIN 만 받을 수 있어서 일반 사용자에게는 비어 있고, 예전에는 그때
    // 'a@baton.local'·'발신자' 같은 가짜 값을 대신 보여 줬다.
    const users = await this.getUsers();
    const asUser = (
      embedded: { id: string; email: string; displayName: string } | null | undefined,
      userId: string,
    ): User =>
      ({
        id: userId,
        email: embedded?.email ?? users.find((u) => u.id === userId)?.email ?? '',
        displayName:
          embedded?.displayName ??
          users.find((u) => u.id === userId)?.displayName ??
          '(알 수 없음)',
        status: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
      }) as User;

    const sender = asUser(raw.sender, raw.senderUserId);
    let recipient: User | null = null;
    if (raw.recipientUserId) {
      recipient = asUser(raw.recipient, raw.recipientUserId);
    } else if (raw.claimedBy) {
      recipient = asUser(raw.claimedBy, raw.claimedBy.id);
    }

    const revisions: RequestRevision[] = (raw.revisions || []).map((r: any) => ({
      id: r.id,
      requestId: r.requestId,
      revisionNo: r.revisionNo,
      originalInstruction: r.originalInstruction,
      documentVersionIds: r.documentVersionIds || [],
      artifactIds: r.artifactIds || [],
      createdByUserId: r.createdByUserId,
      createdAt: r.createdAt,
      sentAt: r.sentAt,
    }));

    const currentRevision = revisions.find((r) => r.id === raw.currentRevisionId) ||
      revisions[revisions.length - 1] || {
        id: raw.currentRevisionId || 'rev-1',
        requestId: raw.id,
        revisionNo: raw.currentRevisionNo || 1,
        originalInstruction: '',
        documentVersionIds: [],
        artifactIds: [],
        createdByUserId: raw.senderUserId,
        createdAt: raw.createdAt,
        sentAt: raw.createdAt,
      };

    const latestExecution =
      raw.executions && raw.executions.length > 0
        ? raw.executions[raw.executions.length - 1]
        : null;
    // 서버 계약(CLO-8a): result/latestResult 는 **최신 실행의 결과**이고, 추가 실행이 진행 중이면 null 이다.
    // 이전 결과는 results[] 에 남지만 승인 대상이 아니므로 여기서 대체하지 않는다.
    const candidateResult = raw.latestResult ?? raw.result ?? latestExecution?.result ?? null;
    const latestResult = candidateResult?.kind === 'PARTIAL' ? null : candidateResult;

    const timeline: TimelineEvent[] = (raw.timelineEvents || []).map((e: any) => ({
      id: e.id,
      requestId: e.requestId,
      requestRevisionId: e.requestRevisionId,
      executionId: e.executionId,
      actorType: e.actorType,
      actorUserId: e.actorUserId,
      agentId: e.agentId,
      agentProvider: e.agentProvider,
      eventType: e.eventType,
      payload: e.payload,
      occurredAt: e.occurredAt,
    }));

    // 문서: 현재 revision 의 version id 로 서버에서 이름·본문을 읽는다 (GET /v1/documents/versions/:id)
    const documents = await Promise.all(
      (currentRevision.documentVersionIds || []).map(async (vId: string) => {
        let meta: any = null;
        try {
          meta = await request<any>(`/v1/documents/versions/${vId}`);
        } catch (e) {
          console.warn('document version load failed:', vId, e);
        }
        const version = {
          id: vId,
          documentId: meta?.documentId || `doc-${vId}`,
          versionNo: meta?.versionNo || currentRevision.revisionNo,
          contentRef: `inline://documents/${vId}`,
          contentSha256: meta?.contentSha256 || '',
          createdByType: 'HUMAN' as const,
          createdByUserId: raw.senderUserId,
          createdByAgentId: null,
          changeNote: meta?.changeNote || '문서 첨부',
          createdAt: new Date(meta?.createdAt || raw.createdAt),
          updatedAt: new Date(meta?.createdAt || raw.updatedAt),
        };
        // 같은 문서의 다른 version 도 읽어 "버전 비교(Diff)" 드롭다운을 채운다 (GET /v1/documents/:id/versions).
        let versions = [version];
        if (meta?.documentId) {
          try {
            const rows = await request<any[]>(`/v1/documents/${meta.documentId}/versions`);
            if (Array.isArray(rows) && rows.length > 0) {
              versions = rows
                .map((r) => ({
                  id: r.id,
                  documentId: r.documentId,
                  versionNo: r.versionNo,
                  contentRef: `inline://documents/${r.id}`,
                  contentSha256: r.contentSha256 || '',
                  createdByType: 'HUMAN' as const,
                  createdByUserId: r.createdByUserId || raw.senderUserId,
                  createdByAgentId: null,
                  changeNote: r.changeNote || '문서 첨부',
                  createdAt: new Date(r.createdAt),
                  updatedAt: new Date(r.createdAt),
                }))
                .sort((a, b) => a.versionNo - b.versionNo);
            }
          } catch (e) {
            console.warn('document versions load failed:', meta.documentId, e);
          }
        }
        return {
          document: {
            id: meta?.documentId || `doc-${vId}`,
            teamId: raw.teamId,
            ownerUserId: raw.senderUserId,
            name: meta?.name || '문서',
            mimeType: (meta?.mimeType || 'text/markdown') as 'text/markdown',
            currentVersionId: vId,
            createdAt: new Date(raw.createdAt),
            updatedAt: new Date(raw.updatedAt),
          },
          versions,
          currentVersion: version,
          rawContent: meta?.content ?? '(문서 본문을 불러오지 못했습니다)',
        };
      }),
    );

    const results =
      raw.results && raw.results.length > 0
        ? raw.results
        : (raw.executions || []).flatMap((e: any) => (e.result ? [e.result] : []));

    return {
      request: raw as RequestEntity,
      sender,
      recipient,
      senderTeam: raw.senderTeam || undefined,
      recipientTeam: raw.recipientTeam || undefined,
      currentRevision,
      revisions,
      documents,
      artifacts: raw.artifacts || [],
      latestExecution,
      latestResult,
      results,
      executions: raw.executions || [],
      timeline,
      children: raw.children || [],
      parent: raw.parent || null,
    };
  },

  async createDelegation(requestId: string, dto: CreateDelegationDto): Promise<RequestEntity> {
    return request<RequestEntity>(`/v1/requests/${requestId}/delegations`, {
      method: 'POST',
      body: JSON.stringify(dto),
    });
  },

  // 새 Request 생성
  async createRequest(senderUserId: string, dto: CreateRequestDto): Promise<RequestEntity> {
    if (API_MODE === 'mock') {
      return request<RequestEntity>('/v1/requests', {
        method: 'POST',
        body: JSON.stringify({ senderUserId, ...dto }),
      });
    }

    const senderTeamId = dto.senderTeamId || SEED_TEAM_ID;
    const recipientTeamId = dto.recipientTeamId || SEED_TEAM_ID;
    const documentVersionIds: string[] = [];
    const artifactIds: string[] = [];

    // 1. 요청 생성 (DRAFT): POST /v1/requests
    const initialReq = await request<RequestEntity>('/v1/requests', {
      method: 'POST',
      body: JSON.stringify({
        senderTeamId,
        recipientTeamId,
        recipientUserId: dto.recipientUserId || null,
        title: dto.title,
        originalInstruction: dto.originalInstruction,
        documentVersionIds: [],
        artifactIds: [],
      }),
    });

    // 2. 문서 첨부 (POST /v1/requests/:id/documents)
    if (dto.documentContent) {
      try {
        const docRes = await request<{ id: string; currentVersionId: string }>(
          `/v1/requests/${initialReq.id}/documents`,
          {
            method: 'POST',
            body: JSON.stringify({
              name: dto.documentTitle || 'api-error-analysis.md',
              content: dto.documentContent,
              changeNote: '초안 작성',
            }),
          },
        );
        if (docRes?.currentVersionId) {
          documentVersionIds.push(docRes.currentVersionId);
        }
      } catch (e) {
        console.warn('Failed to attach document:', e);
      }
    }

    // 3. 파일 첨부 업로드 (POST /v1/uploads -> PUT /v1/storage/local/...)
    if (dto.attachments && dto.attachments.length > 0) {
      for (const att of dto.attachments) {
        try {
          // 사람이 고른 파일의 실제 내용. 여기서 만들어 내면 안 된다 (위와 같은 이유).
          const sampleContent = att.content;
          const uploadRes = await this.uploadAttachment({
            teamId: senderTeamId,
            requestId: initialReq.id,
            filename: att.filename,
            mimeType: att.mimeType || 'text/plain',
            content: sampleContent,
          });
          artifactIds.push(uploadRes.artifactId);
        } catch (e) {
          console.warn(`Failed to upload attachment ${att.filename}:`, e);
        }
      }
    }

    // 4. Draft 수정으로 documentVersionIds, artifactIds 반영
    if (documentVersionIds.length > 0 || artifactIds.length > 0) {
      await request(`/v1/requests/${initialReq.id}/draft`, {
        method: 'PATCH',
        body: JSON.stringify({
          documentVersionIds,
          artifactIds,
        }),
      });
    }

    // 5. autoSend 인 경우 즉시 전송
    let finalReq = initialReq;
    if (dto.autoSend) {
      finalReq = await request<RequestEntity>(`/v1/requests/${initialReq.id}/send`, {
        method: 'POST',
      });
    }

    return finalReq;
  },

  // DRAFT 상태 Request 전송
  async sendRequest(requestId: string, senderUserId: string): Promise<RequestEntity> {
    if (API_MODE === 'mock') {
      return request<RequestEntity>(`/v1/requests/${requestId}/send`, {
        method: 'POST',
        body: JSON.stringify({ senderUserId }),
      });
    }
    return request<RequestEntity>(`/v1/requests/${requestId}/send`, {
      method: 'POST',
    });
  },

  // 수신자의 검토 시작
  async startReview(requestId: string, recipientUserId: string): Promise<RequestEntity> {
    if (API_MODE === 'mock') {
      return request<RequestEntity>(`/v1/requests/${requestId}/review/start`, {
        method: 'POST',
        body: JSON.stringify({ recipientUserId }),
      });
    }
    return request<RequestEntity>(`/v1/requests/${requestId}/review/start`, {
      method: 'POST',
    });
  },

  // 수신자의 요청 수락
  async acceptRequest(requestId: string, recipientUserId: string): Promise<RequestEntity> {
    if (API_MODE === 'mock') {
      return request<RequestEntity>(`/v1/requests/${requestId}/accept`, {
        method: 'POST',
        body: JSON.stringify({ recipientUserId }),
      });
    }
    // real 모드: 상태가 REVIEWING 전이면 review/start 먼저 호출
    try {
      const detail = await request<any>(`/v1/requests/${requestId}`);
      if (detail.state === 'SENT' || detail.state === 'DELIVERED') {
        await request(`/v1/requests/${requestId}/review/start`, { method: 'POST' });
      }
    } catch (e: any) {
      if (e.status === 409 || e.message?.includes('409') || e.message?.includes('이미 다른 팀원')) {
        throw e;
      }
    }
    return request<RequestEntity>(`/v1/requests/${requestId}/accept`, {
      method: 'POST',
    });
  },

  // 수신자의 요청 반려 (사유 필수)
  // CLO-141: 결과 검토에서 반려할 때는 에이전트 결과(result.md)를 요청자에게 보여 줄지 함께 보낸다.
  // 기본은 false 다 — 실행자 환경의 산출물은 승인 전까지 나가지 않는 것이 기본값이다.
  async returnRequest(
    requestId: string,
    recipientUserId: string,
    reason: string,
    discloseResult = false,
  ): Promise<RequestEntity> {
    return request<RequestEntity>(`/v1/requests/${requestId}/return`, {
      method: 'POST',
      body: JSON.stringify({ reason, discloseResult }),
    });
  },

  // CLO-141: 결과 폐기 (RESULT_REVIEW → ACCEPTED). 요청은 살아 있고 실행 설정부터 다시 한다.
  // 실행자 컴퓨터의 파일 변경은 되돌아가지 않는다.
  async discardResult(requestId: string, reason?: string): Promise<RequestEntity> {
    return request<RequestEntity>(`/v1/requests/${requestId}/discard-result`, {
      method: 'POST',
      body: JSON.stringify(reason?.trim() ? { reason: reason.trim() } : {}),
    });
  },

  // 수신자의 요청 거절
  async rejectRequest(
    requestId: string,
    recipientUserId: string,
    reason: string,
  ): Promise<RequestEntity> {
    return request<RequestEntity>(`/v1/requests/${requestId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  // 반려된 요청에 대해 새 revision으로 보완 재전송
  // 요청의 현재 revision 에 붙은 첫 문서의 documentId (없으면 null). 재전송 때 같은 문서에 version 을 쌓기 위해 쓴다.
  async findRequestDocumentId(requestId: string): Promise<string | null> {
    try {
      const raw = await request<any>(`/v1/requests/${requestId}`);
      const revisions: any[] = raw.revisions || [];
      const current =
        revisions.find((r) => r.id === raw.currentRevisionId) ||
        revisions[revisions.length - 1] ||
        null;
      const versionId = current?.documentVersionIds?.[0];
      if (!versionId) return null;
      const meta = await request<any>(`/v1/documents/versions/${versionId}`);
      return meta?.documentId ?? null;
    } catch {
      return null;
    }
  },

  async withdrawRequest(requestId: string, reason?: string): Promise<void> {
    await request(`/v1/requests/${requestId}/withdraw`, { method: 'POST', body: JSON.stringify({ reason }) });
  },

  async resendRequest(
    requestId: string,
    senderUserId: string,
    dto: ResendRequestDto,
  ): Promise<RequestEntity> {
    if (API_MODE === 'mock') {
      return request<RequestEntity>(`/v1/requests/${requestId}/resend`, {
        method: 'POST',
        body: JSON.stringify({ senderUserId, ...dto }),
      });
    }

    const teamId = SEED_TEAM_ID;
    const artifactIds: string[] = [];
    const documentVersionIds: string[] = [];

    // 재전송 시 첨부파일 업로드
    if (dto.attachments && dto.attachments.length > 0) {
      for (const att of dto.attachments) {
        try {
          // 사람이 고른 파일의 실제 내용을 올린다. 예전에는 여기서 가짜 Redis 로그를
          // 만들어 올렸고, 그게 그대로 AI 에이전트의 작업 공간까지 갔다.
          const logContent = att.content;
          const uploadRes = await this.uploadAttachment({
            teamId,
            requestId,
            filename: att.filename,
            mimeType: att.mimeType || 'text/plain',
            content: logContent,
          });
          artifactIds.push(uploadRes.artifactId);
        } catch (e) {
          if (dto.followup) throw e;
          console.warn(`Failed to upload attachment during resend:`, e);
        }
      }
    }

    // 재전송 시 보완한 문서는 **기존 Document 의 새 version** 으로 만든다 (기획서 §12, §23).
    // W6d 이전에는 매번 새 Document(`*.v2.md`)를 만들어 v1/v2 비교 화면에 비교 대상이 생기지 않았다.
    if (dto.documentContent) {
      try {
        const existingDocumentId = await this.findRequestDocumentId(requestId);
        const version = existingDocumentId
          ? await request<{ id: string }>(`/v1/documents/${existingDocumentId}/versions`, {
              method: 'POST',
              body: JSON.stringify({ content: dto.documentContent, changeNote: '반려 사유 반영' }),
            })
          : await request<{ id: string; currentVersionId: string }>(
              `/v1/requests/${requestId}/documents`,
              {
                method: 'POST',
                body: JSON.stringify({
                  name: dto.documentTitle || 'api-error-analysis.md',
                  content: dto.documentContent,
                  changeNote: '반려 사유 반영',
                }),
              },
            ).then((r) => ({ id: r.currentVersionId }));
        if (version?.id) documentVersionIds.push(version.id);
      } catch (e) {
        if (dto.followup) throw e;
        console.warn('Failed to attach document during resend:', e);
      }
    }

    // 1. POST /v1/requests/:id/revisions
    await request(`/v1/requests/${requestId}/revisions`, {
      method: 'POST',
      body: JSON.stringify({
        originalInstruction: dto.originalInstruction || '보완된 요청 지시사항',
        documentVersionIds,
        artifactIds,
      }),
    });

    if (dto.followup) return { id: requestId } as RequestEntity;

    // 2. POST /v1/requests/:id/resend
    return request<RequestEntity>(`/v1/requests/${requestId}/resend`, {
      method: 'POST',
      body: JSON.stringify({ reassign: dto.reassign || 'same' }),
    });
  },

  // B의 에이전트 실행 시작 (Execution 생성 및 READY_TO_RUN 전이)
  async createExecution(
    requestId: string,
    executorUserId: string,
    dto: CreateExecutionDto,
  ): Promise<Execution> {
    if (API_MODE === 'mock') {
      return request<Execution>(`/v1/requests/${requestId}/executions`, {
        method: 'POST',
        body: JSON.stringify({ executorUserId, ...dto }),
      });
    }

    // F4: 실행 준비 화면의 구조화 policy 를 서버에 그대로 전달한다.
    return request<Execution>(`/v1/requests/${requestId}/executions`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: dto.agentId,
        projectId: dto.projectId,
        additionalInstruction: dto.additionalInstruction || '',
        followUpInstruction: dto.followUpInstruction,
        ...(dto.model ? { model: dto.model } : {}),
        // policy 를 모르면 키 자체를 빼서 서버 기본값이 적용되게 한다. 여기서 기본값을
        // 흉내 내면 클라이언트가 만든 정책이 실행 게이트로 들어간다(전수조사 결함 4).
        ...(dto.policy ? { policy: dto.policy } : {}),
        acknowledgedRisks: dto.acknowledgedRisks || [],
      }),
    });
  },

  // 실행 진행 단계 시뮬레이션
  async simulateExecutionStep(
    executionId: string,
    forceFail = false,
  ): Promise<{
    execution: Execution;
    phase: ExecutionProgressPhase;
    message: string;
    result?: Result;
    isDone: boolean;
    isFailed: boolean;
  }> {
    if (API_MODE === 'mock') {
      return request<{
        execution: Execution;
        phase: ExecutionProgressPhase;
        message: string;
        result?: Result;
        isDone: boolean;
        isFailed: boolean;
      }>(`/v1/executions/${executionId}/simulate-step`, {
        method: 'POST',
        body: JSON.stringify({ forceFail }),
      });
    }

    // real 모드에서는 **호출 자체를 막는다.** 이 함수는 데모용 시뮬레이터인데,
    // 예전에는 여기서 하드코딩된 디바이스 토큰으로 실서버의 Desktop API 를 직접 불러
    // 가짜 verify.sh 결과와 요약문을 실행 이력에 영구 저장할 수 있었다
    // (2026-09-21 전수조사 결함 5). 실서버에서 결과를 보고할 수 있는 주체는 데몬뿐이다.
    throw new Error(
      '실행 진행 시뮬레이션은 mock 모드 전용입니다. 실서버 실행 결과는 데스크톱 데몬만 보고할 수 있습니다.',
    );
  },

  // 에이전트 실행 취소 (POST /v1/executions/{id}/cancel)
  async cancelExecution(executionId: string): Promise<{ ok: boolean; message?: string }> {
    return request<{ ok: boolean; message?: string }>(`/v1/executions/${executionId}/cancel`, {
      method: 'POST',
    });
  },

  // 문서 버전 상세 및 본문 조회 (GET /v1/documents/versions/{id})
  async getDocumentVersion(versionId: string): Promise<{
    id: string;
    documentId: string;
    versionNo: number;
    name?: string;
    mimeType?: string;
    changeNote?: string | null;
    content: string;
    createdAt: string;
  }> {
    return request<any>(`/v1/documents/versions/${versionId}`);
  },

  // B의 최종 결과 승인 및 A에게 전달
  async approveAndSendResult(resultId: string, reviewedByUserId: string): Promise<Result> {
    if (API_MODE === 'mock') {
      return request<Result>(`/v1/results/${resultId}/approve-and-send`, {
        method: 'POST',
        body: JSON.stringify({ reviewedByUserId }),
      });
    }

    return request<Result>(`/v1/results/${resultId}/approve-and-send`, {
      method: 'POST',
    });
  },

  // Mock 데이터 리셋
  async resetMockData(): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/v1/reset', {
      method: 'POST',
    });
  },

  getExecutionApprovals(executionId: string): Promise<ExecutionApproval[]> {
    return request(`/v1/executions/${executionId}/approvals`);
  },

  decideExecutionApproval(id: string, decision: 'ALLOWED' | 'DENIED') {
    return request<{ status: ExecutionApproval['status'] }>(`/v1/approvals/${id}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    });
  },

  // 실시간 알림 SSE 스트림 구독 (GET /v1/events)
  subscribeEvents(
    onEvent: (event: { type: string; data: any }) => void,
    onConnected?: () => void,
  ): () => void {
    if (API_MODE !== 'real' || typeof window === 'undefined') {
      return () => {};
    }

    const abortController = new AbortController();
    const token = getAuthToken();
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = async () => {
      if (abortController.signal.aborted) return;
      try {
        const response = await fetch(`${API_URL}/v1/events`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'text/event-stream',
            ...NGROK_SKIP_HEADER,
          },
          credentials: 'include',
          signal: abortController.signal,
        });

        if (!response.ok || !response.body) {
          return;
        }

        onConnected?.();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';

          for (const part of parts) {
            if (!part.trim()) continue;
            let eventType = 'message';
            let dataStr = '';

            for (const line of part.split('\n')) {
              if (line.startsWith('event:')) {
                eventType = line.replace('event:', '').trim();
              } else if (line.startsWith('data:')) {
                dataStr = line.replace('data:', '').trim();
              }
            }

            if (eventType !== 'keepalive' && dataStr) {
              try {
                const parsed = JSON.parse(dataStr);
                onEvent({ type: eventType, data: parsed });
              } catch {
                // ignore json parse error
              }
            }
          }
        }
      } catch {
        // 네트워크 오류와 정상 EOF 모두 재연결한다. 연결 복구 때 대기 요청도 다시 조회한다.
      } finally {
        if (!abortController.signal.aborted) reconnectTimer = setTimeout(connect, 3000);
      }
    };

    connect();

    return () => {
      clearTimeout(reconnectTimer);
      abortController.abort();
    };
  },
};
