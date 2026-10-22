import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { TimelineEventType } from '@baton/shared';
import { PrismaService } from '../prisma.service';
import { canAccessRequestContent } from '../requests/request-access';

@Injectable()
export class DocumentsService {
  constructor(@Inject(PrismaService) private prisma: PrismaService) {}
  private ref(id: string) {
    return `inline://documents/${id}`;
  }
  private sha(content: string) {
    return createHash('sha256').update(content).digest('hex');
  }
  async create(userId: string, requestId: string, body: any) {
    const request = await this.prisma.request.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException();
    if (!([request.senderUserId, request.recipientUserId] as string[]).includes(userId))
      throw new ForbiddenException();
    const document = await this.prisma.document.create({
      data: { teamId: request.senderTeamId, ownerUserId: userId, name: body.name },
    });
    const version = await this.prisma.documentVersion.create({
      data: {
        documentId: document.id,
        versionNo: 1,
        contentRef: this.ref(randomUUID()),
        contentSha256: this.sha(body.content),
        content: body.content,
        createdByType: 'HUMAN',
        createdByUserId: userId,
        changeNote: body.changeNote,
      },
    });
    await this.prisma.document.update({
      where: { id: document.id },
      data: { currentVersionId: version.id },
    });
    // 동일 timestamp에서도 감사 이력의 의미 순서를 보장한다.
    await this.prisma.timelineEvent.create({
      data: {
        requestId,
        requestRevisionId: request.currentRevisionId,
        actorType: 'HUMAN',
        actorUserId: userId,
        eventType: TimelineEventType.DOCUMENT_CREATED,
        payload: { documentId: document.id },
      },
    });
    await this.prisma.timelineEvent.create({
      data: {
        requestId,
        requestRevisionId: request.currentRevisionId,
        actorType: 'HUMAN',
        actorUserId: userId,
        eventType: TimelineEventType.DOCUMENT_VERSION_CREATED,
        payload: { documentId: document.id, versionId: version.id },
      },
    });
    return { ...document, currentVersionId: version.id, version };
  }
  private async canReadVersion(userId: string, documentTeamId: string, versionId: string) {
    const member = await this.prisma.teamMembership.findUnique({
      where: { teamId_userId: { teamId: documentTeamId, userId } },
    });
    if (member) return true;
    const revisions = await this.prisma.requestRevision.findMany({
      where: { documentVersionIds: { array_contains: versionId } },
      include: { request: true },
    });
    for (const revision of revisions) {
      if (await canAccessRequestContent(this.prisma, revision.request, userId)) return true;
    }
    return false;
  }
  async versions(userId: string, id: string) {
    const document = await this.prisma.document.findUnique({
      where: { id },
      include: { versions: { orderBy: { versionNo: 'desc' } } },
    });
    if (!document) throw new NotFoundException();
    const allowed = await this.prisma.request.findFirst({
      where: {
        senderTeamId: document.teamId,
        OR: [{ senderUserId: userId }, { recipientUserId: userId }],
      },
    });
    if (!allowed) throw new ForbiddenException();
    return document.versions;
  }
  async addVersion(userId: string, id: string, body: any) {
    const document = await this.prisma.document.findUnique({
      where: { id },
      include: { versions: true },
    });
    if (!document) throw new NotFoundException();
    if (document.ownerUserId !== userId) throw new ForbiddenException();
    const version = await this.prisma.documentVersion.create({
      data: {
        documentId: id,
        versionNo: document.versions.length + 1,
        contentRef: this.ref(randomUUID()),
        contentSha256: this.sha(body.content),
        content: body.content,
        createdByType: 'HUMAN',
        createdByUserId: userId,
        changeNote: body.changeNote,
      },
    });
    await this.prisma.document.update({ where: { id }, data: { currentVersionId: version.id } });
    return version;
  }
  // 특정 version 의 본문. 문서 팀(발신 팀)의 사용자, 또는 그 version 이 첨부된 요청의 수신자(확정된 사람·미확정이면
  // 수신 팀원)와 그들의 디바이스(데몬)가 읽는다. (W5d-2 수정: 발신 팀원만 허용해 다른 팀 수신자·데몬이 403 을 받고
  // 실행이 FAILED 로 끝나던 문제, 05 §3.1 팀 간 요청)
  async version(userId: string, versionId: string) {
    const version = await this.prisma.documentVersion.findUnique({
      where: { id: versionId },
      include: { document: true },
    });
    if (!version) throw new NotFoundException();
    if (!(await this.canReadVersion(userId, version.document.teamId, versionId)))
      throw new ForbiddenException();
    return {
      id: version.id,
      documentId: version.documentId,
      name: version.document.name,
      mimeType: version.document.mimeType,
      versionNo: version.versionNo,
      contentSha256: version.contentSha256,
      content: version.content ?? '',
      changeNote: version.changeNote,
      createdAt: version.createdAt,
    };
  }
}
