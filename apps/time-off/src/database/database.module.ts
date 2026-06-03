import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TimeOffRequestEntity } from '../time-off/entities/time-off-request.entity';
import { TimeOffBalanceEntity } from '../time-off/entities/time-off-balance.entity';
import { BalanceSyncLogEntity } from '../time-off/entities/balance-sync-log.entity';

/**
 * DatabaseModule sets up TypeORM with SQLite using async ConfigService.
 *
 * Key configuration decisions:
 *
 * - `synchronize: true` in development/test: TypeORM auto-creates/alters tables
 *   on startup. This is intentional for local dev speed — in production, set
 *   synchronize: false and use migrations instead.
 *
 * - `DB_PATH=:memory:` in tests: Each test suite gets a fresh in-memory SQLite
 *   database. This gives us full isolation without needing to clean up files.
 *
 * - `logging: ['error']` in production, `logging: false` in test: We don't want
 *   SQL noise in test output.
 *
 * - All three entities are registered here centrally. Individual feature modules
 *   use `TypeOrmModule.forFeature([EntityName])` to get their repositories.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => {
        const isTest = config.get<string>('NODE_ENV') === 'test';
        const dbPath = config.get<string>('DB_PATH', './data/time-off.sqlite');

        return {
          type: 'better-sqlite3',
          database: dbPath,
          entities: [
            TimeOffRequestEntity,
            TimeOffBalanceEntity,
            BalanceSyncLogEntity,
          ],
          synchronize: true, // Always sync schema — use migrations in production
          logging: isTest ? false : ['error'],
          // Prevent TypeORM from closing the connection in tests (causes flakiness)
          extra: isTest ? { fileMustExist: false } : {},
        };
      },
      inject: [ConfigService],
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
