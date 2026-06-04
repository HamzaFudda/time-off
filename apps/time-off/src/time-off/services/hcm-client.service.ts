import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { lastValueFrom } from 'rxjs';
import { timeout } from 'rxjs/operators';
import {
  HcmBalanceResponse,
  HcmBatchResponse,
  HcmDeductionRequest,
  HcmDeductionResponse,
} from '../types/hcm.types';
import { HcmUnavailableError } from '../../shared/error/error';

/**
 * HcmClientService — the single point of contact with the HCM system.
 *
 * Design decisions:
 *
 * 1. ALL calls go through this service. Nothing else in the app speaks HTTP
 *    to the HCM directly. This makes it easy to swap implementations,
 *    add circuit breakers, or mock the whole layer in tests.
 *
 * 2. Retry logic is manual (not a library) so we can log each attempt
 *    and surface clear error metadata in HcmDeductionResponse.
 *    We use exponential backoff: delay = baseMs * 2^attempt.
 *
 * 3. Timeouts: every call is bounded by HCM_TIMEOUT_MS (default 5s).
 *    See TRD §9 — this would be tuned to HCM's actual p95 in production.
 *
 * 4. On network error OR 5xx: throw HcmUnavailableError. Callers decide
 *    whether to degrade gracefully (balance reads) or fail hard (approvals).
 *    On 4xx (bad request): the HCM rejected our data — do NOT retry.
 */
@Injectable()
export class HcmClientService {
  private readonly logger = new Logger(HcmClientService.name);

  // All three config values are documented in TRD §9 — they're defaults
  // that must be validated against HCM's actual latency / retry profile.
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
  ) {
    this.baseUrl = this.config.get<string>(
      'HCM_BASE_URL',
      'http://localhost:3001',
    );
    this.timeoutMs = parseInt(
      this.config.get<string>('HCM_TIMEOUT_MS', '5000'),
      10,
    );
    this.maxRetries = parseInt(
      this.config.get<string>('HCM_MAX_RETRIES', '3'),
      10,
    );
    this.retryBaseDelayMs = parseInt(
      this.config.get<string>('HCM_RETRY_BASE_DELAY_MS', '100'),
      10,
    );
  }

  /**
   * Real-time balance lookup for a single employee/leave-type dimension.
   * Called right before a manager approves a request (the pre-flight check).
   */
  async getBalance(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
  ): Promise<HcmBalanceResponse> {
    const url = `${this.baseUrl}/balances`;
    const params = { employeeId, locationId, leaveTypeId };

    return this.withRetry<HcmBalanceResponse>(async () => {
      const response = await lastValueFrom(
        this.httpService
          .get<HcmBalanceResponse>(url, { params })
          .pipe(timeout(this.timeoutMs)),
      );
      return response.data;
    }, `getBalance(${employeeId}, ${leaveTypeId})`);
  }

  /**
   * Full company batch pull — used by the cron sync job.
   * Returns all employee balances in one call.
   */
  async getBatchBalances(): Promise<HcmBatchResponse> {
    const url = `${this.baseUrl}/balances/batch`;

    return this.withRetry<HcmBatchResponse>(async () => {
      const response = await lastValueFrom(
        this.httpService
          .get<HcmBatchResponse>(url)
          .pipe(timeout(this.timeoutMs)),
      );
      return response.data;
    }, 'getBatchBalances');
  }

  /**
   * Submit a leave deduction to the HCM.
   *
   * The `transactionId` is the idempotency key generated at request creation
   * time and NEVER changes. If the HCM receives the same transactionId twice
   * (because we lost the first response and retried), it returns the cached
   * success result — no double deduction.
   *
   * Returns HcmDeductionResponse regardless of success/failure —
   * callers read `response.success` to decide next state.
   * We only throw HcmUnavailableError on network/5xx failures.
   */
  async submitDeduction(
    request: HcmDeductionRequest,
  ): Promise<HcmDeductionResponse> {
    const url = `${this.baseUrl}/deductions`;

    return this.withRetry<HcmDeductionResponse>(async () => {
      const response = await lastValueFrom(
        this.httpService
          .post<HcmDeductionResponse>(url, request)
          .pipe(timeout(this.timeoutMs)),
      );
      return response.data;
    }, `submitDeduction(txId=${request.transactionId})`);
  }

  /**
   * Reverse a previously submitted deduction.
   * Called when an employee cancels a request that was already HCM_SUBMITTED.
   */
  async reverseDeduction(transactionId: string): Promise<void> {
    const url = `${this.baseUrl}/deductions/${transactionId}/reverse`;

    await this.withRetry<void>(async () => {
      await lastValueFrom(
        this.httpService.post<void>(url).pipe(timeout(this.timeoutMs)),
      );
    }, `reverseDeduction(txId=${transactionId})`);
  }

  /**
   * Wraps an async HCM call with exponential backoff retry.
   *
   * Retry policy:
   * - Network errors and 5xx responses → retry up to `maxRetries` times
   * - 4xx responses → do NOT retry (bad data from our side, retrying won't help)
   * - After all retries exhausted → throw HcmUnavailableError
   *
   * Delay schedule (default config):
   *   attempt 0: 0ms (immediate first try)
   *   attempt 1: 100ms
   *   attempt 2: 200ms
   *   attempt 3: 400ms
   */
  private async withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delayMs = this.retryBaseDelayMs * Math.pow(2, attempt - 1);
        this.logger.warn(
          `HCM call "${label}" attempt ${attempt}/${this.maxRetries}, retrying in ${delayMs}ms`,
        );
        await this.sleep(delayMs);
      }

      try {
        return await fn();
      } catch (err) {
        const axiosErr = err as AxiosError;

        // 4xx — don't retry, the data we sent is wrong
        if (axiosErr.response?.status && axiosErr.response.status < 500) {
          this.logger.warn(
            `HCM returned ${axiosErr.response.status} for "${label}" — not retrying`,
          );
          throw new HcmUnavailableError(
            `HCM rejected request with status ${axiosErr.response.status}`,
          );
        }

        lastError = err as Error;
        this.logger.error(
          `HCM call "${label}" failed (attempt ${attempt}): ${lastError.message}`,
        );
      }
    }

    throw new HcmUnavailableError(
      `HCM unreachable after ${this.maxRetries} retries for "${label}"`,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
