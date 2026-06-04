import {
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';

export interface MockBalance {
  employeeId: string;
  locationId: string;
  leaveTypeId: string;
  availableDays: number;
}

export interface DeductionRequest {
  transactionId: string;
  employeeId: string;
  locationId: string;
  leaveTypeId: string;
  days: number;
}

export interface DeductionResponse {
  success: boolean;
  remainingBalance: number;
  errorMessage?: string;
}

@Injectable()
export class HcmService {
  private readonly logger = new Logger(HcmService.name);

  // In-memory balance store
  private readonly balances: MockBalance[] = [
    {
      employeeId: 'emp-123',
      locationId: 'loc-us',
      leaveTypeId: 'VACATION',
      availableDays: 15,
    },
    {
      employeeId: 'emp-123',
      locationId: 'loc-us',
      leaveTypeId: 'SICK',
      availableDays: 5,
    },
    {
      employeeId: 'emp-456',
      locationId: 'loc-uk',
      leaveTypeId: 'VACATION',
      availableDays: 25,
    },
  ];

  // Idempotency store: transactionId -> DeductionResponse
  private readonly processedTransactions = new Map<string, DeductionResponse>();

  // Configuration for chaotic testing
  private chaosMode = false;

  enableChaosMode(enable: boolean) {
    this.chaosMode = enable;
    this.logger.log(`Chaos mode set to: ${enable}`);
  }

  getBalance(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
  ): MockBalance {
    this.simulateChaos();

    const balance = this.balances.find(
      (b) =>
        b.employeeId === employeeId &&
        b.locationId === locationId &&
        b.leaveTypeId === leaveTypeId,
    );

    if (!balance) {
      // In a real system, requesting balance for non-existent dimensions might return 404
      throw new NotFoundException('Balance not found for given dimensions');
    }

    return balance;
  }

  getBatchBalances(): { balances: MockBalance[] } {
    this.simulateChaos();
    return { balances: this.balances };
  }

  processDeduction(request: DeductionRequest): DeductionResponse {
    this.simulateChaos();

    // 1. Idempotency Check
    if (this.processedTransactions.has(request.transactionId)) {
      this.logger.log(
        `Idempotency hit! Returning cached response for tx: ${request.transactionId}`,
      );
      return this.processedTransactions.get(request.transactionId)!;
    }

    // 2. Find Balance
    const balanceIndex = this.balances.findIndex(
      (b) =>
        b.employeeId === request.employeeId &&
        b.locationId === request.locationId &&
        b.leaveTypeId === request.leaveTypeId,
    );

    if (balanceIndex === -1) {
      const response: DeductionResponse = {
        success: false,
        remainingBalance: 0,
        errorMessage: 'Balance dimensions not found in HCM',
      };
      this.processedTransactions.set(request.transactionId, response);
      return response;
    }

    const balance = this.balances[balanceIndex];

    // 3. Business Logic validation (No overdrafts)
    if (balance.availableDays < request.days) {
      const response: DeductionResponse = {
        success: false,
        remainingBalance: balance.availableDays,
        errorMessage: 'Insufficient balance in HCM',
      };
      this.processedTransactions.set(request.transactionId, response);
      return response;
    }

    // 4. Mutate State
    balance.availableDays -= request.days;

    const successResponse: DeductionResponse = {
      success: true,
      remainingBalance: balance.availableDays,
    };

    this.logger.log(
      `Processed deduction for ${request.employeeId}. Days: ${request.days}. Remaining: ${balance.availableDays}. Tx: ${request.transactionId}`,
    );

    // Store in idempotency cache
    this.processedTransactions.set(request.transactionId, successResponse);

    return successResponse;
  }

  reverseDeduction(transactionId: string): {
    success: boolean;
    message: string;
  } {
    // In a real system, you'd find the transaction, look at what it deducted, and add it back.
    // For this mock, we'll just check if it exists and remove it, but we won't fully reverse the numbers
    // unless we recorded the original deduction request parameters.
    // Let's keep it simple: just acknowledge receipt.
    this.logger.log(`Reversing transaction: ${transactionId}`);

    if (this.processedTransactions.has(transactionId)) {
      // In reality, we would add the days back to `balances`.
      // For the mock, acknowledging is enough to test our time-off service's local cancellation.
      return { success: true, message: 'Reversal accepted' };
    }

    return { success: false, message: 'Transaction not found for reversal' };
  }

  /**
   * Randomly throws 500s or adds latency if chaos mode is enabled.
   * Useful to test exponential backoff and idempotency handling in the client.
   */
  private simulateChaos() {
    if (!this.chaosMode) return;

    const rand = Math.random();

    if (rand < 0.2) {
      // 20% chance of random 500 error
      this.logger.warn('Chaos monkey: Simulating 500 Internal Server Error');
      throw new InternalServerErrorException('Simulated HCM downtime');
    }

    // Simulate latency (0-500ms)
    // We do this sync via a busy-wait just for the mock, or we can just not do latency here
    // since Node is async. A proper sleep is better if we made methods async.
    // Given the methods are sync, let's just stick to 500 errors for chaos.
  }
}
