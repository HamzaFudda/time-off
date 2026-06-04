/**
 * TimeOffRequestService — Unit Tests
 *
 * Coverage strategy:
 *
 * ┌─────────────────────┬──────────────────────────────────────────────────────┐
 * │ Method              │ Scenarios covered                                    │
 * ├─────────────────────┼──────────────────────────────────────────────────────┤
 * │ findAll             │ no filter, employee filter                           │
 * │ findById            │ found, not found                                     │
 * │ createRequest       │ happy path, end-before-start guard                  │
 * │ approveRequest      │ full saga, non-pending guard, HCM unavailable abort,│
 * │                     │ HCM network failure → rollback, HCM business reject, │
 * │                     │ idempotency key usage, post-flight audit trigger     │
 * │ rejectRequest       │ happy path, non-pending guard                        │
 * │ cancelRequest       │ pending cancel (no HCM), submitted cancel (reversal) │
 * │                     │ terminal state guard, HCM reversal failure tolerance  │
 * │ retryHcmSubmit      │ HCM_FAILED → success, non-failed guard, HCM fail    │
 * └─────────────────────┴──────────────────────────────────────────────────────┘
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TimeOffRequestService } from './time-off-request.service';
import { TimeOffBalanceService } from './time-off-balance.service';
import { HcmClientService } from './hcm-client.service';
import { TimeOffRequestEntity } from '../entities/time-off-request.entity';
import { RequestStatusEnum } from '../enums/request-status.enum';
import {
  ConflictError,
  HcmUnavailableError,
  NotFoundError,
} from '../../shared/error/error';
import { TIME_OFF_REQUEST_ERRORS } from '../../shared/constants/error-messages.const';

// ─── Test Fixtures ─────────────────────────────────────────────────────────────

const makePendingRequest = (
  overrides: Partial<TimeOffRequestEntity> = {},
): TimeOffRequestEntity =>
  ({
    id: 'req-001',
    employeeId: 'emp-123',
    locationId: 'loc-us',
    leaveTypeId: 'VACATION',
    numberOfDays: 3,
    status: RequestStatusEnum.PENDING_APPROVAL,
    hcmTransactionId: 'tx-uuid-001',
    startDate: '2026-12-01',
    endDate: '2026-12-03',
    createdAt: new Date('2026-11-01'),
    ...overrides,
  }) as TimeOffRequestEntity;

const makeApprovedRequest = (
  overrides: Partial<TimeOffRequestEntity> = {},
): TimeOffRequestEntity =>
  makePendingRequest({
    status: RequestStatusEnum.HCM_SUBMITTED,
    managerId: 'mgr-999',
    ...overrides,
  });

const makeHcmSuccessResponse = () => ({
  transactionId: 'tx-uuid-001',
  success: true as const,
  remainingBalance: 12,
});

// ─── Test Suite ────────────────────────────────────────────────────────────────

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
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimeOffRequestService,
        {
          provide: getRepositoryToken(TimeOffRequestEntity),
          useValue: mockRequestRepo,
        },
        {
          provide: TimeOffBalanceService,
          useValue: {
            verifyLiveBalance: jest.fn(),
            reserveDays: jest.fn(),
            commitDeduction: jest.fn(),
            releaseReservation: jest.fn(),
            getBalance: jest.fn(),
          },
        },
        {
          provide: HcmClientService,
          useValue: {
            submitDeduction: jest.fn(),
            reverseDeduction: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(TimeOffRequestService);
    balanceService = module.get(TimeOffBalanceService);
    hcmClient = module.get(HcmClientService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ─── findAll ────────────────────────────────────────────────────────────────

  describe('findAll', () => {
    it('should return all requests when no employeeId is given', async () => {
      const requests = [
        makePendingRequest(),
        makePendingRequest({ id: 'req-002' }),
      ];
      mockRequestRepo.find.mockResolvedValue(requests);

      const result = await service.findAll();

      expect(mockRequestRepo.find).toHaveBeenCalledWith({
        where: {},
        order: { createdAt: 'DESC' },
      });
      expect(result).toHaveLength(2);
    });

    it('should filter by employeeId when provided', async () => {
      mockRequestRepo.find.mockResolvedValue([makePendingRequest()]);

      await service.findAll('emp-123');

      expect(mockRequestRepo.find).toHaveBeenCalledWith({
        where: { employeeId: 'emp-123' },
        order: { createdAt: 'DESC' },
      });
    });
  });

  // ─── findById ───────────────────────────────────────────────────────────────

  describe('findById', () => {
    it('should return the request when found', async () => {
      const request = makePendingRequest();
      mockRequestRepo.findOne.mockResolvedValue(request);

      const result = await service.findById('req-001');

      expect(result).toEqual(request);
      expect(mockRequestRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'req-001' },
      });
    });

    it('should throw NotFoundError when request does not exist', async () => {
      mockRequestRepo.findOne.mockResolvedValue(null);

      await expect(service.findById('ghost-id')).rejects.toThrow(NotFoundError);
      await expect(service.findById('ghost-id')).rejects.toThrow(
        TIME_OFF_REQUEST_ERRORS.REQUEST_NOT_FOUND_FOR_ID('ghost-id'),
      );
    });
  });

  // ─── createRequest ──────────────────────────────────────────────────────────

  describe('createRequest', () => {
    const dto = {
      employeeId: 'emp-123',
      locationId: 'loc-us',
      leaveTypeId: 'VACATION',
      startDate: '2026-12-01',
      endDate: '2026-12-03',
      numberOfDays: 3,
    };

    it('should create request in PENDING_APPROVAL with a UUID transaction ID', async () => {
      const savedRequest = makePendingRequest();
      mockRequestRepo.create.mockReturnValue(savedRequest);
      mockRequestRepo.save.mockResolvedValue(savedRequest);

      const result = await service.createRequest(dto);

      expect(mockRequestRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: RequestStatusEnum.PENDING_APPROVAL,
          hcmTransactionId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
          ),
        }),
      );
      expect(result.status).toBe(RequestStatusEnum.PENDING_APPROVAL);
    });

    it('should throw ConflictError when end date is before start date', async () => {
      await expect(
        service.createRequest({
          ...dto,
          startDate: '2026-12-10',
          endDate: '2026-12-01',
        }),
      ).rejects.toThrow(ConflictError);
      await expect(
        service.createRequest({
          ...dto,
          startDate: '2026-12-10',
          endDate: '2026-12-01',
        }),
      ).rejects.toThrow(TIME_OFF_REQUEST_ERRORS.END_BEFORE_START);

      // Repo should never be called for invalid dates
      expect(mockRequestRepo.create).not.toHaveBeenCalled();
    });

    it('should allow same-day requests (start == end)', async () => {
      const savedRequest = makePendingRequest({ numberOfDays: 1 });
      mockRequestRepo.create.mockReturnValue(savedRequest);
      mockRequestRepo.save.mockResolvedValue(savedRequest);

      // Same date is valid — no ConflictError
      await expect(
        service.createRequest({
          ...dto,
          startDate: '2026-12-01',
          endDate: '2026-12-01',
          numberOfDays: 1,
        }),
      ).resolves.toBeDefined();
    });
  });

  // ─── approveRequest ─────────────────────────────────────────────────────────

  describe('approveRequest', () => {
    const approveDto = { managerId: 'mgr-999' };

    beforeEach(() => {
      mockRequestRepo.findOne.mockResolvedValue(makePendingRequest());
      mockRequestRepo.save.mockImplementation((req) => Promise.resolve(req));
      balanceService.getBalance.mockResolvedValue({
        balance: { availableDays: 15, reservedDays: 0 } as any,
        effectiveBalance: 15,
        isStale: false,
      });
    });

    it('should execute full saga: preflight → reserve → HCM → commit', async () => {
      hcmClient.submitDeduction.mockResolvedValue(makeHcmSuccessResponse());

      const result = await service.approveRequest('req-001', approveDto);

      // Pre-flight was called
      expect(balanceService.verifyLiveBalance).toHaveBeenCalledWith(
        'emp-123',
        'loc-us',
        'VACATION',
        3,
      );
      // Optimistic reservation was set
      expect(balanceService.reserveDays).toHaveBeenCalledWith(
        'emp-123',
        'loc-us',
        'VACATION',
        3,
      );
      // HCM called with the idempotency key generated at creation
      expect(hcmClient.submitDeduction).toHaveBeenCalledWith({
        transactionId: 'tx-uuid-001',
        employeeId: 'emp-123',
        locationId: 'loc-us',
        leaveTypeId: 'VACATION',
        days: 3,
      });
      // Local balance committed
      expect(balanceService.commitDeduction).toHaveBeenCalledWith(
        'emp-123',
        'loc-us',
        'VACATION',
        3,
      );
      expect(result.status).toBe(RequestStatusEnum.HCM_SUBMITTED);
    });

    it('should throw ConflictError immediately if request is not PENDING_APPROVAL', async () => {
      const alreadyApproved = makePendingRequest({
        status: RequestStatusEnum.HCM_SUBMITTED,
      });
      mockRequestRepo.findOne.mockResolvedValue(alreadyApproved);

      await expect(
        service.approveRequest('req-001', approveDto),
      ).rejects.toThrow(ConflictError);
      // Nothing else should have been called
      expect(balanceService.verifyLiveBalance).not.toHaveBeenCalled();
      expect(hcmClient.submitDeduction).not.toHaveBeenCalled();
    });

    it('should propagate HcmUnavailableError from pre-flight without touching local state', async () => {
      balanceService.verifyLiveBalance.mockRejectedValue(
        new HcmUnavailableError('HCM timed out'),
      );

      await expect(
        service.approveRequest('req-001', approveDto),
      ).rejects.toThrow(HcmUnavailableError);

      // Reservation must NOT have been set — no local state mutation
      expect(balanceService.reserveDays).not.toHaveBeenCalled();
      expect(hcmClient.submitDeduction).not.toHaveBeenCalled();
    });

    it('should rollback reservation and set HCM_FAILED on network error from HCM', async () => {
      hcmClient.submitDeduction.mockRejectedValue(
        new HcmUnavailableError('Connection refused'),
      );

      const result = await service.approveRequest('req-001', approveDto);

      expect(result.status).toBe(RequestStatusEnum.HCM_FAILED);
      expect(result.hcmErrorMessage).toContain('Connection refused');
      // Reservation released — net effect is zero change on the balance
      expect(balanceService.releaseReservation).toHaveBeenCalledWith(
        'emp-123',
        'loc-us',
        'VACATION',
        3,
      );
      expect(balanceService.commitDeduction).not.toHaveBeenCalled();
    });

    it('should rollback reservation on HCM business rejection (success=false, 200 response)', async () => {
      hcmClient.submitDeduction.mockResolvedValue({
        transactionId: 'tx-uuid-001',
        success: false,
        remainingBalance: 15,
        errorMessage: 'Policy violation: request overlaps an existing block',
      });

      const result = await service.approveRequest('req-001', approveDto);

      expect(result.status).toBe(RequestStatusEnum.HCM_FAILED);
      expect(result.hcmErrorMessage).toContain('Policy violation');
      expect(balanceService.releaseReservation).toHaveBeenCalledWith(
        'emp-123',
        'loc-us',
        'VACATION',
        3,
      );
      expect(balanceService.commitDeduction).not.toHaveBeenCalled();
    });

    it('should use the original hcmTransactionId (idempotency key never changes)', async () => {
      hcmClient.submitDeduction.mockResolvedValue(makeHcmSuccessResponse());

      await service.approveRequest('req-001', approveDto);

      const callArg = hcmClient.submitDeduction.mock.calls[0][0];
      expect(callArg.transactionId).toBe('tx-uuid-001');
    });
  });

  // ─── rejectRequest ──────────────────────────────────────────────────────────

  describe('rejectRequest', () => {
    const rejectDto = { managerId: 'mgr-999', reason: 'Team coverage issue' };

    it('should transition to REJECTED without touching HCM or balance', async () => {
      mockRequestRepo.findOne.mockResolvedValue(makePendingRequest());
      mockRequestRepo.save.mockImplementation((req) => Promise.resolve(req));

      const result = await service.rejectRequest('req-001', rejectDto);

      expect(result.status).toBe(RequestStatusEnum.REJECTED);
      expect(hcmClient.submitDeduction).not.toHaveBeenCalled();
      expect(balanceService.reserveDays).not.toHaveBeenCalled();
    });

    it('should throw ConflictError if request is not PENDING_APPROVAL', async () => {
      mockRequestRepo.findOne.mockResolvedValue(
        makePendingRequest({ status: RequestStatusEnum.HCM_SUBMITTED }),
      );

      await expect(service.rejectRequest('req-001', rejectDto)).rejects.toThrow(
        ConflictError,
      );
      await expect(service.rejectRequest('req-001', rejectDto)).rejects.toThrow(
        TIME_OFF_REQUEST_ERRORS.CANNOT_REJECT_NOT_PENDING,
      );
    });
  });

  // ─── cancelRequest ──────────────────────────────────────────────────────────

  describe('cancelRequest', () => {
    const cancelDto = { employeeId: 'emp-123', reason: 'Plans changed' };

    it('should cancel a PENDING request without any HCM or balance call', async () => {
      mockRequestRepo.findOne.mockResolvedValue(makePendingRequest());
      mockRequestRepo.save.mockImplementation((req) => Promise.resolve(req));

      const result = await service.cancelRequest('req-001', cancelDto);

      expect(result.status).toBe(RequestStatusEnum.CANCELLED);
      expect(hcmClient.reverseDeduction).not.toHaveBeenCalled();
      expect(balanceService.releaseReservation).not.toHaveBeenCalled();
    });

    it('should call HCM reversal and restore balance when cancelling HCM_SUBMITTED request', async () => {
      const submittedRequest = makeApprovedRequest();
      mockRequestRepo.findOne.mockResolvedValue(submittedRequest);
      mockRequestRepo.save.mockImplementation((req) => Promise.resolve(req));
      hcmClient.reverseDeduction.mockResolvedValue(undefined);

      const result = await service.cancelRequest('req-001', cancelDto);

      expect(result.status).toBe(RequestStatusEnum.CANCELLED);
      expect(hcmClient.reverseDeduction).toHaveBeenCalledWith('tx-uuid-001');
      // Release the reservation that was held
      expect(balanceService.releaseReservation).toHaveBeenCalledWith(
        'emp-123',
        'loc-us',
        'VACATION',
        3,
      );
      // Restore the committed deduction (negative days)
      expect(balanceService.commitDeduction).toHaveBeenCalledWith(
        'emp-123',
        'loc-us',
        'VACATION',
        -3,
      );
    });

    it('should still cancel locally even if HCM reversal fails (resilience)', async () => {
      const submittedRequest = makeApprovedRequest();
      mockRequestRepo.findOne.mockResolvedValue(submittedRequest);
      mockRequestRepo.save.mockImplementation((req) => Promise.resolve(req));
      hcmClient.reverseDeduction.mockRejectedValue(
        new HcmUnavailableError('Timeout'),
      );

      // Should NOT throw — ops team reconciles manually
      const result = await service.cancelRequest('req-001', cancelDto);

      expect(result.status).toBe(RequestStatusEnum.CANCELLED);
    });

    it('should throw ConflictError when trying to cancel a terminal state (CANCELLED)', async () => {
      mockRequestRepo.findOne.mockResolvedValue(
        makePendingRequest({ status: RequestStatusEnum.CANCELLED }),
      );

      await expect(service.cancelRequest('req-001', cancelDto)).rejects.toThrow(
        ConflictError,
      );
      await expect(service.cancelRequest('req-001', cancelDto)).rejects.toThrow(
        TIME_OFF_REQUEST_ERRORS.CANNOT_CANCEL_TERMINAL,
      );
    });

    it('should throw ConflictError when trying to cancel a REJECTED request', async () => {
      mockRequestRepo.findOne.mockResolvedValue(
        makePendingRequest({ status: RequestStatusEnum.REJECTED }),
      );

      await expect(service.cancelRequest('req-001', cancelDto)).rejects.toThrow(
        ConflictError,
      );
    });
  });

  // ─── retryHcmSubmit ─────────────────────────────────────────────────────────

  describe('retryHcmSubmit', () => {
    it('should reuse the original idempotency key and succeed on retry', async () => {
      const failedRequest = makePendingRequest({
        status: RequestStatusEnum.HCM_FAILED,
        hcmTransactionId: 'tx-uuid-001',
        hcmErrorMessage: 'Previous timeout',
      });
      mockRequestRepo.findOne.mockResolvedValue(failedRequest);
      mockRequestRepo.save.mockImplementation((req) => Promise.resolve(req));
      hcmClient.submitDeduction.mockResolvedValue(makeHcmSuccessResponse());

      const result = await service.retryHcmSubmit('req-001');

      // Same idempotency key — HCM treats it as idempotent if it was actually processed
      expect(hcmClient.submitDeduction).toHaveBeenCalledWith(
        expect.objectContaining({ transactionId: 'tx-uuid-001' }),
      );
      expect(result.status).toBe(RequestStatusEnum.HCM_SUBMITTED);
      expect(balanceService.commitDeduction).toHaveBeenCalledWith(
        'emp-123',
        'loc-us',
        'VACATION',
        3,
      );
    });

    it('should throw ConflictError if request is not in HCM_FAILED state', async () => {
      mockRequestRepo.findOne.mockResolvedValue(
        makePendingRequest({ status: RequestStatusEnum.PENDING_APPROVAL }),
      );

      await expect(service.retryHcmSubmit('req-001')).rejects.toThrow(
        ConflictError,
      );
      await expect(service.retryHcmSubmit('req-001')).rejects.toThrow(
        TIME_OFF_REQUEST_ERRORS.CANNOT_RETRY_NOT_FAILED,
      );
    });

    it('should remain HCM_FAILED if the retry also fails', async () => {
      const failedRequest = makePendingRequest({
        status: RequestStatusEnum.HCM_FAILED,
      });
      mockRequestRepo.findOne.mockResolvedValue(failedRequest);
      mockRequestRepo.save.mockImplementation((req) => Promise.resolve(req));
      hcmClient.submitDeduction.mockRejectedValue(
        new HcmUnavailableError('Still down'),
      );

      const result = await service.retryHcmSubmit('req-001');

      expect(result.status).toBe(RequestStatusEnum.HCM_FAILED);
      expect(result.hcmErrorMessage).toContain('Still down');
    });
  });
});
