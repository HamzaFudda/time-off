import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { TimeOffRequestEntity } from './entities/time-off-request.entity';
import { TimeOffBalanceEntity } from './entities/time-off-balance.entity';
import { BalanceSyncLogEntity } from './entities/balance-sync-log.entity';

/**
 * TimeOffModule encapsulates all time-off domain logic.
 * Services, controllers, and repositories are all wired here.
 *
 * HttpModule is registered here for HcmClientService to use for outbound calls.
 * ConfigModule is global so no explicit import is strictly needed, but it's
 * listed for clarity.
 *
 * Importing TypeOrmModule.forFeature here gives us typed Repository<T> injection
 * in all services within this module.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      TimeOffRequestEntity,
      TimeOffBalanceEntity,
      BalanceSyncLogEntity,
    ]),
    HttpModule,
    ConfigModule,
  ],
  controllers: [], // Controllers added in Phase 5
  providers: [], // Services added in Phase 4
  exports: [TypeOrmModule],
})
export class TimeOffModule {}
