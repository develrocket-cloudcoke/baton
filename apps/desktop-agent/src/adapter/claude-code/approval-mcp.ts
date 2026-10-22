import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import { APPROVAL_TTL_MS } from '@baton/shared';
import { APPROVAL_TOOLS, HookPolicy } from './policy';
import { decidePreToolUse } from './hook';
import { ExecutionContext } from '../interface';

export type Decision = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string };
const deny = (message = '승인이 없거나 마감되어 거부했습니다.'): Decision => ({ behavior: 'deny', message });
type Request = NonNullable<ExecutionContext['approvalRequest']>;

// 타임아웃은 MCP 판정 쪽에서 deny로 끝낸다. 늦게 도착한 ALLOWED는 사용하지 않는다.
export async function approveTool(policy: HookPolicy, cwd: string, executionId: string, args: unknown, request: Request | undefined, signal: AbortSignal, ttl = APPROVAL_TTL_MS, pollMs = 700): Promise<Decision> {
  const a = args as { tool_name?: unknown; input?: unknown } | null;
  if (!a || typeof a.tool_name !== 'string' || !APPROVAL_TOOLS.includes(a.tool_name as typeof APPROVAL_TOOLS[number]) || !a.input || typeof a.input !== 'object' || Array.isArray(a.input) || signal.aborted) return deny();
  const input = a.input as Record<string, unknown>;
  const decision = decidePreToolUse(policy, { tool_name: a.tool_name, tool_input: input, cwd });
  if (decision.decision !== 'deny') return { behavior: 'allow', updatedInput: input };
  // 자격증명 읽기·Git 단계·sandbox 네트워크 격리는 실행 중 승인으로 열 수 없는 경계다.
  if (decision.approvalAllowed === false || ['Read', 'Grep', 'Glob'].includes(a.tool_name) || !request) return deny(decision.reason);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const deadline = Date.now() + ttl;
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<Decision>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(deny()); }, ttl);
    controller.signal.addEventListener('abort', () => resolve(deny()), { once: true });
  });
  const work = async (): Promise<Decision> => {
    try {
      const created = await request('POST', `/v1/desktop/executions/${encodeURIComponent(executionId)}/approvals`, { toolName: a.tool_name, detail: (typeof input.command === 'string' ? input.command : JSON.stringify(input)).slice(0, 100_000), reason: decision.reason ?? '정책 차단' }, controller.signal) as { approvalId?: unknown; expiresAt?: unknown };
      if (typeof created?.approvalId !== 'string' || typeof created.expiresAt !== 'string') return deny();
      const serverDeadline = Date.parse(created.expiresAt);
      if (!Number.isFinite(serverDeadline)) return deny();
      const until = Math.min(deadline, serverDeadline);
      clearTimeout(timer!);
      timer = setTimeout(() => controller.abort(), Math.max(0, until - Date.now()));
      while (!controller.signal.aborted && Date.now() < until) {
        const status = await request('GET', `/v1/desktop/approvals/${encodeURIComponent(created.approvalId)}`, undefined, controller.signal) as { status?: string; expiresAt?: string };
        if (controller.signal.aborted || Date.now() >= until) return deny();
        if (!status || !Number.isFinite(Date.parse(status.expiresAt ?? '')) || Date.now() >= Date.parse(status.expiresAt!)) return deny();
        if (status.status === 'ALLOWED') return { behavior: 'allow', updatedInput: input };
        if (status.status !== 'PENDING') return deny();
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(t); controller.signal.removeEventListener('abort', done); resolve(); };
          const t = setTimeout(done, Math.min(pollMs, Math.max(0, until - Date.now())));
          controller.signal.addEventListener('abort', done, { once: true });
        });
      }
      return deny();
    } catch { return deny('승인 서버에 연결할 수 없어 거부했습니다.'); }
  };
  try { return await Promise.race([work(), expired]); }
  finally { clearTimeout(timer!); controller.abort(); signal.removeEventListener('abort', abort); }
}

// 디바이스 토큰을 Claude 환경/설정 파일에 넣지 않는다. 데몬에만 있는 API 클라이언트를
// 실행별 Unix 소켓으로 중계한다. 소켓 디렉터리 0700, 실행 종료 시 연결/대기를 폐기한다.
export async function startApprovalBridge(handler: (args: unknown) => Promise<Decision>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-approval-'));
  fs.chmodSync(root, 0o700);
  const socket = path.join(root, 's');
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/') throw new Error('invalid request');
      let text = '';
      for await (const chunk of req) { text += chunk.toString(); if (text.length > 1_000_000) throw new Error('too large'); }
      res.end(JSON.stringify(await handler(JSON.parse(text))));
    } catch { res.end(JSON.stringify(deny())); }
  });
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); }); }
  catch (e) { fs.rmSync(root, { recursive: true, force: true }); throw e; }
  return { socket, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); } };
}

// 의존성 없는 stdio MCP: stdout에는 JSON-RPC만 쓴다. 모델이 호출하는 일반 도구가 아니라
// --permission-prompt-tool 전용으로 사용되며 실제 판정/토큰은 부모 데몬에 남는다.
export async function runApprovalMcp(socket: string): Promise<void> {
  const lines = readline.createInterface({ input: process.stdin });
  const reply = (id: unknown, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  lines.on('line', line => { void (async () => {
    let msg: any;
    try {
      if (line.length > 1_000_000) throw new Error('too large');
      msg = JSON.parse(line);
      if (msg.id === undefined) return;
      if (msg.method === 'initialize') reply(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'baton-approval', version: '1.0.0' } });
      else if (msg.method === 'tools/list') reply(msg.id, { tools: [{ name: 'approve', description: 'Baton 실행 정책 및 사람 승인', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' } }, required: ['tool_name', 'input'] } }] });
      else if (msg.method === 'ping') reply(msg.id, {});
      else if (msg.method === 'tools/call') {
        let result: Decision = deny();
        if (msg.params?.name === 'approve') {
          result = await new Promise<Decision>(resolve => {
            const req = http.request({ socketPath: socket, path: '/', method: 'POST' }, res => {
              let text = ''; res.on('data', c => { text += c; if (text.length > 1_000_000) req.destroy(new Error('too large')); });
              res.on('end', () => { try { const value = JSON.parse(text); resolve(value.behavior === 'allow' && value.updatedInput ? value : deny()); } catch { resolve(deny()); } });
              res.on('error', () => resolve(deny()));
            });
            req.setTimeout(APPROVAL_TTL_MS + 1000, () => req.destroy(new Error('timeout')));
            req.on('error', () => resolve(deny()));
            req.end(JSON.stringify(msg.params.arguments));
          });
        }
        reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
      } else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unknown method' } }) + '\n');
    } catch { if (msg?.id !== undefined) reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(deny()) }] }); }
  })(); });
  await new Promise<void>(resolve => lines.once('close', resolve));
}
