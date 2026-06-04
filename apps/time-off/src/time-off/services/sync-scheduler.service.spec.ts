/**
 * SyncSchedulerService — Unit Tests
 *
 * Coverage strategy:
 *
 * ┌──────────────────────────┬────────────────────────────────────────────────┐
 * │ Method                   │ Scenarios covered                              │
 * ├──────────────────────────┼────────────────────────────────────────────────┤
 * │ handleScheduledBatchSync │ delegates to runBatchSync, logs result,        │
 * │                          │ does NOT throw on HCM failure (cron safety)    │
 * │ triggerManualSync        │ delegates with correct triggeredBy label,      │
 * │                          │ propagates errors to caller                    │
 * └──────────────────────────┴────────────────────────────────────────────────┘
 *
 * NOTE: The @Cron decorator is a NestJS scheduler concern — we test the
 * method body directly. Cron scheduling/timing is framework-level behavior
 * that belongs in an integration test, not a unit test.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { SyncSchedulerService } from './sync-scheduler.service';
import { TimeOffBalanceService } from './time-off-balance.service';
import { HcmUnavailableError } from '../../shared/error/error';

describe('SyncSchedulerService', () => {
  let service: SyncSchedulerService;
  let balanceService: jest.Mocked<TimeOffBalanceService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncSchedulerService,
        {
          provide: TimeOffBalanceService,
          useValue: {
            runBatchSync: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(SyncSchedulerService);
    balanceService = module.get(TimeOffBalanceService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('handleScheduledBatchSync (cron handler)', () => {
    it('calls runBatchSync with the scheduled cron label', async () => {
      balanceService.runBatchSync.mockResolvedValue({ updated: 3, failed: 0 });

      await service.handleScheduledBatchSync();

      expect(balanceService.runBatchSync).toHaveBeenCalledWith(
        'scheduler:cron-8h',
      );
    });

    it('does NOT throw when HCM is unavailable — logs error and returns gracefully', async () => {
      // CRITICAL: the cron handler must never throw or the NestJS
      // scheduler will catch the unhandled rejection and may stop scheduling.
      balanceService.runBatchSync.mockRejectedValue(
        new HcmUnavailableError('HCM down'),
      );

      await expect(service.handleScheduledBatchSync()).resolves.toBeUndefined();
    });

    it('does NOT throw on unexpected errors — logs and returns gracefully', async () => {
      balanceService.runBatchSync.mockRejectedValue(
        new Error('Unexpected DB failure'),
      );

      await expect(service.handleScheduledBatchSync()).resolves.toBeUndefined();
    });
  });

  describe('triggerManualSync', () => {
    it('delegates to runBatchSync with the provided triggeredBy label', async () => {
      balanceService.runBatchSync.mockResolvedValue({ updated: 5, failed: 1 });

      const result = await service.triggerManualSync('ops:incident-23');

      expect(balanceService.runBatchSync).toHaveBeenCalledWith(
        'manual:ops:incident-23',
      );
      expect(result).toEqual({ updated: 5, failed: 1 });
    });

    it('propagates HcmUnavailableError to the caller (manual trigger has a live caller to report to)', async () => {
      balanceService.runBatchSync.mockRejectedValue(
        new HcmUnavailableError('HCM down'),
      );

      // Unlike the cron handler, the manual trigger has a real HTTP caller —
      // it should propagate the error so the API can return 503.
      await expect(
        service.triggerManualSync('webhook:workday'),
      ).rejects.toThrow(HcmUnavailableError);
    });
  });
});
