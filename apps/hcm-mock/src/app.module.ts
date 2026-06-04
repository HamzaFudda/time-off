import { Module } from '@nestjs/common';
import { HcmController } from './hcm.controller';
import { HcmService } from './hcm.service';

/**
 * HCM Mock Application Module.
 *
 * This is an intentionally minimal NestJS application. It has no database,
 * no configuration module, no schedule module — none of the complexity of
 * the real time-off service. Its sole job is to faithfully simulate the
 * HCM API contract:
 *
 *  - GET  /balances            → real-time point lookup
 *  - GET  /balances/batch      → full company pull
 *  - POST /deductions          → idempotent deduction write
 *  - POST /deductions/:id/reverse → reversal acknowledgment
 *
 * Admin endpoints (prefixed /admin) exist purely for test orchestration:
 *  - PATCH /admin/balances     → simulate out-of-band HCM mutations
 *  - GET   /admin/mutation-log → inspect what changed since startup
 *  - POST  /admin/chaos        → enable/disable random 500s
 */
@Module({
  controllers: [HcmController],
  providers: [HcmService],
})
export class AppModule {}
