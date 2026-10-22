import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
type ZodSchema = {
  safeParse(value: unknown): { success: boolean; data?: unknown; error?: { flatten(): unknown } };
};

/** 컨트롤러 DTO마다 shared Zod 계약을 적용한다. */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema?: ZodSchema) {}
  transform(value: unknown, metadata: ArgumentMetadata) {
    if (!this.schema || metadata.type !== 'body') return value;
    const parsed = this.schema.safeParse(value);
    if (!parsed.success)
      throw new BadRequestException({
        message: '요청 본문이 올바르지 않습니다.',
        errors: parsed.error?.flatten(),
      });
    return parsed.data;
  }
}
