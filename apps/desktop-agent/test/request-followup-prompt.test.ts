import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { makeExecDir } from '../src/adapter/claude-code/exec-dir';
import { renderFollowUpPrompt, renderPrompt } from '../src/adapter/claude-code/prompt';
import { renderCliPrompt } from '../src/adapter/common/prompt';
import { PolicySchema } from '../src/transport/events';

test('새 revision은 resume 여부와 무관하게 이전 맥락과 새 요청 본문을 외부 자료로 싣는다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-followup-'));
  try {
    const dir = makeExecDir('followup', home);
    const ctx = { executionId: 'e', requestId: 'r', projectRoot: home, attachments: [],
      policy: PolicySchema.parse({}), originalInstruction: '이번 차수 지시', additionalInstruction: '실행자 확인',
      previousWork: '1차 지시: 이전 지시\n승인·전달된 결과: 완료 요약', resumeSessionId: 'session' };
    for (const prompt of [renderPrompt(ctx, dir), renderFollowUpPrompt(ctx, dir), renderCliPrompt(ctx, dir, { writesResultFile: false }).prompt]) {
      assert.match(prompt, /이전 작업/);
      assert.match(prompt, /완료 요약/);
      assert.match(prompt, /이번 차수 지시/);
      assert.match(prompt, /request_body/);
      assert.doesNotMatch(prompt, /추가 지시 본문이 비어/);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
