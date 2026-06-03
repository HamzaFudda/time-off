import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { TimeOffRequestEntity } from './entities/time-off-request.entity';
import { TimeOffBalanceEntity } from './entities/time-off-balance.entity';
import { BalanceSyncLogEntity } from './entities/balance-sync-log.entity';
import { HcmClientService } from './services/hcm-client.service';
import { TimeOffBalanceService } from './services/time-off-balance.service';
import { TimeOffRequestService } from './services/time-off-request.service';
import { SyncSchedulerService } from './services/sync-scheduler.service';
import { TimeOffRequestController } from './controllers/time-off-request.controller';
import { TimeOffBalanceController } from './controllers/time-off-balance.controller';
import { SyncController } from './controllers/sync.controller';

/**
 * TimeOffModule — wires all domain pieces together.
 *
 * Dependency graph:
 *   HcmClientService           (no domain deps — pure HTTP)
 *   TimeOffBalanceService      → HcmClientService, repos
 *   TimeOffRequestService      → TimeOffBalanceService, HcmClientService, repo
 *   SyncSchedulerService       → TimeOffBalanceService
 *
 * All three repositories are registered via TypeOrmModule.forFeature.
 * HttpModule is registered here so HttpService can be injected into HcmClientService.
 * ConfigModule is global but listed for clarity.
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
  controllers: [
    TimeOffRequestController,
    TimeOffBalanceController,
    SyncController,
  ],
  providers: [
    HcmClientService,
    TimeOffBalanceService,
    TimeOffRequestService,
    SyncSchedulerService,
  ],
  exports: [TypeOrmModule, TimeOffBalanceService, TimeOffRequestService],
})
export class TimeOffModule {}
