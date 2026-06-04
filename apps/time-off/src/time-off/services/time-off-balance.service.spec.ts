import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { TimeOffBalanceService } from './time-off-balance.service';
import { HcmClientService } from './hcm-client.service';
import { TimeOffBalanceEntity } from '../entities/time-off-balance.entity';
import { BalanceSyncLogEntity } from '../entities/balance-sync-log.entity';

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
    const mockHcmClientService = {
      getBalance: jest.fn(),
      getBatchBalances: jest.fn(),
    };

    const mockConfigService = {
      get: jest.fn((key: string, defaultValue: any) => {
        if (key === 'BALANCE_CACHE_TTL_MS') return 4 * 60 * 60 * 1000; // 4 hours
        return defaultValue;
      }),
    };

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
        { provide: HcmClientService, useValue: mockHcmClientService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<TimeOffBalanceService>(TimeOffBalanceService);
    hcmClient = module.get(HcmClientService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('effectiveBalance', () => {
    it('should calculate effective balance as availableDays - reservedDays', () => {
      const balance = {
        availableDays: 10,
        reservedDays: 3,
      } as TimeOffBalanceEntity;
      expect(service.getEffectiveBalance(balance)).toBe(7);
    });

    it('should not return negative effective balance', () => {
      const balance = {
        availableDays: 5,
        reservedDays: 10,
      } as TimeOffBalanceEntity;
      expect(service.getEffectiveBalance(balance)).toBe(0);
    });
  });

  describe('cache TTL logic (getBalance)', () => {
    it('should return cache immediately and not trigger background fetch if fresh', async () => {
      const freshDate = new Date(Date.now() - 1000 * 60 * 60); // 1 hour ago
      const balance = {
        employeeId: 'emp1',
        availableDays: 10,
        reservedDays: 0,
        lastSyncedAt: freshDate,
      } as TimeOffBalanceEntity;

      mockBalanceRepo.findOne.mockResolvedValue(balance);

      const result = await service.getBalance('emp1', 'loc1', 'VACATION');

      expect(result.isStale).toBe(false);
      expect(result.balance).toEqual(balance);

      // HCM should NOT be called
      expect(hcmClient.getBalance).not.toHaveBeenCalled();
    });

    it('should return stale cache immediately and trigger background fetch', async () => {
      const staleDate = new Date(Date.now() - 1000 * 60 * 60 * 5); // 5 hours ago
      const balance = {
        employeeId: 'emp1',
        availableDays: 10,
        reservedDays: 0,
        lastSyncedAt: staleDate,
      } as TimeOffBalanceEntity;

      mockBalanceRepo.findOne.mockResolvedValue(balance);
      hcmClient.getBalance.mockResolvedValue({
        employeeId: 'emp1',
        locationId: 'loc1',
        leaveTypeId: 'VACATION',
        availableDays: 15,
        asOfDate: new Date().toISOString(),
      });

      const result = await service.getBalance('emp1', 'loc1', 'VACATION');

      expect(result.isStale).toBe(true);
      expect(result.balance.availableDays).toBe(10); // Returns immediate cache

      // Background fetch should be called
      // We must wait a tick for the fire-and-forget promise to execute in the test environment
      await new Promise<void>((resolve) => process.nextTick(resolve));

      expect(hcmClient.getBalance).toHaveBeenCalledWith(
        'emp1',
        'loc1',
        'VACATION',
      );
      expect(mockBalanceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ availableDays: 15 }),
      );
    });
  });
});
