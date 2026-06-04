import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule as TimeOffAppModule } from '../apps/time-off/src/app.module';
import { AppModule as HcmMockAppModule } from '../apps/hcm-mock/src/app.module';

describe('Time-Off E2E Flow', () => {
  let timeOffApp: INestApplication;
  let hcmMockApp: INestApplication;

  beforeAll(async () => {
    // 1. Boot the HCM Mock Server on port 3001 (TimeOff expects it here by default)
    const mockModule: TestingModule = await Test.createTestingModule({
      imports: [HcmMockAppModule],
    }).compile();

    hcmMockApp = mockModule.createNestApplication();
    await hcmMockApp.listen(3001);

    // 2. Boot the Time-Off Service
    process.env.HCM_BASE_URL = 'http://localhost:3001';

    const timeOffModule: TestingModule = await Test.createTestingModule({
      imports: [TimeOffAppModule],
    }).compile();

    timeOffApp = timeOffModule.createNestApplication();
    await timeOffApp.init();
  });

  afterAll(async () => {
    await timeOffApp.close();
    await hcmMockApp.close();
  });

  it('should process a full time-off request lifecycle end-to-end', async () => {
    // 0. Seed local DB with batch data from HCM mock
    await request(timeOffApp.getHttpServer()).post('/sync/manual').expect(200);

    // 1. Check initial balance (emp-123, loc-us, VACATION)
    // The mock starts with 15 available days.
    const initialBalanceRes = await request(timeOffApp.getHttpServer())
      .get('/time-off/balances/emp-123?locationId=loc-us&leaveTypeId=VACATION')
      .expect(200);

    expect(initialBalanceRes.body.effectiveBalance).toBe(15);
    expect(initialBalanceRes.body.isStale).toBe(false); // fresh because we just seeded it

    // 2. Create a time-off request for 3 days
    const createRes = await request(timeOffApp.getHttpServer())
      .post('/time-off/requests')
      .send({
        employeeId: 'emp-123',
        locationId: 'loc-us',
        leaveTypeId: 'VACATION',
        startDate: '2026-12-01',
        endDate: '2026-12-03',
        numberOfDays: 3,
      })
      .expect(201);

    const requestId = createRes.body.id;
    expect(createRes.body.status).toBe('pending_approval');

    // 3. Approve the request
    // This will trigger verifyLiveBalance -> reserveDays -> HCM /deductions -> commitDeduction
    await request(timeOffApp.getHttpServer())
      .patch(`/time-off/requests/${requestId}/approve`)
      .send({ managerId: 'mgr-999' })
      .expect(200);

    // 4. Verify request status is HCM_SUBMITTED
    const verifyReqRes = await request(timeOffApp.getHttpServer())
      .get(`/time-off/requests/${requestId}`)
      .expect(200);

    expect(verifyReqRes.body.status).toBe('hcm_submitted');

    // 5. Check new balance locally (should be 12)
    const finalBalanceRes = await request(timeOffApp.getHttpServer())
      .get('/time-off/balances/emp-123?locationId=loc-us&leaveTypeId=VACATION')
      .expect(200);

    expect(finalBalanceRes.body.effectiveBalance).toBe(12);
  });

  it('should block approval if HCM has insufficient balance', async () => {
    // 1. Create a massive request (50 days)
    const createRes = await request(timeOffApp.getHttpServer())
      .post('/time-off/requests')
      .send({
        employeeId: 'emp-123',
        locationId: 'loc-us',
        leaveTypeId: 'VACATION',
        startDate: '2026-12-01',
        endDate: '2027-01-20',
        numberOfDays: 50,
      })
      .expect(201);

    const requestId = createRes.body.id;

    // 2. Attempt to approve
    // Should fail pre-flight check and return 409 Conflict
    const approveRes = await request(timeOffApp.getHttpServer())
      .patch(`/time-off/requests/${requestId}/approve`)
      .send({ managerId: 'mgr-999' })
      .expect(409);

    expect(approveRes.body.message).toContain('are available');
  });

  it('should sync out-of-band updates via webhook', async () => {
    // 1. Manually mutate the mock HCM state directly using the chaos/admin route (if we added a mutate route).
    // Actually, we can just run the webhook batch sync to pull data from HCM.
    // The HCM state is currently 12 days for VACATION.
    const syncRes = await request(timeOffApp.getHttpServer())
      .post('/sync/webhook/hcm-batch')
      .send({ source: 'e2e-test' })
      .expect(200);

    // It should have synced the balances
    expect(syncRes.body.updated).toBeGreaterThan(0);
  });
});
