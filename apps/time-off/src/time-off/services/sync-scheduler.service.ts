import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TimeOffBalanceService } from './time-off-balance.service';

/**
 * SyncSchedulerService — background cron worker for batch HCM reconciliation.
 *
 * This is the third safety net (after real-time pre-flight and webhooks).
 * It catches balance changes that were never pushed to us via webhook:
 *   - Work anniversary bonuses
 *   - Year-start leave balance resets
 *   - Manual HR corrections in the HCM
 *
 * Schedule rationale (TRD §9):
 * The 8-hour interval is an assessment default. In production, the schedule
 * would be determined by asking the HCM team:
 *   - "How often do out-of-band balance changes happen?"
 *   - "Are they on a known schedule (e.g., nightly at 2am) or random?"
 * If they happen at a known window, we'd schedule the cron right after that
 * window rather than polling blindly every 8 hours.
 *
 * The job is idempotent: running it twice in a row has the same effect as
 * running it once (latest HCM data overwrites whatever is in cache).
 */
@Injectable()
export class SyncSchedulerService {
  private readonly logger = new Logger(SyncSchedulerService.name);

  constructor(private readonly balanceService: TimeOffBalanceService) {}

  /**
   * Primary scheduled batch sync — runs every 8 hours.
   * See TRD §9 for why 8 hours was chosen for the assessment scope.
   */
  @Cron('0 0 */8 * * *') // Every 8 hours on the dot
  async handleScheduledBatchSync(): Promise<void> {
    this.logger.log('Scheduled batch sync: starting');

    try {
      const result =
        await this.balanceService.runBatchSync('scheduler:cron-8h');
      this.logger.log(
        `Scheduled batch sync complete — updated: ${result.updated}, failed: ${result.failed}`,
      );
    } catch (err) {
      this.logger.error(
        `Scheduled batch sync failed: ${(err as Error).message}`,
      );
      // Do NOT rethrow — a cron failure should never crash the process.
      // The next run will retry automatically.
    }
  }

  /**
   * Manual trigger — exposed via SyncController for:
   *   - Webhook payloads from HCM telling us to refresh immediately
   *   - Manual ops invocations during incidents
   */
  async triggerManualSync(
    triggeredBy: string,
  ): Promise<{ updated: number; failed: number }> {
    this.logger.log(`Manual batch sync requested by: ${triggeredBy}`);
    return this.balanceService.runBatchSync(`manual:${triggeredBy}`);
  }
}
