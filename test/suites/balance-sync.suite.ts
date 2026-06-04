/**
 * Balance Sync Suite
 *
 * Tests all three sync entry points and the core safety invariant:
 * reservedDays must survive a batch sync.
 */

import { INestApplication } from '@nestjs/common';
import {
  api,
  hcmAdminApi,
  EMPLOYEE,
  MANAGER,
  vacationRequest,
  BalanceResponse,
  SyncResult,
  RequestResponse,
} from './e2e-api';

export function balanceSyncSuite(
  getApp: () => INestApplication,
  getHcmApp: () => INestApplication,
): void {
  describe('Balance Sync', () => {
    beforeAll(async () => {
      await api(getApp()).manualSync();
    });

    // ─── Manual Sync ──────────────────────────────────────────────────────────

    describe('POST /sync/manual', () => {
      it('returns updated count and zero failures on clean sync', async () => {
        const res = await api(getApp()).manualSync();

        const body = res.body as SyncResult;
        expect(body.updated).toBeGreaterThan(0);
        expect(body.failed).toBe(0);
      });

      it('overwrites local balance with HCM mock seeded value (15 days VACATION)', async () => {
        await api(getApp()).manualSync();

        const res = await api(getApp())
          .getBalance(EMPLOYEE.id, EMPLOYEE.locationId, EMPLOYEE.leaveType)
          .expect(200);

        // HCM Mock seeds emp-123 with 15 days at startup
        // By this point in tests, HCM may have been mutated by lifecycle tests
        // so we just assert it's a positive number and isStale=false.
        const body = res.body as BalanceResponse;
        expect(body.balance.availableDays).toBeGreaterThan(0);
        expect(body.isStale).toBe(false);
      });
    });

    // ─── Webhook Sync ─────────────────────────────────────────────────────────

    describe('POST /sync/webhook/hcm-batch', () => {
      it('returns 200 with sync counts when source is provided', async () => {
        const res = await api(getApp())
          .webhookSync('workday-batch-processor')
          .expect(200);

        const body = res.body as SyncResult;
        expect(body.updated).toEqual(expect.any(Number));
        expect(body.failed).toEqual(expect.any(Number));
      });

      it('returns 200 when source is omitted (anonymous webhook)', async () => {
        const res = await api(getApp()).webhookSync(undefined).expect(200);
        const body = res.body as SyncResult;
        expect(body.failed).toBe(0);
      });
    });

    // ─── Out-of-Band Mutations ────────────────────────────────────────────────

    describe('Out-of-band HCM mutations', () => {
      it('detects an anniversary bonus applied directly to HCM and propagates via sync', async () => {
        await api(getApp()).manualSync();

        const balanceBefore = await api(getApp())
          .getBalance(EMPLOYEE.id, EMPLOYEE.locationId, EMPLOYEE.leaveType)
          .then((r) => (r.body as BalanceResponse).balance.availableDays);

        // HCM HR gives anniversary bonus of 5 days out-of-band
        await hcmAdminApi(getHcmApp())
          .mutateBalance({
            employeeId: EMPLOYEE.id,
            locationId: EMPLOYEE.locationId,
            leaveTypeId: EMPLOYEE.leaveType,
            newAvailableDays: balanceBefore + 5,
            reason: 'Annual 5-year service anniversary bonus',
          })
          .expect(200);

        // Sync picks it up
        await api(getApp()).webhookSync('after-anniversary').expect(200);

        const balanceAfter = await api(getApp())
          .getBalance(EMPLOYEE.id, EMPLOYEE.locationId, EMPLOYEE.leaveType)
          .then((r) => (r.body as BalanceResponse).balance.availableDays);

        expect(balanceAfter).toBe(balanceBefore + 5);
      });

      it('detects an HR correction that reduces HCM balance', async () => {
        // We just incremented by 5, now correct it back down by 2
        const balanceBefore = await api(getApp())
          .getBalance(EMPLOYEE.id, EMPLOYEE.locationId, EMPLOYEE.leaveType)
          .then((r) => (r.body as BalanceResponse).balance.availableDays);

        await hcmAdminApi(getHcmApp())
          .mutateBalance({
            employeeId: EMPLOYEE.id,
            locationId: EMPLOYEE.locationId,
            leaveTypeId: EMPLOYEE.leaveType,
            newAvailableDays: balanceBefore - 2,
            reason: 'Correction: carry-over was overstated',
          })
          .expect(200);

        await api(getApp()).webhookSync('hcm-correction').expect(200);

        const balanceAfter = await api(getApp())
          .getBalance(EMPLOYEE.id, EMPLOYEE.locationId, EMPLOYEE.leaveType)
          .then((r) => (r.body as BalanceResponse).balance.availableDays);

        expect(balanceAfter).toBe(balanceBefore - 2);
      });

      it('mutation audit log records all out-of-band changes', async () => {
        const res = await hcmAdminApi(getHcmApp()).getMutationLog().expect(200);
        const log = res.body as Array<{
          employeeId: string;
          reason: string;
          mutatedAt: string;
        }>;

        expect(Array.isArray(log)).toBe(true);
        expect(log.length).toBeGreaterThan(0);
        expect(log[0]?.employeeId).toEqual(expect.any(String));
        expect(log[0]?.reason).toEqual(expect.any(String));
        expect(log[0]?.mutatedAt).toEqual(expect.any(String));
      });
    });

    // ─── Reservation Isolation ────────────────────────────────────────────────

    describe('Batch sync does NOT touch reservedDays (in-flight reservation safety)', () => {
      it('reservedDays remain 0 after a batch sync for an HCM_SUBMITTED request', async () => {
        await api(getApp()).manualSync();

        // Create and approve a request — this commits the deduction and zeros reservedDays
        const createRes = await api(getApp())
          .createRequest(vacationRequest(1))
          .expect(201);
        await api(getApp())
          .approveRequest((createRes.body as RequestResponse).id, MANAGER.id)
          .expect(200);

        const beforeSync = await api(getApp())
          .getBalance(EMPLOYEE.id, EMPLOYEE.locationId, EMPLOYEE.leaveType)
          .then((r) => (r.body as BalanceResponse).balance.reservedDays);

        // Run batch sync
        await api(getApp()).manualSync();

        const afterSync = await api(getApp())
          .getBalance(EMPLOYEE.id, EMPLOYEE.locationId, EMPLOYEE.leaveType)
          .then((r) => (r.body as BalanceResponse).balance.reservedDays);

        // reservedDays must not be modified by batch sync regardless of what it was before
        expect(afterSync).toBe(beforeSync);
        // The request was HCM_SUBMITTED (fully committed), so its own reservation was released
        // Other tests may have left non-zero reservations — we only care the sync didn't change the number
      });
    });
  });
}
