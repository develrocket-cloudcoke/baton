require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');
const { writeFileSync } = require('node:fs');
const { AppModule } = require('../dist/app.module');
(async () => {
  const app = await NestFactory.create(AppModule, { logger: false });
  try {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Baton API').setVersion('1').addBearerAuth().build(),
    );
    writeFileSync(
      require('node:path').join(__dirname, '../w5b-swagger.json'),
      JSON.stringify(document, null, 2) + '\n',
    );
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
