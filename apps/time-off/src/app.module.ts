import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './database/database.module';
import { TimeOffModule } from './time-off/time-off.module';

/**
 * Root application module.
 *
 * - ConfigModule.forRoot({ isGlobal: true }): Makes ConfigService available
 *   everywhere without needing to import ConfigModule in each feature module.
 *   Reads from .env (or .env.test via setup-env.ts in tests).
 *
 * - ScheduleModule.forRoot(): Enables @Cron decorators across the app.
 *   Used by SyncSchedulerService for periodic batch syncs.
 *
 * - DatabaseModule: TypeORM connection and entity registration.
 *
 * - TimeOffModule: All domain logic, controllers, and services.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: process.env.NODE_ENV === 'test' ? '.env.test' : '.env',
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    TimeOffModule,
  ],
})
export class AppModule {}
