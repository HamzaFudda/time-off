import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { HcmClientService } from './hcm-client.service';
import { HcmUnavailableError } from '../../shared/error/error';
import { of, throwError } from 'rxjs';
import { AxiosResponse } from 'axios';

describe('HcmClientService', () => {
  let service: HcmClientService;
  let httpService: jest.Mocked<HttpService>;

  beforeEach(async () => {
    const mockHttpService = {
      get: jest.fn(),
      post: jest.fn(),
    };

    const mockConfigService = {
      get: jest.fn((key: string, defaultValue: any) => defaultValue),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HcmClientService,
        { provide: HttpService, useValue: mockHttpService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<HcmClientService>(HcmClientService);
    httpService = module.get(HttpService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('exponential backoff (withRetry)', () => {
    it('should retry 3 times on 500 error and throw HcmUnavailableError', async () => {
      // Simulate 500 error
      httpService.get.mockReturnValue(
        throwError(() => ({
          response: { status: 500 },
          message: 'Internal Server Error',
        })),
      );

      await expect(
        service.getBalance('emp1', 'loc1', 'VACATION'),
      ).rejects.toThrow(HcmUnavailableError);

      // 1 initial call + 3 retries = 4 calls total
      expect(httpService.get).toHaveBeenCalledTimes(4);
    });

    it('should NOT retry on 400 error and throw immediately', async () => {
      // Simulate 400 error (e.g. invalid data)
      httpService.post.mockReturnValue(
        throwError(() => ({
          response: { status: 400 },
          message: 'Bad Request',
        })),
      );

      const req = {
        transactionId: 'tx1',
        employeeId: 'emp1',
        locationId: 'loc1',
        leaveTypeId: 'VACATION',
        days: 1,
      };

      await expect(service.submitDeduction(req)).rejects.toThrow(
        HcmUnavailableError,
      );

      // Only 1 call, no retries because 4xx
      expect(httpService.post).toHaveBeenCalledTimes(1);
    });

    it('should succeed if it fails once but passes on the first retry', async () => {
      const mockResponse: AxiosResponse = {
        data: {
          employeeId: 'emp1',
          locationId: 'loc1',
          leaveTypeId: 'VACATION',
          availableDays: 10,
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: { headers: {} as any },
      };

      httpService.get
        .mockReturnValueOnce(
          throwError(() => ({
            response: { status: 503 },
            message: 'Service Unavailable',
          })),
        )
        .mockReturnValueOnce(of(mockResponse));

      const res = await service.getBalance('emp1', 'loc1', 'VACATION');

      expect(res.availableDays).toBe(10);
      expect(httpService.get).toHaveBeenCalledTimes(2);
    });
  });
});
