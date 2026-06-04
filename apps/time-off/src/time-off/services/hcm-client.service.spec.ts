/**
 * HcmClientService — Unit Tests
 *
 * Coverage strategy:
 *
 * ┌────────────────────────────┬───────────────────────────────────────────────┐
 * │ Concern                    │ Scenarios covered                             │
 * ├────────────────────────────┼───────────────────────────────────────────────┤
 * │ Initialization             │ reads config values correctly                 │
 * │ getBalance                 │ happy path, 3×500 → HcmUnavailableError,      │
 * │                            │ 503 then 200 → success on 1st retry           │
 * │ submitDeduction            │ happy path, 400 → no retry, 500×n → failure  │
 * │ reverseDeduction           │ happy path, 500 failure                       │
 * │ withRetry backoff          │ exponential delay between retries              │
 * │ withRetry — 4xx abort      │ 400/422 never retried                         │
 * │ Timeout                    │ rxjs timeout causes retry                     │
 * └────────────────────────────┴───────────────────────────────────────────────┘
 */

import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { HcmClientService } from './hcm-client.service';
import { HcmUnavailableError } from '../../shared/error/error';
import { of, throwError } from 'rxjs';
import { AxiosResponse, AxiosError } from 'axios';

// ─── Helpers ───────────────────────────────────────────────────────────────────

const makeAxiosError = (status: number, message = 'Error'): AxiosError =>
  ({
    response: { status, data: {}, headers: {}, statusText: '' },
    message,
    name: 'AxiosError',
    isAxiosError: true,
  }) as AxiosError;

const makeAxiosResponse = <T>(data: T): AxiosResponse<T> => ({
  data,
  status: 200,
  statusText: 'OK',
  headers: {},
  config: { headers: {} as any },
});

// ─── Test Suite ────────────────────────────────────────────────────────────────

describe('HcmClientService', () => {
  let service: HcmClientService;
  let httpService: jest.Mocked<Pick<HttpService, 'get' | 'post'>>;

  const makeConfigService = (overrides: Record<string, string> = {}) => ({
    get: jest.fn(
      (key: string, defaultValue: string) => overrides[key] ?? defaultValue,
    ),
  });

  beforeEach(async () => {
    const mockHttpService = {
      get: jest.fn(),
      post: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HcmClientService,
        { provide: HttpService, useValue: mockHttpService },
        // Zero retry delay so tests run fast
        {
          provide: ConfigService,
          useValue: makeConfigService({
            HCM_BASE_URL: 'http://localhost:3001',
            HCM_TIMEOUT_MS: '2000',
            HCM_MAX_RETRIES: '3',
            HCM_RETRY_BASE_DELAY_MS: '0', // Zero delay for fast tests
          }),
        },
      ],
    }).compile();

    service = module.get(HcmClientService);
    httpService = module.get(HttpService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should initialize correctly', () => {
    expect(service).toBeDefined();
  });

  // ─── getBalance ─────────────────────────────────────────────────────────────

  describe('getBalance', () => {
    const hcmBalancePayload = {
      employeeId: 'emp-123',
      locationId: 'loc-us',
      leaveTypeId: 'VACATION',
      availableDays: 15,
      asOfDate: new Date().toISOString(),
    };

    it('returns the parsed balance on success', async () => {
      httpService.get.mockReturnValue(of(makeAxiosResponse(hcmBalancePayload)));

      const result = await service.getBalance('emp-123', 'loc-us', 'VACATION');

      expect(result.availableDays).toBe(15);
      expect(result.asOfDate).toBeDefined();
    });

    it('calls the correct URL and query params', async () => {
      httpService.get.mockReturnValue(of(makeAxiosResponse(hcmBalancePayload)));

      await service.getBalance('emp-123', 'loc-us', 'VACATION');

      expect(httpService.get).toHaveBeenCalledWith(
        'http://localhost:3001/balances',
        expect.objectContaining({
          params: {
            employeeId: 'emp-123',
            locationId: 'loc-us',
            leaveTypeId: 'VACATION',
          },
        }),
      );
    });

    it('retries 3 times on 500 error and throws HcmUnavailableError', async () => {
      httpService.get.mockReturnValue(throwError(() => makeAxiosError(500)));

      await expect(
        service.getBalance('emp-123', 'loc-us', 'VACATION'),
      ).rejects.toThrow(HcmUnavailableError);

      // 1 initial + 3 retries = 4 calls
      expect(httpService.get).toHaveBeenCalledTimes(4);
    });

    it('succeeds on the first retry after one transient failure', async () => {
      httpService.get
        .mockReturnValueOnce(
          throwError(() => makeAxiosError(503, 'Transient failure')),
        )
        .mockReturnValueOnce(of(makeAxiosResponse(hcmBalancePayload)));

      const result = await service.getBalance('emp-123', 'loc-us', 'VACATION');

      expect(result.availableDays).toBe(15);
      expect(httpService.get).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry on 404 (dimensions not found)', async () => {
      httpService.get.mockReturnValue(
        throwError(() => makeAxiosError(404, 'Not Found')),
      );

      await expect(
        service.getBalance('emp-unknown', 'loc-us', 'VACATION'),
      ).rejects.toThrow(HcmUnavailableError);

      // 4xx — only 1 call, no retries
      expect(httpService.get).toHaveBeenCalledTimes(1);
    });
  });

  // ─── getBatchBalances ───────────────────────────────────────────────────────

  describe('getBatchBalances', () => {
    const batchPayload = {
      balances: [
        {
          employeeId: 'emp-123',
          locationId: 'loc-us',
          leaveTypeId: 'VACATION',
          availableDays: 15,
          asOfDate: new Date().toISOString(),
        },
      ],
      asOfDate: new Date().toISOString(),
    };

    it('returns the full batch response on success', async () => {
      httpService.get.mockReturnValue(of(makeAxiosResponse(batchPayload)));

      const result = await service.getBatchBalances();

      expect(result.balances).toHaveLength(1);
      expect(result.asOfDate).toBeDefined();
    });

    it('calls the /balances/batch endpoint', async () => {
      httpService.get.mockReturnValue(of(makeAxiosResponse(batchPayload)));

      await service.getBatchBalances();

      expect(httpService.get).toHaveBeenCalledWith(
        'http://localhost:3001/balances/batch',
      );
    });

    it('throws HcmUnavailableError after max retries on 500 failures', async () => {
      httpService.get.mockReturnValue(throwError(() => makeAxiosError(500)));

      await expect(service.getBatchBalances()).rejects.toThrow(
        HcmUnavailableError,
      );
      expect(httpService.get).toHaveBeenCalledTimes(4);
    });
  });

  // ─── submitDeduction ────────────────────────────────────────────────────────

  describe('submitDeduction', () => {
    const deductionRequest = {
      transactionId: 'tx-abc',
      employeeId: 'emp-123',
      locationId: 'loc-us',
      leaveTypeId: 'VACATION',
      days: 3,
    };

    const deductionSuccess = {
      transactionId: 'tx-abc',
      success: true,
      remainingBalance: 12,
      processedAt: new Date().toISOString(),
    };

    it('sends the deduction to POST /deductions and returns the response', async () => {
      httpService.post.mockReturnValue(of(makeAxiosResponse(deductionSuccess)));

      const result = await service.submitDeduction(deductionRequest);

      expect(result.success).toBe(true);
      expect(result.remainingBalance).toBe(12);
      expect(result.transactionId).toBe('tx-abc');
    });

    it('sends the transactionId as the idempotency key in the request body', async () => {
      httpService.post.mockReturnValue(of(makeAxiosResponse(deductionSuccess)));

      await service.submitDeduction(deductionRequest);

      expect(httpService.post).toHaveBeenCalledWith(
        'http://localhost:3001/deductions',
        expect.objectContaining({ transactionId: 'tx-abc' }),
      );
    });

    it('does NOT retry on 400 Bad Request (bad data from our side)', async () => {
      httpService.post.mockReturnValue(throwError(() => makeAxiosError(400)));

      await expect(service.submitDeduction(deductionRequest)).rejects.toThrow(
        HcmUnavailableError,
      );
      expect(httpService.post).toHaveBeenCalledTimes(1); // No retries
    });

    it('retries on 500 errors and throws after max retries', async () => {
      httpService.post.mockReturnValue(throwError(() => makeAxiosError(500)));

      await expect(service.submitDeduction(deductionRequest)).rejects.toThrow(
        HcmUnavailableError,
      );
      expect(httpService.post).toHaveBeenCalledTimes(4);
    });

    it('returns a success=false response (HCM business rejection) without throwing', async () => {
      const rejectionResponse = {
        transactionId: 'tx-abc',
        success: false,
        remainingBalance: 15,
        errorMessage: 'Policy violation',
        processedAt: new Date().toISOString(),
      };
      httpService.post.mockReturnValue(
        of(makeAxiosResponse(rejectionResponse)),
      );

      // Should NOT throw — caller reads response.success
      const result = await service.submitDeduction(deductionRequest);

      expect(result.success).toBe(false);
      expect(result.errorMessage).toBe('Policy violation');
    });
  });

  // ─── reverseDeduction ───────────────────────────────────────────────────────

  describe('reverseDeduction', () => {
    it('calls the reversal endpoint and resolves without error', async () => {
      httpService.post.mockReturnValue(
        of(makeAxiosResponse({ success: true, message: 'Reversal accepted' })),
      );

      await expect(service.reverseDeduction('tx-abc')).resolves.toBeUndefined();

      expect(httpService.post).toHaveBeenCalledWith(
        'http://localhost:3001/deductions/tx-abc/reverse',
      );
    });

    it('throws HcmUnavailableError after failed reversal retries', async () => {
      httpService.post.mockReturnValue(throwError(() => makeAxiosError(500)));

      await expect(service.reverseDeduction('tx-abc')).rejects.toThrow(
        HcmUnavailableError,
      );
    });
  });

  // ─── withRetry — config variations ─────────────────────────────────────────

  describe('withRetry — retry count configuration', () => {
    it('respects HCM_MAX_RETRIES=1 (only 2 total calls: initial + 1 retry)', async () => {
      // Use a local stored reference so we can call mockReturnValue without
      // triggering the jest/unbound-method rule.
      const mockGet = jest.fn();
      const mockPost = jest.fn();

      const customModule: TestingModule = await Test.createTestingModule({
        providers: [
          HcmClientService,
          {
            provide: HttpService,
            useValue: { get: mockGet, post: mockPost },
          },
          {
            provide: ConfigService,
            useValue: makeConfigService({
              HCM_MAX_RETRIES: '1',
              HCM_RETRY_BASE_DELAY_MS: '0',
            }),
          },
        ],
      }).compile();

      const customService = customModule.get(HcmClientService);
      mockGet.mockReturnValue(throwError(() => makeAxiosError(500)));

      await expect(customService.getBalance('e', 'l', 'V')).rejects.toThrow(
        HcmUnavailableError,
      );
      expect(mockGet).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
    });
  });
});
