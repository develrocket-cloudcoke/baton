import assert from 'node:assert/strict';
import test from 'node:test';
import { PolicySchema } from '../src/transport/events';
import { buildHookPolicy } from '../src/adapter/claude-code/policy';
import { decidePreToolUse, decideHook } from '../src/adapter/claude-code/hook';
import { approveTool } from '../src/adapter/claude-code/approval-mcp';
import { renderSystemContract } from '../src/adapter/common/contract';

const dir: any = { outputDir:'/fixture/output',hookEventsPath:'/fixture/hooks',canaryPath:'/fixture/canary' };
const local = ['git add src/a','git commit -m x','git checkout -b feature','git checkout -B feature','git switch -c feature','git switch -C feature','git switch main','git branch feature','git branch -D feature','git tag v1','git tag -d v1','git merge feature','git rebase main','git cherry-pick HEAD','git revert HEAD','git reset --hard','git restore file'];
const remote = ['git push','git push --force origin main','gh pr create','gh pr --repo owner/repo create'];
const variants = (cmd:string) => [cmd,`echo ok && ${cmd}`,cmd.replace('git ', 'git -C /fixture -c color.ui=false '),cmd.replace('git ', '"git" '),cmd.replace('git ', 'g\\it ')];
const make = (git_write:'deny'|'local'|'push',extra = {}) => buildHookPolicy(PolicySchema.parse({git_write,...extra}),dir,'/fixture/project','/fixture/home');

test('git 쓰기 deny/local/push: 기존·누락 명령과 옵션·복합 명령을 같은 단계로 제한', () => {
  assert.equal(PolicySchema.parse({}).git_write,'deny');
  for (const mode of ['deny','local','push'] as const) {
    const policy = make(mode);
    for (const cmd of local.flatMap(variants)) assert.equal(decidePreToolUse(policy,{tool_name:'Bash',tool_input:{command:cmd}}).decision,mode==='deny'?'deny':'pass',`${mode}: ${cmd}`);
    for (const cmd of remote.flatMap(variants)) assert.equal(decidePreToolUse(policy,{tool_name:'Bash',tool_input:{command:cmd}}).decision,mode==='push'?'pass':'deny',`${mode}: ${cmd}`);
    for (const command of ['git status','git diff','git log --oneline','git show HEAD']) assert.equal(decidePreToolUse(policy,{tool_name:'Bash',tool_input:{command}}).decision,'pass');
  }
});

test('git 단계는 셸/저장소 제한을 넓히지 않고 ask로 사전 승인 범위를 우회하지 않는다', async () => {
  for (const extra of [{shell_execution:'read_only'},{shell_execution:'deny'},{repository_edit:'deny'}]) {
    for (const command of [...local,...remote]) assert.equal(decidePreToolUse(make('push',extra),{tool_name:'Bash',tool_input:{command}}).decision,'deny');
  }
  for (const git_write of ['deny','local'] as const) {
    const p=make(git_write,{approval_mode:'ask'});
    for (const command of remote) {
      assert.equal(decideHook(p,{tool_name:'Bash',tool_input:{command}}).decision,'deny');
      let calls=0;
      const result=await approveTool(p,'/fixture/project','exec',{tool_name:'Bash',input:{command}},async()=>{calls++;return {};},new AbortController().signal);
      assert.equal(result.behavior,'deny');
      assert.equal(calls,0);
    }
  }
});

test('세 어댑터 공통 규약은 선택한 Git 단계와 일치하며 자격증명 제한은 유지', () => {
  for (const git_write of ['deny','local','push'] as const) {
    const text=renderSystemContract({policy:PolicySchema.parse({git_write}),projectRoot:'/project',inputDir:'/input',outputDir:'/output',resultPath:'/output/result.md',writesResultFile:true});
    assert.ok(text.includes(`git_write: ${git_write}`));
    assert.ok(text.includes('자격증명·토큰'));
    assert.ok(!text.includes('커밋·푸시·브랜치 생성은 하지 않는다.'));
    assert.ok(text.includes(git_write==='push'?'원격 푸시·PR 생성 허용':git_write==='local'?'로컬 Git 쓰기 허용':'Git 쓰기와 원격 푸시·PR 생성 금지'));
  }
});
