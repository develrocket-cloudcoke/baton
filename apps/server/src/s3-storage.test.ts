import assert from 'node:assert/strict';
import test from 'node:test';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { S3Storage } from './storage/storage.service';

// 2026-09-23 dev 배포 준비 중 발견: HeadObject 에 ChecksumMode 를 주지 않으면 S3 가
// ChecksumSHA256 을 돌려주지 않는다. 로컬은 LocalDiskStorage 라 드러나지 않았고,
// S3 로 올렸다면 모든 업로드 완료(complete)가 "업로드 검증에 실패했습니다" 로 끝났다.

const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const b64 = Buffer.from(sha, 'hex').toString('base64');

function storageWith(send: (cmd: unknown) => Promise<unknown>) {
  const s = new S3Storage();
  (s as any).client = { send };
  return s;
}

test('verify 는 ChecksumMode 를 켜서 HeadObject 하고 체크섬을 비교한다', async () => {
  const seen: any[] = [];
  const s = storageWith(async (cmd) => {
    seen.push(cmd);
    return { ChecksumSHA256: b64 };
  });
  assert.equal(await s.verify('artifacts/x', sha), true);
  assert.ok(seen[0] instanceof HeadObjectCommand);
  assert.equal(seen[0].input.ChecksumMode, 'ENABLED');
});

test('체크섬이 다르거나 없으면 false', async () => {
  assert.equal(await storageWith(async () => ({ ChecksumSHA256: 'AAAA' })).verify('k', sha), false);
  assert.equal(await storageWith(async () => ({})).verify('k', sha), false);
});

test('객체가 없을 때 403(ListBucket 없음)이든 404 든 false', async () => {
  for (const status of [403, 404]) {
    const s = storageWith(async () => {
      throw Object.assign(new Error('x'), { $metadata: { httpStatusCode: status } });
    });
    assert.equal(await s.verify('k', sha), false);
  }
});
