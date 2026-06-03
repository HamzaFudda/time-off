import { Column, Entity, Index, Unique } from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { EntityBase } from '../../shared/database/base.entity';

/**
 * TimeOffBalanceEntity — local cache of HCM balance per (employee, location, leaveType).
 *
 * Design notes:
 *
 * 1. OPTIMISTIC LOCKING via `version` from EntityBase (@VersionColumn).
 *    TypeORM increments `version` on every UPDATE and includes
 *    WHERE version = :version in the query. Concurrent writers on the same row
 *    get OptimisticLockVersionMismatchError and must retry with fresh data.
 *    This prevents lost-update races without holding DB locks across HCM round-trips.
 *
 * 2. `reservedDays` — optimistic balance reservation.
 *    When a request is approved but HCM hasn't confirmed yet, we immediately
 *    increment `reservedDays`. Effective balance = availableDays - reservedDays.
 *    On HCM success: availableDays decremented + reservedDays decremented (net: -N).
 *    On HCM failure: reservedDays decremented only (full rollback to pre-approval state).
 *
 * 3. Batch syncs touch `availableDays` ONLY — never `reservedDays`.
 *    This ensures in-flight reservations survive a concurrent sync operation.
 *
 * 4. Unique constraint on (employeeId, locationId, leaveTypeId) — the composite
 *    business key. We upsert on conflict during sync.
 */
@Entity('time_off_balance')
@Unique('uq_time_off_balance_dimensions', [
  'employeeId',
  'locationId',
  'leaveTypeId',
])
@Index('idx_time_off_balance_employee', ['employeeId'])
export class TimeOffBalanceEntity extends EntityBase {
  @ApiProperty({ description: 'Employee this balance belongs to' })
  @Column({ name: 'employee_id', type: 'varchar' })
  employeeId!: string;

  @ApiProperty({ description: 'HCM location dimension' })
  @Column({ name: 'location_id', type: 'varchar' })
  locationId!: string;

  @ApiProperty({ description: 'HCM leave type dimension' })
  @Column({ name: 'leave_type_id', type: 'varchar' })
  leaveTypeId!: string;

  @ApiProperty({
    description: 'HCM-sourced available days. Updated by sync operations only.',
    example: 10.0,
  })
  @Column({ name: 'available_days', type: 'real', default: 0 })
  availableDays!: number;

  @ApiProperty({
    description:
      'Days optimistically reserved by in-flight approvals awaiting HCM confirmation. ' +
      'Effective balance = availableDays - reservedDays.',
    example: 2.0,
  })
  @Column({ name: 'reserved_days', type: 'real', default: 0 })
  reservedDays!: number;

  @ApiProperty({
    description:
      'Timestamp of last successful HCM sync. Used to detect stale cache.',
    nullable: true,
  })
  @Column({ name: 'last_synced_at', type: 'datetime', nullable: true })
  lastSyncedAt?: Date | null;
}
