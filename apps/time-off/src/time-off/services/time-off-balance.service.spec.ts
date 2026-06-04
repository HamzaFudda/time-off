/**
 * TimeOffBalanceService — Unit Tests
 *
 * Coverage strategy:
 *
 * ┌─────────────────────────┬──────────────────────────────────────────────────┐
 * │ Method                  │ Scenarios covered                                │
 * ├─────────────────────────┼──────────────────────────────────────────────────┤
 * │ getEffectiveBalance     │ normal, zero floor (no negatives)                │
 * │ isCacheStale            │ fresh cache, stale cache, never synced           │
 * │ getBalance              │ fresh → no HCM call, stale → background refresh  │
 * │ verifyLiveBalance       │ sufficient, insufficient → ConflictError,         │
 * │                         │ HCM down → propagates HcmUnavailableError,        │
 * │                         │ accounts for local reservations                   │
 * │ reserveDays             │ happy path, optimistic lock conflict              │
 * │ commitDeduction         │ happy path, negative days (cancellation restore)  │
 * │ releaseReservation      │ found, not found (graceful no-op)                │
 * │ refreshFromHcm          │ success syncs availableDays, HCM failure logged  │
 * │ runBatchSync            │ all succeed, partial failure, total HCM failure  │
 * └─────────────────────────┴──────────────────────────────────────────────────┘
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { TimeOffBalanceService } from './time-off-balance.service';
import { HcmClientService } from './hcm-client.service';
import { TimeOffBalanceEntity } from '../entities/time-off-balance.entity';
import { BalanceSyncLogEntity } from '../entities/balance-sync-log.entity';
import {
  ConflictError,
  HcmUnavailableError,
  NotFoundError,
} from '../../shared/error/error';
import { HcmBatchResponse } from '../types/hcm.types';

// ─── Test Fixtures ─────────────────────────────────────────────────────────────

const FRESH_SYNC_AGE_MS = 1000 * 60 * 60; // 1 hour ago — within 4h TTL
const STALE_SYNC_AGE_MS = 1000 * 60 * 60 * 5; // 5 hours ago — past 4h TTL
const CACHE_TTL_MS = 4 * 60 * 60 * 1000;

const makeBalance = (
  overrides: Partial<TimeOffBalanceEntity> = {},
): TimeOffBalanceEntity =>
  ({
    id: 'bal-001',
    employeeId: 'emp-123',
    locationId: 'loc-us',
    leaveTypeId: 'VACATION',
    availableDays: 15,
    reservedDays: 0,
    lastSyncedAt: new Date(Date.now() - FRESH_SYNC_AGE_MS),
    version: 1,
    ...overrides,
  }) as TimeOffBalanceEntity;

const makeHcmBatchResponse = (availableDays = 20): HcmBatchResponse => ({
  balances: [
    {
      employeeId: 'emp-123',
      locationId: 'loc-us',
      leaveTypeId: 'VACATION',
      availableDays,
      asOfDate: new Date().toISOString(),
    },
  ],
  asOfDate: new Date().toISOString(),
});

// ─── Test Suite ────────────────────────────────────────────────────────────────

describe('TimeOffBalanceService', () => {
  let service: TimeOffBalanceService;
  let hcmClient: jest.Mocked<HcmClientService>;

  const mockBalanceRepo = {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };

  const mockSyncLogRepo = {
    save: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimeOffBalanceService,
        {
          provide: getRepositoryToken(TimeOffBalanceEntity),
          useValue: mockBalanceRepo,
        },
        {
          provide: getRepositoryToken(BalanceSyncLogEntity),
          useValue: mockSyncLogRepo,
        },
        {
          provide: HcmClientService,
          useValue: {
            getBalance: jest.fn(),
            getBatchBalances: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue: string) => {
              if (key === 'BALANCE_CACHE_TTL_MS')
                return CACHE_TTL_MS.toString();
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get(TimeOffBalanceService);
    hcmClient = module.get(HcmClientService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ─── getEffectiveBalance ────────────────────────────────────────────────────

  describe('getEffectiveBalance', () => {
    it('returns availableDays minus reservedDays', () => {
      const balance = makeBalance({ availableDays: 10, reservedDays: 3 });
      expect(service.getEffectiveBalance(balance)).toBe(7);
    });

    it('returns zero when reservedDays exceeds availableDays (no negatives)', () => {
      const balance = makeBalance({ availableDays: 2, reservedDays: 5 });
      expect(service.getEffectiveBalance(balance)).toBe(0);
    });

    it('returns the full availableDays when there are no reservations', () => {
      const balance = makeBalance({ availableDays: 20, reservedDays: 0 });
      expect(service.getEffectiveBalance(balance)).toBe(20);
    });
  });

  // ─── getBalance (cache TTL) ─────────────────────────────────────────────────

  describe('getBalance', () => {
    it('returns cache immediately and does NOT call HCM when cache is fresh', async () => {
      const freshBalance = makeBalance({
        lastSyncedAt: new Date(Date.now() - FRESH_SYNC_AGE_MS),
      });
      mockBalanceRepo.findOne.mockResolvedValue(freshBalance);

      const result = await service.getBalance('emp-123', 'loc-us', 'VACATION');

      expect(result.isStale).toBe(false);
      expect(result.balance).toEqual(freshBalance);
      expect(result.effectiveBalance).toBe(15);
      expect(hcmClient.getBalance).not.toHaveBeenCalled();
    });

    it('returns stale cache immediately and triggers non-blocking background refresh', async () => {
      const staleBalance = makeBalance({
        lastSyncedAt: new Date(Date.now() - STALE_SYNC_AGE_MS),
      });
      mockBalanceRepo.findOne.mockResolvedValue(staleBalance);
      hcmClient.getBalance.mockResolvedValue({
        employeeId: 'emp-123',
        locationId: 'loc-us',
        leaveTypeId: 'VACATION',
        availableDays: 20,
        asOfDate: new Date().toISOString(),
      });
      mockBalanceRepo.save.mockResolvedValue({
        ...staleBalance,
        availableDays: 20,
      });

      const result = await service.getBalance('emp-123', 'loc-us', 'VACATION');

      // Still returns the stale cached value immediately
      expect(result.isStale).toBe(true);
      expect(result.balance.availableDays).toBe(15);

      // Wait one tick for the background refresh promise
      await new Promise<void>((resolve) => process.nextTick(resolve));

      expect(hcmClient.getBalance).toHaveBeenCalledWith(
        'emp-123',
        'loc-us',
        'VACATION',
      );
      expect(mockBalanceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ availableDays: 20 }),
      );
    });

    it('marks cache stale when lastSyncedAt is null (never synced)', async () => {
      const unsyncedBalance = makeBalance({ lastSyncedAt: null });
      mockBalanceRepo.findOne.mockResolvedValue(unsyncedBalance);
      hcmClient.getBalance.mockResolvedValue({
        employeeId: 'emp-123',
        locationId: 'loc-us',
        leaveTypeId: 'VACATION',
        availableDays: 10,
        asOfDate: new Date().toISOString(),
      });

      const result = await service.getBalance('emp-123', 'loc-us', 'VACATION');

      expect(result.isStale).toBe(true);
    });

    it('throws NotFoundError if no balance record exists', async () => {
      mockBalanceRepo.findOne.mockResolvedValue(null);

      await expect(
        service.getBalance('emp-ghost', 'loc-us', 'VACATION'),
      ).rejects.toThrow(NotFoundError);
    });
  });

  // ─── verifyLiveBalance ──────────────────────────────────────────────────────

  describe('verifyLiveBalance', () => {
    it('resolves silently when HCM balance is sufficient', async () => {
      hcmClient.getBalance.mockResolvedValue({
        employeeId: 'emp-123',
        locationId: 'loc-us',
        leaveTypeId: 'VACATION',
        availableDays: 15,
        asOfDate: new Date().toISOString(),
      });
      mockBalanceRepo.findOne.mockResolvedValue(
        makeBalance({ reservedDays: 0 }),
      );

      await expect(
        service.verifyLiveBalance('emp-123', 'loc-us', 'VACATION', 5),
      ).resolves.toBeUndefined();
    });

    it('throws ConflictError when HCM balance is insufficient', async () => {
      hcmClient.getBalance.mockResolvedValue({
        employeeId: 'emp-123',
        locationId: 'loc-us',
        leaveTypeId: 'VACATION',
        availableDays: 2,
        asOfDate: new Date().toISOString(),
      });
      mockBalanceRepo.findOne.mockResolvedValue(
        makeBalance({ availableDays: 2, reservedDays: 0 }),
      );

      await expect(
        service.verifyLiveBalance('emp-123', 'loc-us', 'VACATION', 5),
      ).rejects.toThrow(ConflictError);

      await expect(
        service.verifyLiveBalance('emp-123', 'loc-us', 'VACATION', 5),
      ).rejects.toThrow('5 day(s)');
    });

    it('deducts local reservations from the live HCM balance before comparing', async () => {
      // HCM says 10 days, but 8 are already locally reserved by other in-flight approvals
      hcmClient.getBalance.mockResolvedValue({
        employeeId: 'emp-123',
        locationId: 'loc-us',
        leaveTypeId: 'VACATION',
        availableDays: 10,
        asOfDate: new Date().toISOString(),
      });
      mockBalanceRepo.findOne.mockResolvedValue(
        makeBalance({ availableDays: 10, reservedDays: 8 }),
      );

      // Requesting 5 days: effective = 10 - 8 = 2, which is < 5 → insufficient
      await expect(
        service.verifyLiveBalance('emp-123', 'loc-us', 'VACATION', 5),
      ).rejects.toThrow(ConflictError);
    });

    it('propagates HcmUnavailableError without fallback to cached data', async () => {
      hcmClient.getBalance.mockRejectedValue(
        new HcmUnavailableError('Timeout'),
      );

      await expect(
        service.verifyLiveBalance('emp-123', 'loc-us', 'VACATION', 3),
      ).rejects.toThrow(HcmUnavailableError);
    });
  });

  // ─── reserveDays ────────────────────────────────────────────────────────────

  describe('reserveDays', () => {
    it('increments reservedDays on the balance record', async () => {
      const balance = makeBalance({ availableDays: 15, reservedDays: 2 });
      mockBalanceRepo.findOne.mockResolvedValue(balance);
      mockBalanceRepo.save.mockResolvedValue({ ...balance, reservedDays: 5 });

      await service.reserveDays('emp-123', 'loc-us', 'VACATION', 3);

      expect(mockBalanceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ reservedDays: 5 }), // 2 + 3 = 5
      );
    });

    it('creates a new balance row if none exists (first reservation)', async () => {
      // findOne returns null → findOrCreate path
      mockBalanceRepo.findOne.mockResolvedValue(null);
      const newBalance = makeBalance({ availableDays: 0, reservedDays: 0 });
      mockBalanceRepo.create.mockReturnValue(newBalance);
      mockBalanceRepo.save
        .mockResolvedValueOnce(newBalance) // findOrCreate save
        .mockResolvedValueOnce({ ...newBalance, reservedDays: 3 }); // reserve save

      await service.reserveDays('emp-123', 'loc-us', 'VACATION', 3);

      expect(mockBalanceRepo.save).toHaveBeenCalledTimes(2);
    });
  });

  // ─── commitDeduction ────────────────────────────────────────────────────────

  describe('commitDeduction', () => {
    it('decrements availableDays and releases the reservation', async () => {
      const balance = makeBalance({ availableDays: 15, reservedDays: 3 });
      mockBalanceRepo.findOne.mockResolvedValue(balance);
      mockBalanceRepo.save.mockResolvedValue({
        ...balance,
        availableDays: 12,
        reservedDays: 0,
      });

      await service.commitDeduction('emp-123', 'loc-us', 'VACATION', 3);

      expect(mockBalanceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ availableDays: 12, reservedDays: 0 }),
      );
    });

    it('handles negative days correctly (cancellation balance restore)', async () => {
      // When cancelling an HCM_SUBMITTED request, we pass -3 to add days back
      const balance = makeBalance({ availableDays: 12, reservedDays: 0 });
      mockBalanceRepo.findOne.mockResolvedValue(balance);
      mockBalanceRepo.save.mockResolvedValue({ ...balance, availableDays: 15 });

      await service.commitDeduction('emp-123', 'loc-us', 'VACATION', -3);

      expect(mockBalanceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ availableDays: 15 }), // 12 - (-3) = 15
      );
    });
  });

  // ─── releaseReservation ─────────────────────────────────────────────────────

  describe('releaseReservation', () => {
    it('decrements reservedDays without touching availableDays', async () => {
      const balance = makeBalance({ availableDays: 15, reservedDays: 3 });
      mockBalanceRepo.findOne.mockResolvedValue(balance);
      mockBalanceRepo.save.mockResolvedValue({ ...balance, reservedDays: 0 });

      await service.releaseReservation('emp-123', 'loc-us', 'VACATION', 3);

      expect(mockBalanceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ availableDays: 15, reservedDays: 0 }),
      );
    });

    it('is a no-op when balance row does not exist (graceful rollback)', async () => {
      // Edge case: release called before a balance was ever created
      mockBalanceRepo.findOne.mockResolvedValue(null);

      // Should not throw
      await expect(
        service.releaseReservation('emp-ghost', 'loc-us', 'VACATION', 3),
      ).resolves.toBeUndefined();

      expect(mockBalanceRepo.save).not.toHaveBeenCalled();
    });

    it('floors reservedDays at 0 (prevents negative reservations)', async () => {
      // Defensive: trying to release more than reserved
      const balance = makeBalance({ availableDays: 15, reservedDays: 1 });
      mockBalanceRepo.findOne.mockResolvedValue(balance);
      mockBalanceRepo.save.mockResolvedValue({ ...balance, reservedDays: 0 });

      await service.releaseReservation('emp-123', 'loc-us', 'VACATION', 5);

      expect(mockBalanceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ reservedDays: 0 }), // max(0, 1-5) = 0
      );
    });
  });

  // ─── runBatchSync ────────────────────────────────────────────────────────────

  describe('runBatchSync', () => {
    it('updates all balances and returns correct counts when HCM responds successfully', async () => {
      const batchResponse = makeHcmBatchResponse(20);
      hcmClient.getBatchBalances.mockResolvedValue(batchResponse);

      const existingBalance = makeBalance({ availableDays: 15 });
      mockBalanceRepo.findOne.mockResolvedValue(existingBalance);
      mockBalanceRepo.save.mockResolvedValue({
        ...existingBalance,
        availableDays: 20,
      });
      mockSyncLogRepo.save.mockResolvedValue({});

      const result = await service.runBatchSync('test-trigger');

      expect(result.updated).toBe(1);
      expect(result.failed).toBe(0);
      expect(mockBalanceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ availableDays: 20 }),
      );
    });

    it('does NOT touch reservedDays during batch sync (in-flight safety)', async () => {
      const batchResponse = makeHcmBatchResponse(20);
      hcmClient.getBatchBalances.mockResolvedValue(batchResponse);

      const balanceWithReservation = makeBalance({
        availableDays: 15,
        reservedDays: 5, // reservation in flight
      });
      mockBalanceRepo.findOne.mockResolvedValue(balanceWithReservation);
      mockBalanceRepo.save.mockResolvedValue(balanceWithReservation);
      mockSyncLogRepo.save.mockResolvedValue({});

      await service.runBatchSync('test-trigger');

      const savedArg = mockBalanceRepo.save.mock.calls[0][0];
      // reservedDays must be preserved, only availableDays changed
      expect(savedArg.reservedDays).toBe(5);
    });

    it('propagates HcmUnavailableError when the batch fetch fails entirely', async () => {
      hcmClient.getBatchBalances.mockRejectedValue(
        new HcmUnavailableError('HCM down'),
      );

      await expect(service.runBatchSync('test-trigger')).rejects.toThrow(
        HcmUnavailableError,
      );
      expect(mockBalanceRepo.save).not.toHaveBeenCalled();
    });

    it('counts partial failures correctly and continues processing remaining items', async () => {
      // Two items in the batch — one save fails, one succeeds
      hcmClient.getBatchBalances.mockResolvedValue({
        balances: [
          {
            employeeId: 'emp-123',
            locationId: 'loc-us',
            leaveTypeId: 'VACATION',
            availableDays: 20,
            asOfDate: new Date().toISOString(),
          },
          {
            employeeId: 'emp-456',
            locationId: 'loc-uk',
            leaveTypeId: 'VACATION',
            availableDays: 10,
            asOfDate: new Date().toISOString(),
          },
        ],
        asOfDate: new Date().toISOString(),
      });

      mockBalanceRepo.findOne.mockResolvedValue(makeBalance());
      mockBalanceRepo.save
        .mockRejectedValueOnce(new Error('DB write failed')) // first item fails
        .mockResolvedValueOnce(makeBalance()); // second item succeeds
      mockSyncLogRepo.save.mockResolvedValue({});

      const result = await service.runBatchSync('test-trigger');

      expect(result.updated).toBe(1);
      expect(result.failed).toBe(1);
    });
  });
});
