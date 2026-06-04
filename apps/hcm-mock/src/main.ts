import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // The time-off client expects HCM to be on port 3001
  await app.listen(3001);
  console.log(`HCM Mock Server is running on: http://localhost:3001`);
}
bootstrap().catch((err) => console.error(err));
