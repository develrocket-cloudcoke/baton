import { DownloadOptions, downloadHeaders } from './download-options';
import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PrismaService } from '../prisma.service';
import { canAccessRequestContent, isSenderOnly } from '../requests/request-access';
export interface Storage {
  issuePut(key: string, sha256: string): Promise<string>;
  issueGet(key: string, options?: DownloadOptions): Promise<string>;
  verify(key: string, sha256: string): Promise<boolean>;
}
/** 개발용 자체 서명 URL을 제공한다. 운영 S3 구현은 별도 모듈에서 이 인터페이스를 구현한다. */
@Injectable()
export class LocalDiskStorage implements Storage {
  private root = process.env.STORAGE_DIR || '/tmp/baton-storage';
  private secret = process.env.STORAGE_SECRET || 'baton-storage-secret';
  private token(key: string, sha: string) {
    return createHash('sha256').update(`${key}:${sha}:${this.secret}`).digest('hex');
  }
  async issuePut(key: string, sha: string) {
    return `/v1/storage/local/${encodeURIComponent(key)}?sha256=${sha}&token=${this.token(key, sha)}`;
  }
  async issueGet(key: string, options?: DownloadOptions) {
    const { disposition, contentType } = downloadHeaders(options);
    const expires = String(Date.now() + 900_000);
    const token = this.getToken(key, expires, disposition, contentType);
    const query = new URLSearchParams({ expires, disposition, contentType, token });
    return `/v1/storage/local/${encodeURIComponent(key)}?${query}`;
  }
  private getToken(key: string, expires: string, disposition: string, contentType: string) {
    return createHmac('sha256', this.secret).update(JSON.stringify([key, expires, disposition, contentType])).digest('hex');
  }
  validGet(key: string, expires: string, disposition: string, contentType: string, token: string) {
    if (!/^\d+$/.test(expires ?? '') || Number(expires) <= Date.now() || !/^[a-f0-9]{64}$/.test(token ?? '')) return false;
    const expected = this.getToken(key, expires, disposition, contentType);
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(token, 'hex'));
  }
  async verify(key: string, sha: string) {
    try {
      return (
        createHash('sha256')
          .update(await readFile(join(this.root, key)))
          .digest('hex') === sha
      );
    } catch {
      return false;
    }
  }
  async put(key: string, bytes: Buffer) {
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  async get(key: string) {
    return readFile(join(this.root, key));
  }
  valid(key: string, sha: string, token: string) {
    return token === this.token(key, sha);
  }
}
@Injectable()
export class S3Storage implements Storage {
  // S3_ENDPOINT 를 주면 S3 호환 저장소(dev 클러스터의 MinIO 등)를 가리킨다. MinIO 는
  // 버킷을 서브도메인이 아니라 경로로 받으므로 path-style 이 필요하다. 주지 않으면 AWS S3.
  private readonly client = new S3Client({
    region: process.env.AWS_REGION ?? 'ap-northeast-2',
    ...(process.env.S3_ENDPOINT
      ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true }
      : {}),
  });
  private readonly bucket = process.env.S3_BUCKET ?? '';
  async issuePut(key: string, sha256: string) {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
      }),
      { expiresIn: 900 },
    );
  }
  async issueGet(key: string, options?: DownloadOptions) {
    const headers = options ? downloadHeaders(options) : undefined;
    return getSignedUrl(this.client, new GetObjectCommand({
      Bucket: this.bucket, Key: key,
      ...(headers ? { ResponseContentDisposition: headers.disposition, ResponseContentType: headers.contentType } : {}),
    }), { expiresIn: 900 });
  }
  // ChecksumMode 를 켜지 않으면 HeadObject 가 체크섬을 돌려주지 않아 항상 불일치가 된다.
  // 객체가 없을 때 ListBucket 권한이 없으면 404 대신 403 이 오지만, 어느 쪽이든 false 다.
  async verify(key: string, sha256: string) {
    try {
      return (
        (
          await this.client.send(
            new HeadObjectCommand({ Bucket: this.bucket, Key: key, ChecksumMode: 'ENABLED' }),
          )
        ).ChecksumSHA256 === Buffer.from(sha256, 'hex').toString('base64')
      );
    } catch {
      return false;
    }
  }
}
@Injectable()
export class StorageService {
  // tsx e2e 에는 decorator metadata 가 없어 명시적 @Inject 가 필요하다 (W5d-2)
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(LocalDiskStorage) private local: LocalDiskStorage,
    @Inject(S3Storage) private s3: S3Storage,
  ) {}
  private get store(): Storage {
    return process.env.STORAGE_DRIVER === 's3' ? this.s3 : this.local;
  }
  async create(userId: string, b: any) {
    // 요청에 묶인 업로드(첨부·실행 결과)는 요청 접근 권한으로 판단한다. 팀 간 요청에서는 수신자(와 그 데몬)가
    // 발신 팀 소속이 아니므로 teamId 멤버십만 보면 403 이 난다 (W5d-2 수정). 요청 없는 업로드는 팀 멤버십을 본다.
    if (b.requestId) {
      const r = await this.prisma.request.findUnique({ where: { id: b.requestId } });
      if (!r || !(await canAccessRequestContent(this.prisma, r, userId)))
        throw new ForbiddenException();
    } else {
      const member = await this.prisma.teamMembership.findUnique({
        where: { teamId_userId: { teamId: b.teamId, userId } },
      });
      if (!member) throw new ForbiddenException();
    }
    const key = `artifacts/${randomUUID()}-${b.filename}`;
    const artifact = await this.prisma.artifact.create({
      data: {
        teamId: b.teamId,
        ownerUserId: userId,
        requestId: b.requestId,
        kind: b.kind,
        filename: b.filename,
        mimeType: b.mimeType,
        storageRef: key,
        sha256: b.sha256,
        sizeBytes: b.sizeBytes,
      },
    });
    return {
      artifact,
      artifactId: artifact.id,
      method: 'PUT',
      uploadUrl: await this.store.issuePut(key, b.sha256),
      downloadUrl: await this.store.issueGet(key),
    };
  }
  async complete(userId: string, artifactId: string, sha256: string) {
    const artifact = await this.prisma.artifact.findUnique({ where: { id: artifactId } });
    if (!artifact || artifact.ownerUserId !== userId) throw new NotFoundException();
    if (artifact.sha256 !== sha256 || !(await this.store.verify(artifact.storageRef, sha256)))
      throw new ForbiddenException('업로드 검증에 실패했습니다.');
    return { ok: true, artifactId };
  }
  // 에이전트가 만든 산출물. 실행자 컴퓨터의 명령·경로·변경 내용이 그대로 들어 있다.
  private static readonly RESULT_SIDE_KINDS = ['RESULT_ATTACHMENT', 'PATCH', 'TEST_OUTPUT'];

  /**
   * CLO-141: 발신자가 승인 전에 결과 산출물을 내려받지 못하게 막는다.
   *
   * 지금까지는 요청 접근 권한만 봐서 **요청자가 승인 전에 result.md·changes.patch·
   * stream.jsonl 을 그대로 받을 수 있었다**(2026-09-21 확인). 웹 UI 가 안 보여 줄 뿐이었다.
   *
   * 여는 경우는 둘뿐이다.
   * - 승인된 결과의 산출물: 승인은 곧 요청자에게 전달한다는 뜻이다
   * - 반려하며 실행자가 명시적으로 연 result.md **한 건**: disclosedArtifactId 와 정확히 같을 때만
   */
  private async senderMayReadResultArtifact(artifactId: string, requestId: string) {
    const results = await this.prisma.result.findMany({
      where: { execution: { requestId } },
      select: { reviewStatus: true, artifactIds: true, disclosedArtifactId: true },
    });
    return results.some(
      (r) =>
        r.disclosedArtifactId === artifactId ||
        (r.reviewStatus === 'APPROVED' &&
          Array.isArray(r.artifactIds) &&
          (r.artifactIds as unknown[]).includes(artifactId)),
    );
  }

  async artifact(userId: string, id: string, disposition: 'inline' | 'attachment' = 'attachment') {
    const a = await this.prisma.artifact.findUnique({ where: { id }, include: { request: true } });
    if (!a) throw new NotFoundException();
    // 팀 멤버(발신 팀) 또는 요청 접근 권한자(수신자·수신 팀원·그 디바이스) (W5d-2 수정)
    const m = await this.prisma.teamMembership.findUnique({
      where: { teamId_userId: { teamId: a.teamId, userId } },
    });
    const viaRequest = a.request
      ? await canAccessRequestContent(this.prisma, a.request, userId)
      : false;
    // CLO-20: 상위 요청의 첨부를 넘겨받은 하위 요청의 팀도 내려받을 수 있다(첨부 하나가 여러 하위 요청에 실릴 수 있다).
    let viaDelegatedRequest = false;
    if (!m && !viaRequest) {
      const revisions = await this.prisma.requestRevision.findMany({
        where: { artifactIds: { array_contains: id }, request: { parentRequestId: { not: null } } },
        include: { request: true },
      });
      for (const revision of revisions) {
        if (await canAccessRequestContent(this.prisma, revision.request, userId)) { viaDelegatedRequest = true; break; }
      }
    }
    if (!m && !viaRequest && !viaDelegatedRequest) throw new ForbiddenException();
    if (a.request && StorageService.RESULT_SIDE_KINDS.includes(a.kind)) {
      // 발신 팀 멤버라는 이유만으로 통과시키면 같은 팀의 다른 사람이 우회한다. 요청 기준으로 본다.
      const senderOnly = await isSenderOnly(this.prisma, a.request, userId);
      if (senderOnly && !(await this.senderMayReadResultArtifact(a.id, a.request.id)))
        throw new ForbiddenException('승인 전 실행 결과 산출물입니다.');
    }
    return { ...a, downloadUrl: await this.store.issueGet(a.storageRef, { filename: a.filename, mimeType: a.mimeType, disposition }) };
  }
}
