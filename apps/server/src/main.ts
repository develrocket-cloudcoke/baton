import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  // 웹(Next.js)은 다른 origin 에서 쿠키 인증으로 호출하므로 credentials 포함 CORS 를 허용한다.
  // 여러 origin 은 쉼표로 구분 (예: http://localhost:3000,http://127.0.0.1:3000)
  const webOrigins = (process.env.WEB_ORIGIN ?? 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({ origin: webOrigins, credentials: true });
  app.useGlobalFilters(new HttpExceptionFilter());
  SwaggerModule.setup(
    'docs',
    app,
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Baton API').setVersion('1').addBearerAuth().build(),
    ),
  );
  // HOST 를 주면 그 인터페이스에만 연다. 테스터와 지정한 네트워크로 붙을 때 사내망·공용 와이파이까지
  // 열리는 것을 막는다. 지정하지 않으면 종전대로 모든 인터페이스에 연다.
  await app.listen(Number(process.env.PORT ?? 3001), process.env.HOST ?? '0.0.0.0');
}

void bootstrap();
