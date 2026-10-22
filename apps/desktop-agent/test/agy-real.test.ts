import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AgyAdapter } from '../src/adapter/agy';
import { PolicySchema } from '../src/transport/events';
import { makeProject, tmpDir } from './helpers';

// 비용이 드는 실제 agy 실측은 BATON_RUN_REAL_AGY=1 로 켠다.
test('실제 Antigravity: stream-json 진행·파일 수정·계층2 patch·계층3 최종 응답', { skip: process.env.BATON_RUN_REAL_AGY !== '1', timeout: 180_000 }, async () => {
  const home = tmpDir('agy-real-home');
  const project = makeProject(tmpDir('agy-real-project'));
  const adapter = new AgyAdapter({ home, timeoutMs: 150_000 });
  const detected = await adapter.detect();
  assert.equal(detected.available, true, detected.reason ?? 'agy binary not available');

  const phases: string[] = [];
  const result = await adapter.createRunner().run(
    {
      executionId: 'agy-real',
      requestId: 'agy-real',
      projectRoot: project,
      model: 'gemini-3.8-flash-low',
      originalInstruction:
        'src/add.js의 return a - b를 return a + b로 고치고 node --test로 확인하세요. 다른 파일은 수정하지 마세요. 자동화 테스트이므로 확인 질문 없이 즉시 파일을 수정하세요.',
      policy: PolicySchema.parse({ deployment_apply: 'allow', network_outbound: 'allow' }),
      attachments: []
    },
    { onProgress: (event) => phases.push(event.phase) }
  );

  const evidence = path.join(__dirname, 'e2e-logs', 'clo109');
  fs.mkdirSync(evidence, { recursive: true });
  for (const [source, name] of [
    [result.dir.manifestPath, 'real-manifest.json'],
    [result.dir.streamPath, 'real-stream.jsonl'],
    [result.dir.gitPatchPath, 'real.patch'],
    [result.dir.resultMdPath, 'real-result.md']
  ]) {
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(evidence, name));
  }

  process.stderr.write(
    `AGY_REAL outcome=${result.outcome} exit=${result.exitCode} session=${result.sessionId} changed=${result.collected.changedFiles.join(',')} phases=${phases.join(',')} home=${home}\n`
  );

  assert.equal(result.outcome, 'success', result.failureReason ?? '');
  assert.match(fs.readFileSync(path.join(project, 'src/add.js'), 'utf8'), /a \+ b/);
  assert.deepEqual(result.collected.changedFiles, ['src/add.js']);
  assert.ok(result.collected.patch.includes('+  return a + b;'));
  assert.ok(result.collected.resultMd);
  assert.ok(phases.includes('started') && phases.includes('finished'));
});
