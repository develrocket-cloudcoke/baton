import { createServer } from 'node:http';
import { ApiClient } from '../src/transport/api-client';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import test from 'node:test';
import { buildClaudeArgs, buildClaudeSettings, buildHookPolicy, APPROVAL_TOOLS } from '../src/adapter/claude-code/policy';
import { decidePreToolUse, decideHook } from '../src/adapter/claude-code/hook';
import { approveTool, startApprovalBridge } from '../src/adapter/claude-code/approval-mcp';
import { PolicySchema } from '../src/transport/events';
import { hookCommand } from './helpers';

const dir: any = Object.fromEntries(['root','inputDir','outputDir','policyPath','settingsPath','systemAppendPath','hookEventsPath','canaryPath'].map(k => [k, '/fixture/'+k]));
const options = {sessionId:'session',maxTurns:7,model:'model',maxBudgetUsd:3,resume:true};
const hook = {node:'/fixture/node',cli:'/fixture/cli'};
const policy = PolicySchema.parse({ approval_mode:'ask' });
const hp = buildHookPolicy(policy,dir,'/fixture/project','/fixture/home');
const blocked = {tool_name:'Bash',input:{command:'kubectl apply -f deployment.yaml'}};
const signal = () => new AbortController().signal;
const expiresAt = () => new Date(Date.now()+10_000).toISOString();

test('deny argv/settings는 기존과 동일, hook은 Git 단계 보강 스냅샷과 동일 (생략/명시 deny)', () => {
  const before = process.env.BATON_HOME; delete process.env.BATON_HOME;
  try {
    const snapshots = JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/deny-policy.json'),'utf8'));
    for (const s of snapshots) for (const mode of [undefined,'deny']) {
      const p = PolicySchema.parse({...s.policy,...(mode ? {approval_mode:mode}: {})});
      s.settings.sandbox.failIfUnavailable = process.platform === 'darwin';
      assert.equal(JSON.stringify(buildClaudeArgs(p,dir,options)),JSON.stringify(s.args));
      assert.equal(JSON.stringify(buildClaudeSettings(p,dir,hook,'/fixture/home')),JSON.stringify(s.settings));
      assert.equal(JSON.stringify(buildHookPolicy(p,dir,'/fixture/project','/fixture/home')),JSON.stringify(s.hook));
    }
  } finally { if (before === undefined) delete process.env.BATON_HOME; else process.env.BATON_HOME = before; }
});

test('ask 규칙은 정책 조합에 무관하게 모든 게이트 대상 도구 전체를 포함한다', () => {
  const commands = ['git commit -m x','git push','git checkout -b x','git switch -c x','kubectl apply -f x','helm install x','helm upgrade x','terraform apply','terraform destroy','aws s3 ls','gcloud run deploy','az deployment create','rm x','mv x y','cp x y','touch x','tee x','sed -i x','chmod 777 x','chown x y','mkdir x','npm install x','pnpm add x','pnpm install','pip install x','echo x > file','cat file'];
  for (const repository_edit of ['allow','deny']) for (const deployment_apply of ['allow','deny']) for (const network_outbound of ['allow','deny']) for (const outside_write of ['allow','deny']) for (const shell_execution of ['allow','deny','read_only']) {
    const p = PolicySchema.parse({approval_mode:'ask',repository_edit,deployment_apply,network_outbound,outside_write,shell_execution});
    const h = buildHookPolicy(p,dir,'/fixture/project','/fixture/home');
    const settings = buildClaudeSettings(p,dir,hook,'/fixture/home') as any;
    assert.deepEqual(settings.permissions.ask,['Bash','Edit','Write','NotebookEdit','MultiEdit','Read','Grep','Glob']);
    const cases = [
      ...commands.map(command => ({tool_name:'Bash',tool_input:{command}})),
      ...['Write','Edit','MultiEdit','NotebookEdit'].flatMap(tool_name => ['/fixture/project/x','/outside/x'].map(file_path => ({tool_name,tool_input:{file_path,notebook_path:file_path}}))),
      ...['Read','Grep','Glob'].map(tool_name => ({tool_name,tool_input:{file_path:'/fixture/home/.aws/credentials',path:'/fixture/home/.aws/credentials'}}))
    ];
    for (const input of cases) if (decidePreToolUse(h,input).decision === 'deny') assert.ok(settings.permissions.ask.includes(input.tool_name),JSON.stringify({p,input}));
    // 네트워크 격리는 예외 승인 불가이며 기존 정적 차단을 유지한다.
    if (network_outbound === 'deny') for (const t of ['WebFetch','WebSearch']) assert.ok(settings.permissions.deny.includes(t));
    const args = buildClaudeArgs(p,dir,options);
    assert.equal(args[args.indexOf('--permission-prompts')+1],'host');
    assert.ok(args.includes('mcp__baton_approval__approve'));
    assert.ok(!args.slice(args.indexOf('--disallowedTools')+1,args.indexOf('--permission-prompt-tool')).includes('Bash'));
  }
});

test('hook은 승인 가능한 차단만 통과, 자격증명은 hook/MCP 양쪽에서 절대 거부', async () => {
  assert.equal(decideHook(hp,{tool_name:'Bash',tool_input:blocked.input}).decision,'pass');
  const secret = {tool_name:'Read',input:{file_path:'/fixture/home/.aws/credentials'}};
  assert.equal(decideHook(hp,{tool_name:'Read',tool_input:secret.input}).decision,'deny');
  let calls = 0;
  assert.equal((await approveTool(hp,'/fixture/project','exec',secret,async()=>{calls++;return {};},signal())).behavior,'deny');
  assert.equal(calls,0);
});

test('정책상 허용 요청은 서버/사람 호출 없이 즉시 allow, 알 수 없는 도구는 deny', async () => {
  for (const [tool_name,input] of [['Bash',{command:'cat README.md'}],['Read',{file_path:'/fixture/project/a'}],['Write',{file_path:'/fixture/project/a',content:'x'}]] as const) {
    const result = await approveTool(hp,'/fixture/project','exec',{tool_name,input},undefined,signal());
    assert.deepEqual(result,{behavior:'allow',updatedInput:input});
  }
  assert.equal((await approveTool(hp,'/fixture/project','exec',{tool_name:'Unknown',input:{}},undefined,signal())).behavior,'deny');
});

test('정책 차단은 승인 생성 후 폴링, ALLOWED만 원본 입력을 허용한다', async () => {
  const calls: any[] = [];
  let reads = 0;
  const result = await approveTool(hp,'/fixture/project','exec',blocked,async(method,route,body)=>{
    calls.push({method,route,body});
    return method === 'POST' ? {approvalId:'approval',expiresAt:expiresAt()} : {status:++reads===1?'PENDING':'ALLOWED',expiresAt:expiresAt()};
  },signal(),1000,1);
  assert.deepEqual(result,{behavior:'allow',updatedInput:blocked.input});
  assert.equal(calls[0].route,'/v1/desktop/executions/exec/approvals');
  assert.equal(calls[0].body.toolName,'Bash');
  assert.equal(reads,2);
});

test('거부·만료·오류·잘못된 응답·끊긴 서버·무응답·취소는 모두 deny', async () => {
  for (const status of ['DENIED','EXPIRED','UNKNOWN',undefined]) {
    assert.equal((await approveTool(hp,'/fixture/project','exec',blocked,async method=>method==='POST'?{approvalId:'a',expiresAt:expiresAt()}:{status,expiresAt:expiresAt()},signal(),100,1)).behavior,'deny');
  }
  for (const request of [async()=>{throw new Error('offline');},async()=>({}),async()=>new Promise(()=>{})]) {
    assert.equal((await approveTool(hp,'/fixture/project','exec',blocked,request,signal(),20,1)).behavior,'deny');
  }
  const ctrl = new AbortController(); setTimeout(()=>ctrl.abort(),10);
  assert.equal((await approveTool(hp,'/fixture/project','exec',blocked,async()=>new Promise(()=>{}),ctrl.signal,1000)).behavior,'deny');
  assert.equal((await approveTool(hp,'/fixture/project','exec',blocked,async()=>({approvalId:'a',expiresAt:new Date(0).toISOString()}),signal())).behavior,'deny');
  assert.equal((await approveTool(hp,'/fixture/project','exec',blocked,async method=>method==='POST'?{approvalId:'a',expiresAt:expiresAt()}:new Promise(r=>setTimeout(()=>r({status:'ALLOWED',expiresAt:expiresAt()}),30)),signal(),10,1)).behavior,'deny');
});

test('실제 stdio MCP JSON-RPC와 실행별 브리지: allow/deny 및 연결 실패', async () => {
  const bridge = await startApprovalBridge(async args => (args as any).input.command==='ok'?{behavior:'allow',updatedInput:(args as any).input}:{behavior:'deny',message:'blocked'});
  const h = hookCommand();
  const child = spawn(h.node,[h.cli,'approval-mcp','--socket',bridge.socket],{stdio:['pipe','pipe','pipe']});
  const lines = readline.createInterface({input:child.stdout});
  let seq = 0; const pending = new Map<number,(x:any)=>void>();
  lines.on('line',line=>{const r=JSON.parse(line);pending.get(r.id)?.(r.result);pending.delete(r.id);});
  const rpc = (method:string,params:any={}) => new Promise<any>((resolve,reject)=>{
    const id=++seq;const timeout=setTimeout(()=>reject(new Error('MCP response timeout')),5000);
    pending.set(id,r=>{clearTimeout(timeout);resolve(r);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
  try {
    assert.equal((await rpc('initialize',{protocolVersion:'2024-11-05'})).serverInfo.name,'baton-approval');
    assert.equal((await rpc('tools/list')).tools[0].name,'approve');
    for (const command of ['ok','blocked']) {
      const result=await rpc('tools/call',{name:'approve',arguments:{tool_name:'Bash',input:{command}}});
      assert.equal(JSON.parse(result.content[0].text).behavior,command==='ok'?'allow':'deny');
    }
    await bridge.close();
    const result=await rpc('tools/call',{name:'approve',arguments:{tool_name:'Bash',input:{command:'ok'}}});
    assert.equal(JSON.parse(result.content[0].text).behavior,'deny');
  } finally { child.kill(); lines.close(); await bridge.close(); }
});

test('서버 마감이 짧으면 응답 없는 폴링도 그 마감에 deny', async () => {
  const start = Date.now();
  const result = await approveTool(hp,'/fixture/project','exec',blocked,async method => method === 'POST' ? {approvalId:'a',expiresAt:new Date(Date.now()+20).toISOString()} : new Promise(()=>{}),signal(),1000);
  assert.equal(result.behavior,'deny');
  assert.ok(Date.now()-start < 800);
});


test('웹 목록·결정 HTTP 계약으로 데몬의 대기가 해소되며 거부는 실행을 허용하지 않는다', async () => {
  for (const decision of ['ALLOWED','DENIED'] as const) {
    let row: any = null;
    let resolvePolled!: () => void;
    const polled = new Promise<void>(resolve => { resolvePolled = resolve; });
    const server = createServer(async (req,res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      let result: unknown;
      if (req.url === '/v1/desktop/executions/exec/approvals' && req.method === 'POST') {
        assert.equal(req.headers.authorization,'Bearer device');
        row = { id:'approval',executionId:'exec',...body,status:'PENDING',expiresAt:expiresAt() };
        result = { approvalId:row.id,expiresAt:row.expiresAt };
      } else if (req.url === '/v1/desktop/approvals/approval') {
        result = { status:row.status,expiresAt:row.expiresAt }; resolvePolled();
      } else if (req.url === '/v1/executions/exec/approvals') {
        result = [row];
      } else if (req.url === '/v1/approvals/approval/decision') {
        assert.equal(req.headers.authorization,'Bearer executor');
        row.status = body.decision; result = { status:row.status };
      } else { res.writeHead(404);res.end();return; }
      res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
    });
    await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const daemon = new ApiClient(base,'device');
    const web = new ApiClient(base,'executor');
    try {
      const result = approveTool(hp,'/fixture/project','exec',blocked,(method,route,body,signal)=>daemon.call(method,route,body,signal),signal(),3000,5);
      await polled;
      const listed = await web.call<any[]>('GET','/v1/executions/exec/approvals');
      assert.equal(listed[0].detail,blocked.input.command);
      assert.equal(listed[0].status,'PENDING');
      await web.call('POST',`/v1/approvals/${listed[0].id}/decision`,{decision});
      assert.equal((await result).behavior,decision === 'ALLOWED' ? 'allow' : 'deny');
    } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
  }
});
