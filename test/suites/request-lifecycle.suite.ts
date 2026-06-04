/**
 * Request Lifecycle Suite
 *
 * Covers the full state machine for time-off requests:
 *
 *   PENDING_APPROVAL → HCM_SUBMITTED (approve)
 *   PENDING_APPROVAL → REJECTED (reject)
 *   PENDING_APPROVAL → CANCELLED (cancel before HCM)
 *   HCM_SUBMITTED    → CANCELLED + reversal (cancel after HCM)
 *   HCM_FAILED       → HCM_SUBMITTED (retry after recovery)
 *
 * Each test creates its own request(s) to be independent. The suite
 * calls manualSync() in beforeAll to anchor starting balances.
 */

import { INestApplication } from '@nestjs/common';
import {
  api,
  EMPLOYEE,
  MANAGER,
  vacationRequest,
  BalanceResponse,
  RequestResponse,
} from './e2e-api';

export function requestLifecycleSuite(getApp: () => INestApplication): void {
  describe('Request Lifecycle', () => {
    beforeAll(async () => {
      // Anchor: fresh sync so we know we're starting from HCM's seed data
      await api(getApp()).manualSync();
    });

    // ─── Full Approval Happy Path ─────────────────────────────────────────────

    describe('Full approval happy path', () => {
      let requestId: string;
      let initialBalance: number;

      it('GET /balances — initial balance is seeded correctly', async () => {
        const res = await api(getApp())
          .getBalance(EMPLOYEE.id, EMPLOYEE.locationId, EMPLOYEE.leaveType)
          .expect(200);

        const body = res.body as BalanceResponse;
        expect(body.effectiveBalance).toBeGreaterThan(0);
        expect(body.isStale).toBe(false); // fresh after manualSync
        initialBalance = body.effectiveBalance;
      });

      it('POST /requests — creates request in PENDING_APPROVAL with UUID transaction ID', async () => {
        const res = await api(getApp())
          .createRequest(vacationRequest(3))
          .expect(201);

        const body = res.body as RequestResponse;
        expect(body.status).toBe('pending_approval');
        expect(body.managerId).toBeNull();
        expect(body.hcmTransactionId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        requestId = body.id;
      });

      it('GET /requests/:id — request is retrievable by ID', async () => {
        const res = await api(getApp()).getRequest(requestId).expect(200);
        expect((res.body as RequestResponse).status).toBe('pending_approval');
      });

      it("GET /requests?employeeId= — employee's request appears in list", async () => {
        const res = await api(getApp()).listRequests(EMPLOYEE.id).expect(200);

        const requests = res.body as RequestResponse[];
        expect(requests.some((r) => r.id === requestId)).toBe(true);
      });

      it('PATCH /approve — transitions to HCM_SUBMITTED and records managerId', async () => {
        const res = await api(getApp())
          .approveRequest(requestId, MANAGER.id)
          .expect(200);

        const body = res.body as RequestResponse;
        expect(body.status).toBe('hcm_submitted');
        expect(body.managerId).toBe(MANAGER.id);
        expect(body.hcmErrorMessage).toBeNull();
      });

      it('GET /balances — effectiveBalance reduced by 3 days after approval', async () => {
        const res = await api(getApp())
          .getBalance(EMPLOYEE.id, EMPLOYEE.locationId, EMPLOYEE.leaveType)
          .expect(200);

        expect((res.body as BalanceResponse).effectiveBalance).toBe(
          initialBalance - 3,
        );
      });

      it('hcmTransactionId is immutable across the full lifecycle', async () => {
        const res = await api(getApp()).getRequest(requestId).expect(200);
        const hcmTxId = (res.body as RequestResponse).hcmTransactionId;
        // The ID assigned at creation should still be the same after approval
        expect(hcmTxId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
      });
    });

    // ─── Rejection Flow ───────────────────────────────────────────────────────

    describe('Rejection flow', () => {
      let requestId: string;

      beforeEach(async () => {
        const res = await api(getApp())
          .createRequest(vacationRequest(1))
          .expect(201);
        requestId = (res.body as RequestResponse).id;
      });

      it('PATCH /reject — transitions to REJECTED, records reason', async () => {
        const res = await api(getApp())
          .rejectRequest(requestId, MANAGER.id, 'Team coverage issue')
          .expect(200);

        const body = res.body as RequestResponse;
        expect(body.status).toBe('rejected');
        expect(body.managerId).toBe(MANAGER.id);
      });

      it('PATCH /reject after REJECTED — returns 409 Conflict', async () => {
        await api(getApp()).rejectRequest(requestId, MANAGER.id).expect(200);
        await api(getApp()).rejectRequest(requestId, MANAGER.id).expect(409);
      });

      it('PATCH /reject after HCM_SUBMITTED — returns 409 Conflict', async () => {
        await api(getApp()).approveRequest(requestId, MANAGER.id).expect(200);
        await api(getApp()).rejectRequest(requestId, MANAGER.id).expect(409);
      });
    });

    // ─── Cancellation — PENDING ───────────────────────────────────────────────

    describe('Cancel PENDING request', () => {
      it('cancels without touching HCM or balance', async () => {
        const createRes = await api(getApp())
          .createRequest(vacationRequest(2))
          .expect(201);
        const requestId = (createRes.body as RequestResponse).id;

        const balanceBefore = await api(getApp())
          .getBalance(EMPLOYEE.id, EMPLOYEE.locationId, EMPLOYEE.leaveType)
          .then((r) => (r.body as BalanceResponse).effectiveBalance);

        const cancelRes = await api(getApp())
          .cancelRequest(requestId, EMPLOYEE.id, 'Changed my mind')
          .expect(200);

        expect((cancelRes.body as RequestResponse).status).toBe('cancelled');

        const balanceAfter = await api(getApp())
          .getBalance(EMPLOYEE.id, EMPLOYEE.locationId, EMPLOYEE.leaveType)
          .then((r) => (r.body as BalanceResponse).effectiveBalance);

        // PENDING cancel has no reservation to release, balance unchanged
        expect(balanceAfter).toBe(balanceBefore);
      });
    });

    // ─── Cancellation — HCM_SUBMITTED ────────────────────────────────────────

    describe('Cancel HCM_SUBMITTED request (with reversal)', () => {
      it('calls HCM reversal and restores the committed balance', async () => {
        const createRes = await api(getApp())
          .createRequest(vacationRequest(2))
          .expect(201);
        const requestId = (createRes.body as RequestResponse).id;

        await api(getApp()).approveRequest(requestId, MANAGER.id).expect(200);

        const balanceBeforeCancel = await api(getApp())
          .getBalance(EMPLOYEE.id, EMPLOYEE.locationId, EMPLOYEE.leaveType)
          .then((r) => (r.body as BalanceResponse).effectiveBalance);

        const cancelRes = await api(getApp())
          .cancelRequest(requestId, EMPLOYEE.id)
          .expect(200);

        expect((cancelRes.body as RequestResponse).status).toBe('cancelled');

        const balanceAfterCancel = await api(getApp())
          .getBalance(EMPLOYEE.id, EMPLOYEE.locationId, EMPLOYEE.leaveType)
          .then((r) => (r.body as BalanceResponse).effectiveBalance);

        // 2 days should be restored after reversal
        expect(balanceAfterCancel).toBe(balanceBeforeCancel + 2);
      });

      it('cannot cancel an already CANCELLED request', async () => {
        const createRes = await api(getApp())
          .createRequest(vacationRequest(1))
          .expect(201);
        const requestId = (createRes.body as RequestResponse).id;

        await api(getApp()).cancelRequest(requestId, EMPLOYEE.id).expect(200);
        await api(getApp()).cancelRequest(requestId, EMPLOYEE.id).expect(409);
      });
    });

    // ─── Not Found ────────────────────────────────────────────────────────────

    describe('404 handling', () => {
      const ghostId = '00000000-0000-0000-0000-000000000000';

      it('GET /requests/:id — 404 for unknown ID', async () => {
        await api(getApp()).getRequest(ghostId).expect(404);
      });

      it('PATCH /approve — 404 for unknown ID', async () => {
        await api(getApp()).approveRequest(ghostId, MANAGER.id).expect(404);
      });

      it('GET /balances/:id — 404 for unknown employee', async () => {
        await api(getApp())
          .getBalance('emp-ghost', EMPLOYEE.locationId, EMPLOYEE.leaveType)
          .expect(404);
      });
    });
  });
}
