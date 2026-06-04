import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TimeOffRequestService } from './time-off-request.service';
import { TimeOffBalanceService } from './time-off-balance.service';
import { HcmClientService } from './hcm-client.service';
import { TimeOffRequestEntity } from '../entities/time-off-request.entity';
import { RequestStatusEnum } from '../enums/request-status.enum';
import { HcmUnavailableError } from '../../shared/error/error';

describe('TimeOffRequestService', () => {
  let service: TimeOffRequestService;
  let balanceService: jest.Mocked<TimeOffBalanceService>;
  let hcmClient: jest.Mocked<HcmClientService>;

  const mockRequestRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
  };

  beforeEach(async () => {
    const mockBalanceService = {
      verifyLiveBalance: jest.fn(),
      reserveDays: jest.fn(),
      commitDeduction: jest.fn(),
      releaseReservation: jest.fn(),
      getBalance: jest.fn(),
    };

    const mockHcmClientService = {
      submitDeduction: jest.fn(),
      reverseDeduction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimeOffRequestService,
        {
          provide: getRepositoryToken(TimeOffRequestEntity),
          useValue: mockRequestRepo,
        },
        { provide: TimeOffBalanceService, useValue: mockBalanceService },
        { provide: HcmClientService, useValue: mockHcmClientService },
      ],
    }).compile();

    service = module.get<TimeOffRequestService>(TimeOffRequestService);
    balanceService = module.get(TimeOffBalanceService);
    hcmClient = module.get(HcmClientService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('approveRequest saga', () => {
    const pendingRequest = {
      id: 'req-1',
      employeeId: 'emp-1',
      locationId: 'loc-1',
      leaveTypeId: 'VACATION',
      numberOfDays: 2,
      status: RequestStatusEnum.PENDING_APPROVAL,
      hcmTransactionId: 'tx-1',
    } as TimeOffRequestEntity;

    beforeEach(() => {
      mockRequestRepo.findOne.mockResolvedValue(pendingRequest);
      mockRequestRepo.save.mockImplementation((req) => Promise.resolve(req));
      balanceService.getBalance.mockResolvedValue({
        balance: { availableDays: 10, reservedDays: 0 } as any,
        effectiveBalance: 10,
        isStale: false,
      });
    });

    it('should complete full saga: preflight -> reserve -> hcm -> commit', async () => {
      hcmClient.submitDeduction.mockResolvedValue({
        transactionId: 'tx-1',
        success: true,
        remainingBalance: 8,
      });

      const result = await service.approveRequest('req-1', {
        managerId: 'mgr-1',
      });

      expect(balanceService.verifyLiveBalance).toHaveBeenCalledWith(
        'emp-1',
        'loc-1',
        'VACATION',
        2,
      );
      expect(balanceService.reserveDays).toHaveBeenCalledWith(
        'emp-1',
        'loc-1',
        'VACATION',
        2,
      );
      expect(hcmClient.submitDeduction).toHaveBeenCalledWith({
        transactionId: 'tx-1',
        employeeId: 'emp-1',
        locationId: 'loc-1',
        leaveTypeId: 'VACATION',
        days: 2,
      });
      expect(balanceService.commitDeduction).toHaveBeenCalledWith(
        'emp-1',
        'loc-1',
        'VACATION',
        2,
      );
      expect(result.status).toBe(RequestStatusEnum.HCM_SUBMITTED);
    });

    it('should abort if pre-flight fails (HcmUnavailableError)', async () => {
      balanceService.verifyLiveBalance.mockRejectedValue(
        new HcmUnavailableError('Down'),
      );

      await expect(
        service.approveRequest('req-1', { managerId: 'mgr-1' }),
      ).rejects.toThrow(HcmUnavailableError);

      // Verify saga was stopped before state mutation
      expect(balanceService.reserveDays).not.toHaveBeenCalled();
      expect(hcmClient.submitDeduction).not.toHaveBeenCalled();
    });

    it('should rollback reservation if HCM submission fails with network error', async () => {
      hcmClient.submitDeduction.mockRejectedValue(
        new HcmUnavailableError('Timeout'),
      );

      const result = await service.approveRequest('req-1', {
        managerId: 'mgr-1',
      });

      expect(result.status).toBe(RequestStatusEnum.HCM_FAILED);
      expect(balanceService.releaseReservation).toHaveBeenCalledWith(
        'emp-1',
        'loc-1',
        'VACATION',
        2,
      );
      expect(balanceService.commitDeduction).not.toHaveBeenCalled();
    });

    it('should rollback reservation if HCM returns success: false (business violation)', async () => {
      hcmClient.submitDeduction.mockResolvedValue({
        transactionId: 'tx-1',
        success: false,
        remainingBalance: 10,
        errorMessage: 'Invalid rules',
      });

      const result = await service.approveRequest('req-1', {
        managerId: 'mgr-1',
      });

      expect(result.status).toBe(RequestStatusEnum.HCM_FAILED);
      expect(result.hcmErrorMessage).toBe('Invalid rules');
      expect(balanceService.releaseReservation).toHaveBeenCalledWith(
        'emp-1',
        'loc-1',
        'VACATION',
        2,
      );
    });
  });
});
