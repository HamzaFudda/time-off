import {
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';

// ─── Interfaces ────────────────────────────────────────────────────────────────

export interface MockBalance {
  employeeId: string;
  locationId: string;
  leaveTypeId: string;
  /** Days currently available in the HCM */
  availableDays: number;
  /** ISO timestamp of when this balance was last modified in the HCM */
  lastModifiedAt: string;
}

export interface BalanceResponse {
  employeeId: string;
  locationId: string;
  leaveTypeId: string;
  availableDays: number;
  /** ISO timestamp — signals to the consumer how fresh this data is */
  asOfDate: string;
}

export interface DeductionRequest {
  transactionId: string;
  employeeId: string;
  locationId: string;
  leaveTypeId: string;
  days: number;
}

export interface DeductionResponse {
  /** The idempotency key echo — consumer uses this to confirm which tx was processed */
  transactionId: string;
  success: boolean;
  remainingBalance: number;
  errorMessage?: string;
  /** ISO timestamp so the consumer can update its local cache accurately */
  processedAt: string;
}

export interface BalanceMutationLog {
  employeeId: string;
  locationId: string;
  leaveTypeId: string;
  previousBalance: number;
  newBalance: number;
  reason: string;
  mutatedAt: string;
}

// ─── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class HcmService {
  private readonly logger = new Logger(HcmService.name);

  /**
   * Seed data representing the canonical HCM source-of-truth.
   * In a real HCM, this would be backed by a persistent store (Workday DB, SAP, etc.).
   */
  private readonly balances: MockBalance[] = [
    {
      employeeId: 'emp-123',
      locationId: 'loc-us',
      leaveTypeId: 'VACATION',
      availableDays: 15,
      lastModifiedAt: new Date().toISOString(),
    },
    {
      employeeId: 'emp-123',
      locationId: 'loc-us',
      leaveTypeId: 'SICK',
      availableDays: 5,
      lastModifiedAt: new Date().toISOString(),
    },
    {
      employeeId: 'emp-456',
      locationId: 'loc-uk',
      leaveTypeId: 'VACATION',
      availableDays: 25,
      lastModifiedAt: new Date().toISOString(),
    },
  ];

  /**
   * Idempotency store: transactionId → DeductionResponse.
   *
   * A real HCM would persist this in a database with a TTL. We keep it
   * in-memory for the mock. The key insight: once a transactionId is recorded
   * here, we return the same response forever — no double deductions.
   */
  private readonly processedTransactions = new Map<string, DeductionResponse>();

  /**
   * Audit log of all out-of-band balance mutations (anniversary bonuses,
   * HR corrections, etc.). Exposed via GET /admin/mutation-log so our
   * time-off service tests can introspect what changed.
   */
  private readonly mutationLog: BalanceMutationLog[] = [];

  /** Chaos mode configuration for testing resilience */
  private chaosConfig = {
    enabled: false,
    failureProbability: 0.2, // 20% chance of 500 on each call
  };

  // ─── Balance Queries ─────────────────────────────────────────────────────

  getBalance(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
  ): BalanceResponse {
    this.simulateChaos();

    const balance = this.findBalance(employeeId, locationId, leaveTypeId);

    return {
      employeeId: balance.employeeId,
      locationId: balance.locationId,
      leaveTypeId: balance.leaveTypeId,
      availableDays: balance.availableDays,
      asOfDate: balance.lastModifiedAt,
    };
  }

  getBatchBalances(): { balances: BalanceResponse[]; asOfDate: string } {
    this.simulateChaos();

    const asOfDate = new Date().toISOString();

    return {
      balances: this.balances.map((b) => ({
        employeeId: b.employeeId,
        locationId: b.locationId,
        leaveTypeId: b.leaveTypeId,
        availableDays: b.availableDays,
        asOfDate: b.lastModifiedAt,
      })),
      asOfDate,
    };
  }

  // ─── Deductions ──────────────────────────────────────────────────────────

  processDeduction(request: DeductionRequest): DeductionResponse {
    this.simulateChaos();

    // 1. Idempotency Check — return cached response if we've seen this tx before
    const cached = this.processedTransactions.get(request.transactionId);
    if (cached) {
      this.logger.log(
        `Idempotency hit for tx: ${request.transactionId} — returning cached response`,
      );
      return cached;
    }

    // 2. Find the balance record
    let balance: MockBalance;
    try {
      balance = this.findBalance(
        request.employeeId,
        request.locationId,
        request.leaveTypeId,
      );
    } catch {
      const response: DeductionResponse = {
        transactionId: request.transactionId,
        success: false,
        remainingBalance: 0,
        errorMessage: 'Employee/leave-type dimensions not found in HCM',
        processedAt: new Date().toISOString(),
      };
      this.processedTransactions.set(request.transactionId, response);
      return response;
    }

    // 3. Business rule: no overdrafts
    if (balance.availableDays < request.days) {
      const response: DeductionResponse = {
        transactionId: request.transactionId,
        success: false,
        remainingBalance: balance.availableDays,
        errorMessage: `Insufficient balance in HCM: requested ${request.days}, available ${balance.availableDays}`,
        processedAt: new Date().toISOString(),
      };
      this.processedTransactions.set(request.transactionId, response);
      return response;
    }

    // 4. Commit the deduction
    balance.availableDays -= request.days;
    balance.lastModifiedAt = new Date().toISOString();

    const response: DeductionResponse = {
      transactionId: request.transactionId,
      success: true,
      remainingBalance: balance.availableDays,
      processedAt: balance.lastModifiedAt,
    };

    this.processedTransactions.set(request.transactionId, response);

    this.logger.log(
      `Deduction committed — tx: ${request.transactionId}, employee: ${request.employeeId}, days: ${request.days}, remaining: ${balance.availableDays}`,
    );

    return response;
  }

  reverseDeduction(transactionId: string): {
    success: boolean;
    message: string;
  } {
    this.logger.log(`Reversal request for tx: ${transactionId}`);

    const original = this.processedTransactions.get(transactionId);
    if (!original || !original.success) {
      return {
        success: false,
        message: 'Transaction not found or was not a successful deduction',
      };
    }

    // In a real HCM, we'd look up the original request to know how many days
    // to add back. For the mock, we note that the caller (our time-off service)
    // tracks this locally and we simply acknowledge the reversal.
    // This is intentionally simplified — the caller's local state is the source
    // of truth for reversal amounts.
    return { success: true, message: 'Reversal accepted by HCM' };
  }

  // ─── Admin / Test Control Endpoints ──────────────────────────────────────

  /**
   * Simulate an out-of-band HCM mutation — e.g. HR anniversary bonus,
   * manual correction, carry-over policy applied by a batch job.
   *
   * This is what makes our time-off service's sync and TTL logic meaningful
   * to test: we can change HCM state externally and then verify that our
   * service detects and reconciles the divergence.
   */
  mutateBalance(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
    newAvailableDays: number,
    reason: string,
  ): BalanceResponse {
    const balance = this.findBalance(employeeId, locationId, leaveTypeId);
    const previousBalance = balance.availableDays;

    balance.availableDays = newAvailableDays;
    balance.lastModifiedAt = new Date().toISOString();

    const logEntry: BalanceMutationLog = {
      employeeId,
      locationId,
      leaveTypeId,
      previousBalance,
      newBalance: newAvailableDays,
      reason,
      mutatedAt: balance.lastModifiedAt,
    };

    this.mutationLog.push(logEntry);

    this.logger.log(
      `Out-of-band mutation: ${employeeId} ${leaveTypeId} ${previousBalance} → ${newAvailableDays} (${reason})`,
    );

    return {
      employeeId: balance.employeeId,
      locationId: balance.locationId,
      leaveTypeId: balance.leaveTypeId,
      availableDays: balance.availableDays,
      asOfDate: balance.lastModifiedAt,
    };
  }

  getMutationLog(): BalanceMutationLog[] {
    return this.mutationLog;
  }

  setChaosMode(enabled: boolean, failureProbability?: number): void {
    this.chaosConfig.enabled = enabled;
    if (failureProbability !== undefined) {
      this.chaosConfig.failureProbability = failureProbability;
    }
    this.logger.log(
      `Chaos mode: ${enabled}, failure probability: ${this.chaosConfig.failureProbability}`,
    );
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  private findBalance(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
  ): MockBalance {
    const balance = this.balances.find(
      (b) =>
        b.employeeId === employeeId &&
        b.locationId === locationId &&
        b.leaveTypeId === leaveTypeId,
    );

    if (!balance) {
      throw new NotFoundException(
        `No balance record found in HCM for employee=${employeeId}, location=${locationId}, leaveType=${leaveTypeId}`,
      );
    }

    return balance;
  }

  /**
   * Chaos mode simulates random HCM unavailability to test:
   * - Exponential backoff in HcmClientService
   * - Idempotency on retries (no double deductions)
   * - Graceful degradation (cached balance reads still served)
   */
  private simulateChaos(): void {
    if (!this.chaosConfig.enabled) return;

    if (Math.random() < this.chaosConfig.failureProbability) {
      this.logger.warn(
        `[CHAOS] Simulating HCM 500 Internal Server Error (probability: ${this.chaosConfig.failureProbability})`,
      );
      throw new InternalServerErrorException(
        'Simulated HCM downtime (chaos mode)',
      );
    }
  }
}
