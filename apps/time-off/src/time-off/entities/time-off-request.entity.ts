import { Column, Entity, Index } from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { EntityBase } from '../../shared/database/base.entity';
import { RequestStatusEnum } from '../enums/request-status.enum';

/**
 * TimeOffRequestEntity — tracks the full lifecycle of a single time-off request.
 *
 * Design notes:
 * - `hcmTransactionId` is set at creation and NEVER changed. This is the
 *   idempotency key sent to HCM. The same key on every retry ensures HCM
 *   cannot double-deduct even if a previous response was lost in transit.
 * - `status` follows the saga state machine in RequestStatusEnum.
 *   All transitions go through TimeOffRequestService — never update directly.
 * - `numberOfDays` is computed once at submission. We don't recompute from
 *   dates so that business rule changes don't retroactively affect requests.
 */
@Entity('time_off_request')
@Index('idx_time_off_request_employee_status', ['employeeId', 'status'])
@Index('idx_time_off_request_manager', ['managerId'])
export class TimeOffRequestEntity extends EntityBase {
  @ApiProperty({ description: 'Employee submitting the request' })
  @Column({ name: 'employee_id', type: 'varchar' })
  @Index('idx_time_off_request_employee_id')
  employeeId!: string;

  @ApiProperty({
    description: 'Manager who acted on the request (null while pending)',
    nullable: true,
  })
  @Column({ name: 'manager_id', type: 'varchar', nullable: true })
  managerId?: string | null;

  @ApiProperty({ description: 'HCM location dimension' })
  @Column({ name: 'location_id', type: 'varchar' })
  locationId!: string;

  @ApiProperty({
    description: 'HCM leave type dimension (e.g. vacation, sick)',
  })
  @Column({ name: 'leave_type_id', type: 'varchar' })
  leaveTypeId!: string;

  @ApiProperty({ description: 'Start date (YYYY-MM-DD)' })
  @Column({ name: 'start_date', type: 'varchar' })
  startDate!: string;

  @ApiProperty({ description: 'End date inclusive (YYYY-MM-DD)' })
  @Column({ name: 'end_date', type: 'varchar' })
  endDate!: string;

  @ApiProperty({
    description: 'Number of leave days (pre-computed at submission)',
  })
  @Column({ name: 'number_of_days', type: 'real' })
  numberOfDays!: number;

  @ApiProperty({
    enum: RequestStatusEnum,
    description: 'Current lifecycle status',
  })
  @Column({ type: 'varchar', default: RequestStatusEnum.PENDING_APPROVAL })
  @Index('idx_time_off_request_status')
  status!: RequestStatusEnum;

  /**
   * UUID v4 set at creation — used as the idempotency key for every HCM deduction call.
   * NEVER mutated. If HCM receives the same key twice, it treats it as a no-op.
   */
  @Column({ name: 'hcm_transaction_id', type: 'varchar', unique: true })
  hcmTransactionId!: string;

  @ApiProperty({
    description: 'HCM error message from the last failed submission',
    nullable: true,
  })
  @Column({ name: 'hcm_error_message', type: 'text', nullable: true })
  hcmErrorMessage?: string | null;

  @ApiProperty({
    description: 'Optional rejection or cancellation reason',
    nullable: true,
  })
  @Column({ name: 'reason', type: 'text', nullable: true })
  reason?: string | null;
}
