#!/usr/bin/env node
// 01 §5.3 Desktop Agent API + SSE 를 흉내내는 가짜 서버 (Node 내장 http, 메모리 상태).
// 경로는 apps/server 의 현재 구현(v1/devices/pair, v1/desktop/events/stream, v1/desktop/executions/:id/status|result)에 맞췄고,
// 아직 서버에 없는 agents/projects/uploads 는 01 §5.3·§5.2 대로 만들었다.
// 05 §3.4 pairing(사용자별 1회용 코드 `XXXX-XXXX`, 만료·재사용 403 + 사유) 과 §3.2 팀 뿌리기(request.delivered 에
// recipientTeam/recipientUserId=null, claim 시 나머지 팀원에게 request.claimed) 를 흉내낸다 (W5d-1).
// CLI:  PORT=4180 node test/fake-server.mjs        테스트용 엔드포인트 /__test/* 포함
// 모듈: import { createFakeServer } from './fake-server.mjs'
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 서버(PairingService)와 같은 문구를 쓴다. 데몬이 이 사유를 팝오버에 그대로 보여 준다.
export const PAIRING_ERRORS = {
  unknown: '유효하지 않은 pairing 코드입니다.',
  used: '이미 사용한 pairing 코드입니다.',
  expired: '만료된 pairing 코드입니다.',
  legacyField: 'code 필드가 필요합니다 (05 §3.4: body { code, deviceName }, 전역 pairingCode 는 제거됨)'
};
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 혼동 문자(I, O, 0, 1) 제외
export function generatePairingCode() {
  const pick = () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return `${pick()}${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}${pick()}`;
}

// pairingCode: 개발·기존 테스트용 재사용 가능 코드(만료 없음). 사용자별 1회용 코드는 /__test/pairing-codes 로 발급한다.
// users: 코드 발급 기본 사용자와 팀 (05 §7 seed 의 B 를 흉내냄)
// singleConnection: 실서버(apps/server desktop/connections.ts)처럼 디바이스당 SSE 를 1개로 제한한다.
// 새 연결이 오면 기존 연결에 `connection.replaced` 를 보내고 끊는다. 기본은 꺼 둔다(기존 테스트의 idle 재연결과 겹치지 않도록).
export function createFakeServer({ port = 0, pairingCode = 'BATON-PAIR-123', log = () => {}, singleConnection = false, defaultUser = { id: 'user_b', displayName: '박인프라', teamId: 'team_infra', teamName: 'infra' } } = {}) {
  const state = { devices: new Map(), agents: new Map(), projects: new Map(), outbox: [], streams: new Map(), executions: new Map(), statuses: [], results: new Map(), sessions: new Map(), uploads: new Map(), files: new Map(), pairingCodes: new Map(), heartbeats: [] };
  if (pairingCode) state.pairingCodes.set(pairingCode, { code: pairingCode, userId: defaultUser.id, displayName: defaultUser.displayName, expiresAt: null, usedAt: null, reusable: true });
  let nextEventId = 1;
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
  const readJson = async (req) => {
    const raw = (await readBody(req)).toString('utf8');
    return raw ? JSON.parse(raw) : {};
  };
  const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const deviceOf = (req, res) => {
    const d = state.devices.get(bearer(req));
    if (!d) json(res, 401, { error: 'device token required' });
    return d || null;
  };
  const writeEvent = (stream, e) => stream.write(`id: ${e.id}\nevent: ${e.eventName}\ndata: ${JSON.stringify(e.payload)}\n\n`);
  // 연결 제어 프레임: 그 연결의 일련번호를 붙인다 (스트림 핸들러가 res.batonControl 을 심어 준다)
  const sendControl = (stream, name, payload) =>
    stream.batonControl ? stream.batonControl(name, payload) : stream.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
  const emit = (deviceId, eventName, payload) => {
    const e = { id: String(nextEventId++), deviceId, eventName, payload, at: new Date().toISOString() };
    state.outbox.push(e);
    for (const s of state.streams.get(deviceId) || []) writeEvent(s, e);
    log(`EVENT ${e.id} ${eventName} device=${deviceId}`);
    return e;
  };
  // 기본 대상은 가장 최근에 pairing 된 디바이스 (테스트 엔드포인트가 deviceId 를 안 주는 경우)
  const anyDevice = () => [...state.devices.values()].at(-1) || null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    try {
      if (req.method === 'POST' && p === '/v1/devices/pair') {
        const b = await readJson(req);
        // 05 §3.4: body { code, deviceName }. 옛 필드(pairingCode)만 오면 400 (실서버 zod 검증과 같은 계층).
        if (typeof b.code !== 'string' || !b.code) return json(res, 400, { message: PAIRING_ERRORS.legacyField, error: 'Bad Request', statusCode: 400 });
        if (typeof b.deviceName !== 'string' || !b.deviceName) return json(res, 400, { message: 'deviceName 이 필요합니다', error: 'Bad Request', statusCode: 400 });
        const forbidden = (message) => json(res, 403, { message, error: 'Forbidden', statusCode: 403 });
        const pc = state.pairingCodes.get(b.code);
        log(`PAIR_ATTEMPT code=${b.code} deviceName=${b.deviceName}`);
        if (!pc) return forbidden(PAIRING_ERRORS.unknown);
        if (pc.usedAt && !pc.reusable) return forbidden(PAIRING_ERRORS.used);
        if (pc.expiresAt && pc.expiresAt <= Date.now()) return forbidden(PAIRING_ERRORS.expired);
        pc.usedAt = pc.usedAt || new Date().toISOString();
        const token = randomUUID();
        // 01 §5.3 DevicePairV2RequestSchema: platform/osVersion/appVersion/hostname 은 선택 필드
        const metadata = { platform: b.platform ?? null, osVersion: b.osVersion ?? null, appVersion: b.appVersion ?? null, hostname: b.hostname ?? null };
        const device = { id: randomUUID(), token, name: b.deviceName, userId: pc.userId, displayName: pc.displayName, ...metadata };
        state.devices.set(token, device);
        log(`PAIRED ${device.id} ${device.name} user=${device.userId} code=${b.code} platform=${metadata.platform ?? '-'} os=${metadata.osVersion ?? '-'} app=${metadata.appVersion ?? '-'} host=${metadata.hostname ?? '-'}`);
        // userId 는 계약 밖 추가 필드: 데몬이 request.claimed 의 본인 판별에 쓴다 (실서버는 주지 않음)
        return json(res, 201, { deviceId: device.id, deviceToken: token, userId: device.userId });
      }
      // 02 §7.4 heartbeat: 디바이스 정보 + 현재 실행 상태. 실서버는 Device·Agent 의 lastSeenAt 을 갱신한다.
      if (req.method === 'POST' && p === '/v1/desktop/heartbeat') {
        const d = deviceOf(req, res); if (!d) return;
        const b = await readJson(req);
        for (const k of ['platform', 'osVersion', 'appVersion', 'hostname']) if (typeof b[k] === 'string') d[k] = b[k];
        const hb = { deviceId: d.id, ...b, at: new Date().toISOString() };
        state.heartbeats.push(hb);
        for (const a of state.agents.values()) if (a.deviceId === d.id && a.status !== 'DISABLED') a.lastSeenAt = hb.at;
        log(`HEARTBEAT device=${d.id} state=${b.state || '-'} running=${(b.activeExecutionIds || []).length} platform=${b.platform || '-'} os=${b.osVersion || '-'} app=${b.appVersion || '-'} host=${b.hostname || '-'}`);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/v1/desktop/agents') {
        const d = deviceOf(req, res); if (!d) return;
        const b = await readJson(req);
        const agent = { id: randomUUID(), deviceId: d.id, displayName: b.displayName, provider: b.provider ?? 'CLAUDE_CODE', capabilities: b.capabilities, status: 'ONLINE' };
        state.agents.set(agent.id, agent);
        return json(res, 201, { agentId: agent.id });
      }
      const presence = p.match(/^\/v1\/desktop\/agents\/([^/]+)\/presence$/);
      if (req.method === 'PATCH' && presence) {
        const d = deviceOf(req, res); if (!d) return;
        const b = await readJson(req);
        const agent = state.agents.get(presence[1]);
        if (agent) agent.status = b.status;
        log(`PRESENCE ${presence[1]} ${b.status}`);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/v1/desktop/projects') {
        const d = deviceOf(req, res); if (!d) return;
        const b = await readJson(req);
        const project = { id: randomUUID(), agentId: b.agentId, displayName: b.displayName, localPathHint: b.localPathHint };
        state.projects.set(project.id, project);
        return json(res, 201, { projectId: project.id });
      }
      if (req.method === 'GET' && p === '/v1/desktop/events/stream') {
        const d = deviceOf(req, res); if (!d) return;
        // Nest @Sse 는 id 를 주지 않은 이벤트에 연결마다 1부터 번호를 매긴다. 데몬이 이 번호를
        // outbox 커서나 멱등 키로 쓰면 안 되므로 실서버와 같은 모양으로 흉내낸다 (W6d).
        let controlSeq = 0;
        const control = (name, payload) => res.write(`id: ${++controlSeq}\nevent: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
        const last = Number(req.headers['last-event-id'] || 0);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        if (!state.streams.has(d.id)) state.streams.set(d.id, new Set());
        // 디바이스당 SSE 1개: 기존 연결에 사유를 보내고 끊는다 (실서버 claimDeviceConnection 과 같은 동작)
        if (singleConnection) {
          for (const old of [...state.streams.get(d.id)]) {
            sendControl(old, 'connection.replaced', { reason: '다른 데몬이 연결되어 이전 연결을 종료합니다.' });
            state.streams.get(d.id).delete(old);
            old.end();
            log(`SSE_REPLACED device=${d.id}`);
          }
        }
        state.streams.get(d.id).add(res);
        const replay = state.outbox.filter((e) => e.deviceId === d.id && Number(e.id) > last);
        for (const e of replay) writeEvent(res, e);
        res.batonControl = control;
        control('connection.ready', { deviceId: d.id });
        log(`SSE_CONNECTED device=${d.id} lastEventId=${req.headers['last-event-id'] || 'none'} replay=${replay.length}`);
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => { clearInterval(ping); state.streams.get(d.id)?.delete(res); log(`SSE_CLOSED device=${d.id}`); });
        return;
      }
      const exec = p.match(/^\/v1\/desktop\/executions\/([^/]+)\/(status|result)$/);
      if (req.method === 'POST' && exec) {
        const d = deviceOf(req, res); if (!d) return;
        const b = await readJson(req);
        if (exec[2] === 'status') {
          state.statuses.push({ executionId: exec[1], ...b, at: new Date().toISOString() });
          // §18: 데몬이 실행 시작 보고에 claude 세션 id 를 실어 준다. 실서버는 이 값을 Execution 에 저장해
          // "추가 작업 요청" 때 resumeSessionId 로 되돌려준다. 여기서는 마지막 값을 기억만 한다.
          if (typeof b.sessionId === 'string' && b.sessionId) {
            state.sessions.set(exec[1], b.sessionId);
            log(`SESSION ${exec[1]} ${b.sessionId}`);
          }
          log(`STATUS ${exec[1]} ${b.status} ${b.phase || ''} ${(b.message || '').slice(0, 60)}`);
          return json(res, 200, { ok: true });
        }
        if (typeof b.claudeSessionId === 'string' && b.claudeSessionId) state.sessions.set(exec[1], b.claudeSessionId);
        state.results.set(exec[1], { ...b, at: new Date().toISOString() });
        log(`RESULT ${exec[1]} ${b.status || 'SUCCEEDED'} files=${(b.changedFiles || []).length} artifacts=${(b.artifactIds || []).length}${b.failureReason ? ' reason=' + String(b.failureReason).slice(0, 80) : ''}`);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/v1/uploads') {
        const d = deviceOf(req, res); if (!d) return;
        const b = await readJson(req);
        const id = randomUUID();
        state.uploads.set(id, { ...b, id, completed: false, data: null });
        return json(res, 201, { artifactId: id, uploadUrl: `http://${req.headers.host}/__upload/${id}`, method: 'PUT' });
      }
      const up = p.match(/^\/__upload\/([^/]+)$/);
      if (req.method === 'PUT' && up) {
        const u = state.uploads.get(up[1]); if (!u) return json(res, 404, { error: 'upload not found' });
        u.data = await readBody(req);
        return json(res, 200, { ok: true });
      }
      const complete = p.match(/^\/v1\/uploads\/([^/]+)\/complete$/);
      if (req.method === 'POST' && complete) {
        const u = state.uploads.get(complete[1]); if (!u) return json(res, 404, { error: 'upload not found' });
        u.completed = true;
        log(`ARTIFACT ${u.kind} ${u.filename} ${u.data ? u.data.length : 0}B`);
        return json(res, 200, { ok: true, artifactId: u.id });
      }
      const file = p.match(/^\/__files\/([^/]+)$/);
      if (req.method === 'GET' && file) {
        const f = state.files.get(file[1]); if (!f) return json(res, 404, { error: 'file not found' });
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(f);
      }
      // ---- 테스트 전용 ----
      if (req.method === 'POST' && p === '/__test/command') {
        const b = await readJson(req);
        const device = (b.deviceId && [...state.devices.values()].find((x) => x.id === b.deviceId)) || anyDevice();
        if (!device) return json(res, 409, { error: 'no paired device' });
        const executionId = b.executionId || randomUUID();
        const requestId = b.requestId || randomUUID();
        const payload = {
          eventName: 'execution.command.requested', eventId: randomUUID(), executionId, requestId, requestRevisionId: randomUUID(),
          // projectId 는 데몬이 등록한 Project 를 기본값으로 쓴다 (데몬이 projectId → 로컬 경로로 매핑하므로)
          agentId: b.agentId || [...state.agents.values()][0]?.id || randomUUID(), projectId: b.projectId || [...state.projects.values()][0]?.id || randomUUID(),
          provider: b.provider, teamId: randomUUID(), title: b.title || 'fake request', senderName: b.senderName || 'A',
          originalInstruction: b.originalInstruction || '', additionalInstruction: b.additionalInstruction || '',
          attachments: b.attachments || [], policy: b.policy || { repository_edit: 'allow', deployment_apply: 'deny' },
          acknowledgedRisks: b.acknowledgedRisks ?? [], inheritedRiskKeys: b.inheritedRiskKeys ?? [],
          webUrl: b.webUrl, limits: b.limits
        };
        // §18 추가 작업 요청 계약 (서버 CLO-8a 와 합의): 이어갈 세션 id 와 이번 회차 지시만 싣는다.
        if (b.followUpInstruction) payload.followUpInstruction = b.followUpInstruction;
        if (b.resumeSessionId !== undefined) payload.resumeSessionId = b.resumeSessionId;
        state.executions.set(executionId, { ...payload, deviceId: device.id });
        const e = emit(device.id, 'execution.command.requested', payload);
        return json(res, 201, { eventId: e.id, executionId, requestId });
      }
      // 기획서 §18 결과 검토 → "추가 작업 요청". 실서버는 RESULT_REVIEW 인 Execution 의 claudeSessionId 를
      // resumeSessionId 로 넣어 새 Execution 을 만든다. 여기서는 직전 실행의 세션 id 를 찾아 같은 모양으로 보낸다.
      if (req.method === 'POST' && p === '/__test/follow-up') {
        const b = await readJson(req);
        const prev = b.previousExecutionId && state.executions.get(b.previousExecutionId);
        if (!prev) return json(res, 404, { error: 'previousExecutionId 를 찾을 수 없음' });
        if (!b.followUpInstruction) return json(res, 400, { error: 'followUpInstruction 필요' });
        const resumeSessionId = b.resumeSessionId !== undefined ? b.resumeSessionId : (state.sessions.get(b.previousExecutionId) ?? null);
        const device = [...state.devices.values()].find((x) => x.id === prev.deviceId) || anyDevice();
        if (!device) return json(res, 409, { error: 'no paired device' });
        const executionId = b.executionId || randomUUID();
        const payload = {
          ...prev, deviceId: undefined, eventId: randomUUID(), executionId,
          // 원본 요청·추가 지시는 그대로 두되(이력용) 이번 회차 지시는 followUpInstruction 이다.
          followUpInstruction: b.followUpInstruction, resumeSessionId,
          inheritedRiskKeys: prev.acknowledgedRisks ?? [],
          attachments: b.attachments || []
        };
        delete payload.deviceId;
        state.executions.set(executionId, { ...payload, deviceId: device.id });
        const e = emit(device.id, 'execution.command.requested', payload);
        log(`FOLLOW_UP ${executionId} prev=${b.previousExecutionId} resume=${resumeSessionId ?? 'none'}`);
        return json(res, 201, { eventId: e.id, executionId, requestId: payload.requestId, resumeSessionId });
      }
      // 05 §3.4: 사용자별 1회용 pairing 코드 발급 (웹 POST /v1/me/pairing-codes 대응). expiresInMs<=0 이면 이미 만료된 코드.
      if (req.method === 'POST' && p === '/__test/pairing-codes') {
        const b = await readJson(req);
        const code = b.code || generatePairingCode();
        const expiresAt = Date.now() + Number(b.expiresInMs ?? 10 * 60 * 1000);
        state.pairingCodes.set(code, { code, userId: b.userId || defaultUser.id, displayName: b.displayName || defaultUser.displayName, expiresAt, usedAt: null, reusable: false });
        log(`PAIRING_CODE_ISSUED ${code} user=${b.userId || defaultUser.id}`);
        return json(res, 201, { code, expiresAt: new Date(expiresAt).toISOString(), userId: b.userId || defaultUser.id });
      }
      // request.delivered. recipientTeam 을 주고 recipientUserId 를 비우면 팀 전체 뿌리기(05 §3.2): 모든(또는 deviceIds) 디바이스에 보낸다.
      if (req.method === 'POST' && p === '/__test/notify') {
        const b = await readJson(req);
        const requestId = b.requestId || randomUUID();
        const broadcast = !!b.recipientTeam && (b.recipientUserId === null || b.recipientUserId === undefined);
        const payload = { requestId, title: b.title || 'fake request', senderName: b.senderName || 'A', webUrl: b.webUrl };
        if (b.senderTeam) payload.senderTeam = b.senderTeam;
        if (b.recipientTeam) { payload.recipientTeam = b.recipientTeam; payload.recipientUserId = broadcast ? null : b.recipientUserId; }
        let targets;
        if (Array.isArray(b.deviceIds)) targets = [...state.devices.values()].filter((x) => b.deviceIds.includes(x.id));
        else if (b.deviceId) targets = [...state.devices.values()].filter((x) => x.id === b.deviceId);
        else if (broadcast) targets = [...state.devices.values()].filter((x) => !b.senderUserId || x.userId !== b.senderUserId);
        else targets = [anyDevice()].filter(Boolean);
        if (!targets.length) return json(res, 409, { error: 'no paired device' });
        const events = targets.map((d) => emit(d.id, 'request.delivered', payload));
        return json(res, 201, { eventId: events[0].id, eventIds: events.map((e) => e.id), requestId, broadcast });
      }
      // 05 §3.2 claim: claimedBy 가 아닌 팀원(디바이스)에게 request.claimed. includeSelf 면 본인 디바이스에도 보낸다(데몬의 본인 판별 검증용).
      if (req.method === 'POST' && p === '/__test/claim') {
        const b = await readJson(req);
        if (!b.requestId || !b.claimedBy) return json(res, 400, { error: 'requestId, claimedBy 필요' });
        // 서버 계약(05 §3.2 확정): claimedBy = { id, email, displayName }. userId 로 주면 id 로 옮긴다.
        const raw = typeof b.claimedBy === 'string' ? { displayName: b.claimedBy } : b.claimedBy;
        const claimedBy = { id: raw.id ?? raw.userId ?? null, email: raw.email ?? null, displayName: raw.displayName };
        const targets = [...state.devices.values()].filter((d) => b.includeSelf || !claimedBy.id || d.userId !== claimedBy.id);
        const payload = { requestId: b.requestId, title: b.title, recipientTeam: b.recipientTeam ?? { id: 'team_infra', name: 'infra' }, recipientUserId: claimedBy.id, claimedBy, claimedAt: new Date().toISOString(), webUrl: b.webUrl };
        const events = targets.map((d) => emit(d.id, 'request.claimed', payload));
        log(`CLAIMED ${b.requestId} by=${claimedBy.displayName} targets=${targets.length}`);
        return json(res, 201, { eventIds: events.map((e) => e.id), targets: targets.map((d) => d.id) });
      }
      // 01 §5.4 취소: 서버는 Execution 을 CANCELLED 로 바꾼 뒤 데몬에 이 이벤트를 보낸다.
      if (req.method === 'POST' && p === '/__test/cancel') {
        const b = await readJson(req);
        if (!b.executionId) return json(res, 400, { error: 'executionId 필요' });
        const known = state.executions.get(b.executionId);
        const device = (b.deviceId && [...state.devices.values()].find((x) => x.id === b.deviceId)) || (known && [...state.devices.values()].find((x) => x.id === known.deviceId)) || anyDevice();
        if (!device) return json(res, 409, { error: 'no paired device' });
        const payload = { eventName: 'execution.command.cancel_requested', executionId: b.executionId, requestId: b.requestId || known?.requestId || randomUUID() };
        if (b.reason) payload.reason = b.reason;
        const e = emit(device.id, 'execution.command.cancel_requested', payload);
        return json(res, 201, { eventId: e.id, executionId: b.executionId });
      }
      // 중복 데몬: 기존 연결에 connection.replaced 를 보내고 끊는다 (singleConnection 을 켜지 않고 직접 재현할 때)
      if (req.method === 'POST' && p === '/__test/supersede') {
        const b = await readJson(req);
        const reason = b.reason || '다른 데몬이 연결되어 이전 연결을 종료합니다.';
        // 서버는 이유에 따라 다른 이벤트를 보낸다 (connections.ts)
        const eventName = b.eventName === 'connection.revoked' ? 'connection.revoked' : 'connection.replaced';
        let count = 0;
        for (const [deviceId, set] of state.streams) {
          if (b.deviceId && deviceId !== b.deviceId) continue;
          for (const s2 of [...set]) {
            sendControl(s2, eventName, { reason });
            set.delete(s2);
            s2.end();
            count += 1;
          }
        }
        log(`TEST_SUPERSEDED streams=${count}`);
        return json(res, 200, { ok: true, replaced: count });
      }
      if (req.method === 'POST' && p === '/__test/disconnect') {
        for (const [, set] of state.streams) for (const s of set) s.destroy();
        log('TEST_STREAMS_DROPPED');
        return json(res, 200, { ok: true });
      }
      const replay = p.match(/^\/__test\/replay\/(\d+)$/);
      if (req.method === 'POST' && replay) {
        const e = state.outbox.find((x) => x.id === replay[1]); if (!e) return json(res, 404, { error: 'event not found' });
        for (const s of state.streams.get(e.deviceId) || []) writeEvent(s, e);
        log(`TEST_DUPLICATE_SENT ${e.id}`);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'PUT' && file) {
        state.files.set(file[1], await readBody(req));
        return json(res, 200, { ok: true, url: `http://${req.headers.host}/__files/${file[1]}` });
      }
      if (req.method === 'GET' && p === '/__test/state') {
        return json(res, 200, {
          devices: [...state.devices.values()].map((d) => ({ id: d.id, name: d.name, userId: d.userId, platform: d.platform ?? null, osVersion: d.osVersion ?? null, appVersion: d.appVersion ?? null, hostname: d.hostname ?? null })),
          heartbeats: state.heartbeats,
          pairingCodes: [...state.pairingCodes.values()].map((c) => ({ code: c.code, userId: c.userId, usedAt: c.usedAt, expiresAt: c.expiresAt ? new Date(c.expiresAt).toISOString() : null, reusable: c.reusable })),
          agents: [...state.agents.values()], projects: [...state.projects.values()],
          outbox: state.outbox.map((e) => ({ id: e.id, eventName: e.eventName })), statuses: state.statuses,
          results: Object.fromEntries(state.results), sessions: Object.fromEntries(state.sessions), artifacts: [...state.uploads.values()].map((u) => ({ id: u.id, kind: u.kind, filename: u.filename, bytes: u.data ? u.data.length : 0, completed: u.completed }))
        });
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });

  const listening = new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  return {
    server, state, emit,
    url: () => `http://127.0.0.1:${server.address().port}`,
    ready: listening,
    close: () => new Promise((resolve) => { for (const [, set] of state.streams) for (const s of set) s.destroy(); server.close(() => resolve()); })
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fake = createFakeServer({ port: Number(process.env.PORT || 4180), pairingCode: process.env.PAIRING_CODE || 'BATON-PAIR-123', log: (l) => console.log(`[${new Date().toISOString()}] ${l}`) });
  fake.ready.then((url) => console.log(`FAKE_SERVER_LISTENING ${url} pairingCode=${process.env.PAIRING_CODE || 'BATON-PAIR-123'}`));
  if (process.env.FAKE_STATE_DUMP) process.on('SIGTERM', () => { fs.writeFileSync(process.env.FAKE_STATE_DUMP, JSON.stringify({ statuses: fake.state.statuses, results: Object.fromEntries(fake.state.results) }, null, 2)); process.exit(0); });
}
