import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { TimeOffRequestEntity } from '../entities/time-off-request.entity';
import { RequestStatusEnum } from '../enums/request-status.enum';
import { HcmClientService } from './hcm-client.service';
import { TimeOffBalanceService } from './time-off-balance.service';
import { CreateTimeOffRequestDto } from '../dtos/create-time-off-request.dto';
import { ApproveRequestDto } from '../dtos/approve-request.dto';
import { RejectRequestDto } from '../dtos/reject-request.dto';
import { CancelRequestDto } from '../dtos/cancel-request.dto';
import {
  ConflictError,
  HcmUnavailableError,
  NotFoundError,
} from '../../shared/error/error';
import { TIME_OFF_REQUEST_ERRORS } from '../../shared/constants/error-messages.const';

/**
 * TimeOffRequestService — owns the time-off request state machine.
 *
 * Saga transitions (see RequestStatusEnum for the full diagram):
 *
 *   createRequest     → PENDING_APPROVAL
 *   approveRequest    → HCM_SUBMITTING → HCM_SUBMITTED (or HCM_FAILED)
 *   rejectRequest     → REJECTED
 *   cancelRequest     → CANCELLED  (+ HCM reversal if already HCM_SUBMITTED)
 *   retryHcmSubmit    → HCM_SUBMITTING → HCM_SUBMITTED (or HCM_FAILED again)
 *
 * Key safety guarantees:
 *
 * 1. Pre-flight before approval: we call HCM for a live balance before
 *    touching any local state. If HCM is down, the approval fails with 503.
 *    We do NOT approve against cached data — that's how overdrafts happen.
 *
 * 2. Optimistic reserve: on approval, we increment `reservedDays` before
 *    calling HCM. This blocks a second concurrent approval from the same pool.
 *    On HCM failure: reservation is released, net effect = zero change.
 *    On HCM success: reservation released + availableDays decremented.
 *
 * 3. Idempotency: every request gets a UUID `hcmTransactionId` at creation.
 *    Every HCM deduction call includes this ID. If the network drops after
 *    HCM processes but before we get the response, the retry hits HCM
 *    with the same ID and HCM returns the cached result — no double-deduction.
 *
 * 4. Post-flight audit (see _auditHcmBalance): after HCM confirms a deduction,
 *    we fetch the resulting balance. If it doesn't match expectation, we log
 *    a warning. We do NOT block the request — the audit is observational.
 */
@Injectable()
export class TimeOffRequestService {
  private readonly logger = new Logger(TimeOffRequestService.name);

  constructor(
    @InjectRepository(TimeOffRequestEntity)
    private readonly requestRepo: Repository<TimeOffRequestEntity>,

    private readonly balanceService: TimeOffBalanceService,
    private readonly hcmClient: HcmClientService,
  ) {}

  // ─── Queries ──────────────────────────────────────────────────────────────

  async findAll(employeeId?: string): Promise<TimeOffRequestEntity[]> {
    const where = employeeId ? { employeeId } : {};
    return this.requestRepo.find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  async findById(id: string): Promise<TimeOffRequestEntity> {
    const request = await this.requestRepo.findOne({ where: { id } });

    if (!request) {
      throw new NotFoundError(
        TIME_OFF_REQUEST_ERRORS.REQUEST_NOT_FOUND_FOR_ID(id),
      );
    }

    return request;
  }

  // ─── Mutations ────────────────────────────────────────────────────────────

  /**
   * Creates a new time-off request in PENDING_APPROVAL state.
   *
   * The `hcmTransactionId` is assigned here and NEVER changes. It's the
   * idempotency key sent on every HCM deduction attempt for this request.
   */
  async createRequest(
    dto: CreateTimeOffRequestDto,
  ): Promise<TimeOffRequestEntity> {
    this.validateDates(dto.startDate, dto.endDate);

    const request = this.requestRepo.create({
      ...dto,
      status: RequestStatusEnum.PENDING_APPROVAL,
      hcmTransactionId: randomUUID(),
    });

    return this.requestRepo.save(request);
  }

  /**
   * Manager approves a pending request.
   *
   * Full flow:
   * 1. Validate request is in PENDING_APPROVAL state
   * 2. Pre-flight: fetch live HCM balance and verify sufficiency
   * 3. Transition → HCM_SUBMITTING + optimistically reserve days
   * 4. Submit deduction to HCM (with idempotency key)
   * 5a. On success → HCM_SUBMITTED + commit deduction + post-flight audit
   * 5b. On HCM failure → HCM_FAILED + release reservation
   */
  async approveRequest(
    id: string,
    dto: ApproveRequestDto,
  ): Promise<TimeOffRequestEntity> {
    const request = await this.findById(id);

    if (request.status !== RequestStatusEnum.PENDING_APPROVAL) {
      throw new ConflictError(
        TIME_OFF_REQUEST_ERRORS.CANNOT_APPROVE_NOT_PENDING,
      );
    }

    // Step 2: Pre-flight — throws HcmUnavailableError or ConflictError
    await this.balanceService.verifyLiveBalance(
      request.employeeId,
      request.locationId,
      request.leaveTypeId,
      request.numberOfDays,
    );

    // Step 3: Transition to HCM_SUBMITTING + reserve days
    await this.requestRepo.save({
      ...request,
      status: RequestStatusEnum.HCM_SUBMITTING,
      managerId: dto.managerId,
    });

    await this.balanceService.reserveDays(
      request.employeeId,
      request.locationId,
      request.leaveTypeId,
      request.numberOfDays,
    );

    // Step 4: Submit to HCM
    try {
      const hcmResponse = await this.hcmClient.submitDeduction({
        transactionId: request.hcmTransactionId,
        employeeId: request.employeeId,
        locationId: request.locationId,
        leaveTypeId: request.leaveTypeId,
        days: request.numberOfDays,
      });

      if (!hcmResponse.success) {
        // HCM returned 200 but reported failure (e.g., business rule violation)
        return this.handleHcmFailure(
          request,
          hcmResponse.errorMessage ?? 'HCM rejected deduction',
        );
      }

      // Step 5a: HCM confirmed
      const confirmed = await this.requestRepo.save({
        ...request,
        status: RequestStatusEnum.HCM_SUBMITTED,
        hcmErrorMessage: null,
      });

      await this.balanceService.commitDeduction(
        request.employeeId,
        request.locationId,
        request.leaveTypeId,
        request.numberOfDays,
      );

      // Post-flight audit (non-blocking, observational only)
      this.auditHcmBalance(request, hcmResponse.remainingBalance).catch((err) =>
        this.logger.warn(`Post-flight audit failed: ${(err as Error).message}`),
      );

      return confirmed;
    } catch (err) {
      if (err instanceof HcmUnavailableError) {
        return this.handleHcmFailure(request, err.message);
      }
      throw err;
    }
  }

  /**
   * Manager rejects a pending request. No HCM call needed.
   */
  async rejectRequest(
    id: string,
    dto: RejectRequestDto,
  ): Promise<TimeOffRequestEntity> {
    const request = await this.findById(id);

    if (request.status !== RequestStatusEnum.PENDING_APPROVAL) {
      throw new ConflictError(
        TIME_OFF_REQUEST_ERRORS.CANNOT_REJECT_NOT_PENDING,
      );
    }

    return this.requestRepo.save({
      ...request,
      status: RequestStatusEnum.REJECTED,
      managerId: dto.managerId,
      reason: dto.reason ?? null,
    });
  }

  /**
   * Employee cancels their own request.
   *
   * If the request is already HCM_SUBMITTED, we call HCM to reverse the deduction.
   * If it's still PENDING_APPROVAL or APPROVED (before HCM), no HCM call needed.
   * Terminal states (CANCELLED, REJECTED, HCM_FAILED) cannot be cancelled.
   */
  async cancelRequest(
    id: string,
    dto: CancelRequestDto,
  ): Promise<TimeOffRequestEntity> {
    const request = await this.findById(id);

    const cancellableStatuses: RequestStatusEnum[] = [
      RequestStatusEnum.PENDING_APPROVAL,
      RequestStatusEnum.APPROVED,
      RequestStatusEnum.HCM_SUBMITTED,
    ];

    if (!cancellableStatuses.includes(request.status)) {
      throw new ConflictError(TIME_OFF_REQUEST_ERRORS.CANNOT_CANCEL_TERMINAL);
    }

    // If HCM already has this deduction, we must reverse it
    if (request.status === RequestStatusEnum.HCM_SUBMITTED) {
      try {
        await this.hcmClient.reverseDeduction(request.hcmTransactionId);
        await this.balanceService.releaseReservation(
          request.employeeId,
          request.locationId,
          request.leaveTypeId,
          request.numberOfDays,
        );
        // Also restore the available days that were committed
        // by incrementing availableDays back (re-use commitDeduction with negative)
        await this.balanceService.commitDeduction(
          request.employeeId,
          request.locationId,
          request.leaveTypeId,
          -request.numberOfDays,
        );
      } catch (err) {
        this.logger.error(
          `HCM reversal failed for request ${id}: ${(err as Error).message}`,
        );
        // We still cancel locally — an ops team can reconcile the HCM manually
      }
    } else if (
      request.status === RequestStatusEnum.APPROVED ||
      request.status === RequestStatusEnum.HCM_SUBMITTING
    ) {
      // Release the reservation that was set at approval time
      await this.balanceService.releaseReservation(
        request.employeeId,
        request.locationId,
        request.leaveTypeId,
        request.numberOfDays,
      );
    }

    return this.requestRepo.save({
      ...request,
      status: RequestStatusEnum.CANCELLED,
      reason: dto.reason ?? null,
    });
  }

  /**
   * Retries an HCM submission for a request stuck in HCM_FAILED.
   * Useful for when HCM comes back online after downtime.
   */
  async retryHcmSubmit(id: string): Promise<TimeOffRequestEntity> {
    const request = await this.findById(id);

    if (request.status !== RequestStatusEnum.HCM_FAILED) {
      throw new ConflictError(TIME_OFF_REQUEST_ERRORS.CANNOT_RETRY_NOT_FAILED);
    }

    await this.requestRepo.save({
      ...request,
      status: RequestStatusEnum.HCM_SUBMITTING,
      hcmErrorMessage: null,
    });

    try {
      const hcmResponse = await this.hcmClient.submitDeduction({
        transactionId: request.hcmTransactionId, // same idempotency key — safe to retry
        employeeId: request.employeeId,
        locationId: request.locationId,
        leaveTypeId: request.leaveTypeId,
        days: request.numberOfDays,
      });

      if (!hcmResponse.success) {
        return this.handleHcmFailure(
          request,
          hcmResponse.errorMessage ?? 'HCM rejected deduction',
        );
      }

      const confirmed = await this.requestRepo.save({
        ...request,
        status: RequestStatusEnum.HCM_SUBMITTED,
        hcmErrorMessage: null,
      });

      await this.balanceService.commitDeduction(
        request.employeeId,
        request.locationId,
        request.leaveTypeId,
        request.numberOfDays,
      );

      return confirmed;
    } catch (err) {
      return this.handleHcmFailure(request, (err as Error).message);
    }
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  private async handleHcmFailure(
    request: TimeOffRequestEntity,
    errorMessage: string,
  ): Promise<TimeOffRequestEntity> {
    this.logger.error(
      `HCM submission failed for request ${request.id}: ${errorMessage}`,
    );

    // Release the optimistic reservation — the days go back to available
    await this.balanceService.releaseReservation(
      request.employeeId,
      request.locationId,
      request.leaveTypeId,
      request.numberOfDays,
    );

    return this.requestRepo.save({
      ...request,
      status: RequestStatusEnum.HCM_FAILED,
      hcmErrorMessage: errorMessage,
    });
  }

  /**
   * Post-flight audit: after HCM confirms a deduction, we compare the
   * remaining balance HCM returned against what we expect.
   *
   * This detects the "HCM silently accepted bad data" failure mode from TRD §4.4.
   * We log a WARNING — we do NOT block or roll back. This is observational.
   * Ops can investigate the flagged discrepancy async.
   */
  private async auditHcmBalance(
    request: TimeOffRequestEntity,
    hcmRemainingBalance: number,
  ): Promise<void> {
    try {
      const { balance } = await this.balanceService.getBalance(
        request.employeeId,
        request.locationId,
        request.leaveTypeId,
      );

      const expectedRemaining = balance.availableDays;
      const drift = Math.abs(hcmRemainingBalance - expectedRemaining);

      if (drift > 0.01) {
        // Tolerance of 0.01 days for floating point
        this.logger.warn(
          `Post-flight audit MISMATCH for request ${request.id}: ` +
            `HCM says ${hcmRemainingBalance} days remaining, ` +
            `local cache says ${expectedRemaining}. Drift: ${drift}. ` +
            `Request flagged for manual reconciliation.`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Post-flight audit fetch failed: ${(err as Error).message}`,
      );
    }
  }

  private validateDates(startDate: string, endDate: string): void {
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (end < start) {
      throw new ConflictError(TIME_OFF_REQUEST_ERRORS.END_BEFORE_START);
    }
  }
}
