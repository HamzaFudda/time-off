import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { TimeOffBalanceEntity } from '../entities/time-off-balance.entity';
import { BalanceSyncLogEntity } from '../entities/balance-sync-log.entity';
import { SyncTypeEnum } from '../enums/sync-type.enum';
import { HcmClientService } from './hcm-client.service';
import { NotFoundError, OptimisticLockError } from '../../shared/error/error';
import { BALANCE_ERRORS } from '../../shared/constants/error-messages.const';
import { HcmBatchResponse } from '../types/hcm.types';

/**
 * TimeOffBalanceService — owns all balance-related business rules.
 *
 * This is where the cached-balance strategy lives:
 *
 * 1. Read path (getBalance):
 *    - Return the local SQLite balance immediately (fast, available offline).
 *    - If the cache is stale (older than BALANCE_CACHE_TTL_MS), fire a
 *      non-blocking background refresh. The stale value is still returned
 *      to the caller — we don't make them wait.
 *    - Include `isStale: true` in the response so the UI can show
 *      "last synced X minutes ago".
 *
 * 2. Pre-flight path (checkSufficientBalance):
 *    - Called by TimeOffRequestService before any approval.
 *    - Gets a LIVE balance from HCM (not cached) to ensure we don't
 *      approve against stale data.
 *    - If HCM is down, throws HcmUnavailableError — approval is blocked.
 *      We don't degrade here because committing against stale data is worse
 *      than a temporary approval delay.
 *
 * 3. Reserve/release path (reserveDays / releaseDays):
 *    - Optimistic locking: every update includes WHERE version = :v.
 *    - TypeORM throws OptimisticLockVersionMismatchError on conflict.
 *    - We catch it and rethrow as OptimisticLockError so callers can retry.
 *
 * 4. Effective balance:
 *    - effectiveBalance = availableDays - reservedDays
 *    - Lives here (not on the entity) because it's a business rule,
 *      not a persistence concern.
 */
@Injectable()
export class TimeOffBalanceService {
  private readonly logger = new Logger(TimeOffBalanceService.name);

  /** See TRD §9 — derived from HCM's actual write cadence in production */
  private readonly cacheTtlMs: number;

  constructor(
    @InjectRepository(TimeOffBalanceEntity)
    private readonly balanceRepo: Repository<TimeOffBalanceEntity>,

    @InjectRepository(BalanceSyncLogEntity)
    private readonly syncLogRepo: Repository<BalanceSyncLogEntity>,

    private readonly hcmClient: HcmClientService,
    private readonly config: ConfigService,
  ) {
    this.cacheTtlMs = this.config.get<number>(
      'BALANCE_CACHE_TTL_MS',
      4 * 60 * 60 * 1000,
    ); // 4 hours
  }

  // ─── Effective Balance (business rule — not on the entity) ────────────────

  /**
   * Effective balance = max(0, availableDays - reservedDays).
   *
   * `reservedDays` represents days approved but not yet confirmed by HCM.
   * We subtract them optimistically so employees can't request the same days twice
   * during the brief window between approval and HCM confirmation.
   */
  getEffectiveBalance(balance: TimeOffBalanceEntity): number {
    return Math.max(0, balance.availableDays - balance.reservedDays);
  }

  // ─── Read Path ────────────────────────────────────────────────────────────

  /**
   * Returns the local cached balance, with a staleness flag.
   * Fires a non-blocking background refresh if the cache is stale.
   */
  async getBalance(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
  ): Promise<{
    balance: TimeOffBalanceEntity;
    effectiveBalance: number;
    isStale: boolean;
  }> {
    const balance = await this.findBalance(employeeId, locationId, leaveTypeId);

    const isStale = this.isCacheStale(balance);

    if (isStale) {
      // Non-blocking: fire and forget. The stale value is returned immediately.
      this.refreshFromHcm(
        employeeId,
        locationId,
        leaveTypeId,
        'background-ttl',
      ).catch((err) =>
        this.logger.warn(
          `Background balance refresh failed: ${(err as Error).message}`,
        ),
      );
    }

    return {
      balance,
      effectiveBalance: this.getEffectiveBalance(balance),
      isStale,
    };
  }

  /**
   * Pre-flight: fetches a LIVE balance from HCM and checks sufficiency.
   * Throws ConflictError (insufficient) or HcmUnavailableError (HCM down).
   * Called by TimeOffRequestService before any approval.
   */
  async verifyLiveBalance(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
    requiredDays: number,
  ): Promise<void> {
    // This call throws HcmUnavailableError if HCM is unreachable.
    // We intentionally let that propagate — we don't approve against stale data.
    const liveBalance = await this.hcmClient.getBalance(
      employeeId,
      locationId,
      leaveTypeId,
    );

    // Also account for any days we've already reserved locally (other in-flight approvals)
    const localBalance = await this.findBalance(
      employeeId,
      locationId,
      leaveTypeId,
    ).catch(() => null);
    const alreadyReserved = localBalance?.reservedDays ?? 0;

    const effectiveLiveBalance = Math.max(
      0,
      liveBalance.availableDays - alreadyReserved,
    );

    if (effectiveLiveBalance < requiredDays) {
      const { ConflictError } = await import('../../shared/error/error');
      throw new ConflictError(
        BALANCE_ERRORS.INSUFFICIENT_BALANCE_DETAIL(
          requiredDays,
          effectiveLiveBalance,
        ),
      );
    }
  }

  // ─── Reserve / Release ────────────────────────────────────────────────────

  /**
   * Optimistically reserve days when a request is approved (before HCM confirms).
   * Uses optimistic locking — caller must handle OptimisticLockError and retry.
   */
  async reserveDays(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
    days: number,
  ): Promise<void> {
    const balance = await this.findOrCreateBalance(
      employeeId,
      locationId,
      leaveTypeId,
    );

    try {
      await this.balanceRepo.save({
        ...balance,
        reservedDays: balance.reservedDays + days,
      });
    } catch (err) {
      if ((err as Error).name === 'OptimisticLockVersionMismatchError') {
        throw new OptimisticLockError('TimeOffBalance');
      }
      throw err;
    }
  }

  /**
   * Release a reservation — called when:
   * - HCM confirms: release reserved and deduct from available (net effect: -days)
   * - HCM fails: release reserved only (full rollback, available unchanged)
   * - Request cancelled: release reserved only
   */
  async commitDeduction(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
    days: number,
  ): Promise<void> {
    const balance = await this.findBalance(employeeId, locationId, leaveTypeId);

    try {
      await this.balanceRepo.save({
        ...balance,
        availableDays: balance.availableDays - days,
        reservedDays: Math.max(0, balance.reservedDays - days),
      });
    } catch (err) {
      if ((err as Error).name === 'OptimisticLockVersionMismatchError') {
        throw new OptimisticLockError('TimeOffBalance');
      }
      throw err;
    }
  }

  async releaseReservation(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
    days: number,
  ): Promise<void> {
    const balance = await this.findBalance(
      employeeId,
      locationId,
      leaveTypeId,
    ).catch(() => null);

    if (!balance) {
      // Balance row doesn't exist yet — nothing to release
      return;
    }

    try {
      await this.balanceRepo.save({
        ...balance,
        reservedDays: Math.max(0, balance.reservedDays - days),
      });
    } catch (err) {
      if ((err as Error).name === 'OptimisticLockVersionMismatchError') {
        throw new OptimisticLockError('TimeOffBalance');
      }
      throw err;
    }
  }

  // ─── Sync ─────────────────────────────────────────────────────────────────

  /**
   * Syncs a single balance dimension from HCM.
   * Called by background refresh and manual trigger.
   * Updates `availableDays` ONLY — never touches `reservedDays`
   * (so in-flight reservations survive a concurrent sync).
   */
  async refreshFromHcm(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
    triggeredBy: string,
  ): Promise<void> {
    const balance = await this.findOrCreateBalance(
      employeeId,
      locationId,
      leaveTypeId,
    );
    const previousBalance = balance.availableDays;
    let success = false;
    let errorMessage: string | undefined;

    try {
      const hcmData = await this.hcmClient.getBalance(
        employeeId,
        locationId,
        leaveTypeId,
      );

      await this.balanceRepo.save({
        ...balance,
        availableDays: hcmData.availableDays,
        lastSyncedAt: new Date(),
      });

      success = true;
    } catch (err) {
      errorMessage = (err as Error).message;
      this.logger.error(
        `HCM balance sync failed for ${employeeId}/${leaveTypeId}: ${errorMessage}`,
      );
      throw err;
    } finally {
      await this.syncLogRepo.save({
        syncType: SyncTypeEnum.REALTIME,
        employeeId,
        locationId,
        leaveTypeId,
        previousBalance,
        newBalance: balance.availableDays,
        triggeredBy,
        success,
        errorMessage: errorMessage ?? null,
      });
    }
  }

  /**
   * Full company batch sync — replaces all local balances with HCM data.
   * Called by SyncSchedulerService every 8 hours.
   * Does NOT touch reservedDays on any row.
   */
  async runBatchSync(
    triggeredBy: string,
  ): Promise<{ updated: number; failed: number }> {
    this.logger.log(`Starting batch sync triggered by: ${triggeredBy}`);
    let updated = 0;
    let failed = 0;

    let batchData: HcmBatchResponse;
    try {
      batchData = await this.hcmClient.getBatchBalances();
    } catch (err) {
      this.logger.error(
        `Batch sync: failed to fetch from HCM: ${(err as Error).message}`,
      );
      throw err;
    }

    for (const item of batchData.balances) {
      const existing = await this.findOrCreateBalance(
        item.employeeId,
        item.locationId,
        item.leaveTypeId,
      );
      const previousBalance = existing.availableDays;

      try {
        await this.balanceRepo.save({
          ...existing,
          availableDays: item.availableDays,
          lastSyncedAt: new Date(),
        });

        await this.syncLogRepo.save({
          syncType: SyncTypeEnum.BATCH,
          employeeId: item.employeeId,
          locationId: item.locationId,
          leaveTypeId: item.leaveTypeId,
          previousBalance,
          newBalance: item.availableDays,
          triggeredBy,
          success: true,
          errorMessage: null,
        });

        updated++;
      } catch (err) {
        failed++;
        const errorMessage = (err as Error).message;
        this.logger.error(
          `Batch sync failed for ${item.employeeId}/${item.leaveTypeId}: ${errorMessage}`,
        );

        await this.syncLogRepo.save({
          syncType: SyncTypeEnum.BATCH,
          employeeId: item.employeeId,
          locationId: item.locationId,
          leaveTypeId: item.leaveTypeId,
          previousBalance,
          newBalance: existing.availableDays,
          triggeredBy,
          success: false,
          errorMessage,
        });
      }
    }

    this.logger.log(
      `Batch sync complete: ${updated} updated, ${failed} failed`,
    );
    return { updated, failed };
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  private async findBalance(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
  ): Promise<TimeOffBalanceEntity> {
    const balance = await this.balanceRepo.findOne({
      where: { employeeId, locationId, leaveTypeId },
    });

    if (!balance) {
      throw new NotFoundError(
        BALANCE_ERRORS.BALANCE_NOT_FOUND_FOR_DIMENSIONS(
          employeeId,
          locationId,
          leaveTypeId,
        ),
      );
    }

    return balance;
  }

  /**
   * Finds or creates a balance row.
   * On first sync for a new employee/leave-type, we start at 0 and let the
   * sync overwrite with the real value. This avoids a chicken-and-egg problem.
   */
  private async findOrCreateBalance(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
  ): Promise<TimeOffBalanceEntity> {
    const existing = await this.balanceRepo.findOne({
      where: { employeeId, locationId, leaveTypeId },
    });

    if (existing) {
      return existing;
    }

    const newBalance = this.balanceRepo.create({
      employeeId,
      locationId,
      leaveTypeId,
      availableDays: 0,
      reservedDays: 0,
      lastSyncedAt: null,
    });

    return this.balanceRepo.save(newBalance);
  }

  private isCacheStale(balance: TimeOffBalanceEntity): boolean {
    if (!balance.lastSyncedAt) {
      return true;
    }

    const ageMs = Date.now() - balance.lastSyncedAt.getTime();
    return ageMs > this.cacheTtlMs;
  }
}
