import {
  CreateDateColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

/**
 * EntityBase — shared base for all entities.
 *
 * Provides: UUID primary key, createdAt, updatedAt, and an
 * optimistic lock `version` column (managed by TypeORM automatically).
 *
 * We use UUID PKs (vs. auto-increment integers) because:
 * 1. IDs are safe to expose in URLs without enumeration risk.
 * 2. Distributed systems can generate IDs without a DB round-trip.
 */
export class EntityBase {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt!: Date;

  /**
   * Optimistic lock counter. TypeORM auto-increments this on every UPDATE
   * and includes WHERE version = :version in update queries.
   * Concurrent writers race for the same row will get an
   * OptimisticLockVersionMismatchError — caller must retry with fresh data.
   */
  @VersionColumn()
  version!: number;

  constructor(entityBase?: Partial<EntityBase>) {
    if (entityBase) {
      Object.assign(this, entityBase);
    }
  }
}
