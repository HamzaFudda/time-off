/**
 * Shared API helpers for all E2E suites.
 *
 * All endpoint calls go through these typed helpers — no raw supertest strings
 * scattered across test files. If a route changes, update here once.
 */

import { INestApplication } from '@nestjs/common';
import supertest from 'supertest';

// ─── Response Types ────────────────────────────────────────────────────────────

export interface BalanceResponse {
  balance: {
    id: string;
    employeeId: string;
    locationId: string;
    leaveTypeId: string;
    availableDays: number;
    reservedDays: number;
    lastSyncedAt: string | null;
  };
  effectiveBalance: number;
  isStale: boolean;
}

export interface RequestResponse {
  id: string;
  employeeId: string;
  locationId: string;
  leaveTypeId: string;
  numberOfDays: number;
  status: string;
  hcmTransactionId: string;
  hcmErrorMessage: string | null;
  managerId: string | null;
  startDate: string;
  endDate: string;
  createdAt: string;
}

export interface SyncResult {
  updated: number;
  failed: number;
}

// ─── Time-Off Service API ───────────────────────────────────────────────────────

export function api(app: INestApplication) {
  const agent = supertest(app.getHttpServer());

  return {
    manualSync: () => agent.post('/sync/manual').expect(200),

    webhookSync: (source?: string) =>
      agent.post('/sync/webhook/hcm-batch').send(source ? { source } : {}),

    getBalance: (employeeId: string, locationId: string, leaveTypeId: string) =>
      agent.get(
        `/time-off/balances/${employeeId}?locationId=${locationId}&leaveTypeId=${leaveTypeId}`,
      ),

    createRequest: (body: {
      employeeId: string;
      locationId: string;
      leaveTypeId: string;
      startDate: string;
      endDate: string;
      numberOfDays: number;
    }) => agent.post('/time-off/requests').send(body),

    getRequest: (id: string) => agent.get(`/time-off/requests/${id}`),

    listRequests: (employeeId?: string) =>
      agent.get('/time-off/requests').query(employeeId ? { employeeId } : {}),

    approveRequest: (id: string, managerId: string) =>
      agent.patch(`/time-off/requests/${id}/approve`).send({ managerId }),

    rejectRequest: (id: string, managerId: string, reason?: string) =>
      agent
        .patch(`/time-off/requests/${id}/reject`)
        .send({ managerId, ...(reason && { reason }) }),

    cancelRequest: (id: string, employeeId: string, reason?: string) =>
      agent
        .patch(`/time-off/requests/${id}/cancel`)
        .send({ employeeId, ...(reason && { reason }) }),

    retryRequest: (id: string) => agent.patch(`/time-off/requests/${id}/retry`),
  };
}

// ─── HCM Mock Admin API ─────────────────────────────────────────────────────────

export function hcmAdminApi(app: INestApplication) {
  const agent = supertest(app.getHttpServer());

  return {
    mutateBalance: (body: {
      employeeId: string;
      locationId: string;
      leaveTypeId: string;
      newAvailableDays: number;
      reason: string;
    }) => agent.patch('/admin/balances').send(body),

    getMutationLog: () => agent.get('/admin/mutation-log'),

    setChaosMode: (enabled: boolean, failureProbability = 0.5) =>
      agent.post('/admin/chaos').send({ enabled, failureProbability }),
  };
}

// ─── Common Fixtures ───────────────────────────────────────────────────────────

export const EMPLOYEE = {
  id: 'emp-123',
  locationId: 'loc-us',
  leaveType: 'VACATION',
} as const;

export const MANAGER = { id: 'mgr-999' } as const;

/**
 * Build a vacation request payload for N days starting 2026-12-01.
 * For the E2E dates, we always use future dates to avoid any potential
 * past-date validation guards.
 */
export function vacationRequest(days: number) {
  const start = '2026-12-01';
  // For simplicity, end date = start + (days-1) days. Actual working days
  // are in numberOfDays which is what the service cares about.
  const endDate = new Date('2026-12-01');
  endDate.setDate(endDate.getDate() + days - 1);
  const end = endDate.toISOString().split('T')[0];

  return {
    employeeId: EMPLOYEE.id,
    locationId: EMPLOYEE.locationId,
    leaveTypeId: EMPLOYEE.leaveType,
    startDate: start,
    endDate: end,
    numberOfDays: days,
  };
}
