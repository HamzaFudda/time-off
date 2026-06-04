import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Mirror the same global pipe configuration as the real time-off service
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Swagger docs — useful when manually exercising the mock during local dev
  const config = new DocumentBuilder()
    .setTitle('HCM Mock Server')
    .setDescription(
      'A faithful mock of the HCM (Human Capital Management) API. ' +
        'Simulates balance reads, idempotent deductions, reversals, ' +
        'and out-of-band mutations for testing the time-off microservice.',
    )
    .setVersion('1.0')
    .addTag('HCM Mock')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = 3001;
  await app.listen(port);

  console.log(`HCM Mock Server is running on: http://localhost:${port}`);
  console.log(`Swagger docs at http://localhost:${port}/api/docs`);
}

bootstrap().catch((err) => console.error(err));
