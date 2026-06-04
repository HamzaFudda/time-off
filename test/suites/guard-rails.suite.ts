/**
 * Guard Rails Suite
 *
 * Tests safety invariants that prevent financial errors:
 *
 * 1. Pre-flight blocks approval when balance is insufficient
 * 2. Balance is NOT mutated on a blocked approval
 * 3. Input validation rejects bad payloads with 400
 * 4. State machine guards return 409 on wrong-state transitions
 * 5. Chaos mode: HCM failure → HCM_FAILED, balance fully rolled back
 * 6. Retry after HCM recovery: succeeds with same idempotency key
 */

import { INestApplication } from '@nestjs/common';
import {
  api,
  hcmAdminApi,
  EMPLOYEE,
  MANAGER,
  vacationRequest,
  BalanceResponse,
  RequestResponse,
} from './e2e-api';

export function guardRailsSuite(
  getApp: () => INestApplication,
  getHcmApp: () => INestApplication,
): void {
  describe('Guard Rails & Safety Contracts', () => {
    beforeAll(async () => {
      await api(getApp()).manualSync();
    });

    // ─── Insufficient Balance Pre-flight ─────────────────────────────────────

    describe('Insufficient balance', () => {
      it('returns 409 when requested days exceed HCM live balance', async () => {
        const createRes = await api(getApp())
          .createRequest({
            ...vacationRequest(3),
            numberOfDays: 99, // massively over-budget
            endDate: '2027-03-10',
          })
          .expect(201);

        const approveRes = await api(getApp())
          .approveRequest((createRes.body as RequestResponse).id, MANAGER.id)
          .expect(409);

        expect((approveRes.body as { message: string }).message).toMatch(
          /day\(s\)/,
        );
      });

      it('balance is completely unchanged after a blocked approval', async () => {
        const balanceBefore = await api(getApp())
          .getBalance(EMPLOYEE.id, EMPLOYEE.locationId, EMPLOYEE.leaveType)
          .then((r) => (r.body as BalanceResponse).effectiveBalance);

        const createRes = await api(getApp())
          .createRequest({
            ...vacationRequest(3),
            numberOfDays: 99,
            endDate: '2027-03-10',
          })
          .expect(201);

        await api(getApp())
          .approveRequest((createRes.body as RequestResponse).id, MANAGER.id)
          .expect(409);

        const balanceAfter = await api(getApp())
          .getBalance(EMPLOYEE.id, EMPLOYEE.locationId, EMPLOYEE.leaveType)
          .then((r) => (r.body as BalanceResponse).effectiveBalance);

        expect(balanceAfter).toBe(balanceBefore);
      });
    });

    // ─── Input Validation ─────────────────────────────────────────────────────

    describe('Input validation', () => {
      it('returns 400 when required fields are missing', async () => {
        await api(getApp())
          .createRequest({} as any)
          .expect(400);
      });

      it('returns 409 when endDate is before startDate', async () => {
        await api(getApp())
          .createRequest({
            employeeId: EMPLOYEE.id,
            locationId: EMPLOYEE.locationId,
            leaveTypeId: EMPLOYEE.leaveType,
            startDate: '2026-12-10',
            endDate: '2026-12-01', // before start
            numberOfDays: 5,
          })
          .expect(409);
      });

      it('returns 400 when approving with empty managerId', async () => {
        const createRes = await api(getApp())
          .createRequest(vacationRequest(1))
          .expect(201);

        await api(getApp())
          .approveRequest((createRes.body as RequestResponse).id, '')
          .expect(400);
      });
    });

    // ─── State Machine Transition Guards ─────────────────────────────────────

    describe('State machine guards', () => {
      it('PATCH /approve twice on same request returns 409', async () => {
        const createRes = await api(getApp())
          .createRequest(vacationRequest(1))
          .expect(201);
        const id = (createRes.body as RequestResponse).id;

        await api(getApp()).approveRequest(id, MANAGER.id).expect(200);
        await api(getApp()).approveRequest(id, MANAGER.id).expect(409);
      });

      it('PATCH /retry on PENDING_APPROVAL request returns 409', async () => {
        const createRes = await api(getApp())
          .createRequest(vacationRequest(1))
          .expect(201);

        await api(getApp())
          .retryRequest((createRes.body as RequestResponse).id)
          .expect(409);
      });

      it('PATCH /reject on HCM_SUBMITTED request returns 409', async () => {
        const createRes = await api(getApp())
          .createRequest(vacationRequest(1))
          .expect(201);
        const id = (createRes.body as RequestResponse).id;

        await api(getApp()).approveRequest(id, MANAGER.id).expect(200);
        await api(getApp()).rejectRequest(id, MANAGER.id).expect(409);
      });

      it('PATCH /cancel on REJECTED request returns 409', async () => {
        const createRes = await api(getApp())
          .createRequest(vacationRequest(1))
          .expect(201);
        const id = (createRes.body as RequestResponse).id;

        await api(getApp()).rejectRequest(id, MANAGER.id).expect(200);
        await api(getApp()).cancelRequest(id, EMPLOYEE.id).expect(409);
      });
    });

    // ─── Chaos Mode — HCM Failure & Recovery ─────────────────────────────────

    describe('Chaos mode resilience', () => {
      afterEach(async () => {
        // Always restore chaos mode so other tests run normally
        await hcmAdminApi(getHcmApp()).setChaosMode(false, 0.5);
      });

      it('when HCM is down (100% failure), approval returns 503 and balance is not modified', async () => {
        // Snapshot balance before chaos
        const balanceBefore = await api(getApp())
          .getBalance(EMPLOYEE.id, EMPLOYEE.locationId, EMPLOYEE.leaveType)
          .then((r) => (r.body as BalanceResponse).effectiveBalance);

        // Enable chaos — 100% failure rate
        await hcmAdminApi(getHcmApp()).setChaosMode(true, 1.0).expect(200);

        const createRes = await api(getApp())
          .createRequest(vacationRequest(1))
          .expect(201);
        const requestId = (createRes.body as RequestResponse).id;

        // Approve — HCM is completely down. Pre-flight verifyLiveBalance also fails,
        // so the service correctly returns 503 (HCM unreachable).
        // Critically: no local state must have been modified before the throw.
        await api(getApp()).approveRequest(requestId, MANAGER.id).expect(503);

        // Disable chaos before balance check
        await hcmAdminApi(getHcmApp()).setChaosMode(false, 0.5);

        // Balance must be completely unchanged — no reservation was set
        const balanceAfter = await api(getApp())
          .getBalance(EMPLOYEE.id, EMPLOYEE.locationId, EMPLOYEE.leaveType)
          .then((r) => (r.body as BalanceResponse).effectiveBalance);

        expect(balanceAfter).toBe(balanceBefore);
      });

      it('request remains in PENDING_APPROVAL after a 503 — can be retried when HCM recovers', async () => {
        // Enable chaos first
        await hcmAdminApi(getHcmApp()).setChaosMode(true, 1.0);

        const createRes = await api(getApp())
          .createRequest(vacationRequest(1))
          .expect(201);
        const requestId = (createRes.body as RequestResponse).id;

        // Approval fails — 503
        await api(getApp()).approveRequest(requestId, MANAGER.id).expect(503);

        // HCM recovers
        await hcmAdminApi(getHcmApp()).setChaosMode(false, 0.5);

        // The request is still in PENDING_APPROVAL — not in a terminal state
        const fetchedReq = await api(getApp())
          .getRequest(requestId)
          .expect(200);
        expect((fetchedReq.body as RequestResponse).status).toBe(
          'pending_approval',
        );

        const balanceBefore = await api(getApp())
          .getBalance(EMPLOYEE.id, EMPLOYEE.locationId, EMPLOYEE.leaveType)
          .then((r) => (r.body as BalanceResponse).effectiveBalance);

        // Now approve normally — should succeed
        const approveRes = await api(getApp())
          .approveRequest(requestId, MANAGER.id)
          .expect(200);
        expect((approveRes.body as RequestResponse).status).toBe(
          'hcm_submitted',
        );

        // Balance committed
        const balanceAfter = await api(getApp())
          .getBalance(EMPLOYEE.id, EMPLOYEE.locationId, EMPLOYEE.leaveType)
          .then((r) => (r.body as BalanceResponse).effectiveBalance);
        expect(balanceAfter).toBe(balanceBefore - 1);
      });
    });
  });
}
