import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { SyncTypeEnum } from '../enums/sync-type.enum';

/**
 * BalanceSyncLogEntity — immutable audit trail of every HCM sync operation.
 *
 * Design notes:
 * - Append-only: rows are NEVER updated, only inserted.
 * - Does NOT extend EntityBase because it intentionally has no `version`
 *   column (optimistic locking has no meaning on an append-only table),
 *   and no `updatedAt` (rows are immutable post-insert).
 * - Uses integer PK (not UUID) for storage efficiency — this table
 *   can accumulate millions of rows.
 * - Retention: rows older than 90 days should be archived by a maintenance
 *   job (out of scope for v1, but `syncedAt` is indexed for this purpose).
 */
@Entity('balance_sync_log')
@Index('idx_balance_sync_log_employee_dimensions', [
  'employeeId',
  'locationId',
  'leaveTypeId',
])
@Index('idx_balance_sync_log_synced_at', ['syncedAt'])
export class BalanceSyncLogEntity {
  @ApiProperty()
  @PrimaryGeneratedColumn()
  id!: number;

  @ApiProperty({ enum: SyncTypeEnum })
  @Column({ name: 'sync_type', type: 'varchar' })
  syncType!: SyncTypeEnum;

  @ApiProperty()
  @Column({ name: 'employee_id', type: 'varchar' })
  @Index('idx_balance_sync_log_employee_id')
  employeeId!: string;

  @ApiProperty()
  @Column({ name: 'location_id', type: 'varchar' })
  locationId!: string;

  @ApiProperty()
  @Column({ name: 'leave_type_id', type: 'varchar' })
  leaveTypeId!: string;

  @ApiProperty({
    description:
      'Balance before this sync. Null on first-ever sync for this dimension.',
    nullable: true,
  })
  @Column({ name: 'previous_balance', type: 'real', nullable: true })
  previousBalance?: number | null;

  @ApiProperty({ description: 'Balance after this sync.' })
  @Column({ name: 'new_balance', type: 'real' })
  newBalance!: number;

  @ApiProperty({
    description:
      'What triggered this sync. E.g. "scheduler", "request:uuid", "webhook", "manual".',
  })
  @Column({ name: 'triggered_by', type: 'varchar' })
  triggeredBy!: string;

  @ApiProperty()
  @Column({ name: 'success', type: 'boolean' })
  success!: boolean;

  @ApiProperty({ nullable: true })
  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage?: string | null;

  @ApiProperty()
  @CreateDateColumn({ name: 'synced_at' })
  syncedAt!: Date;
}
