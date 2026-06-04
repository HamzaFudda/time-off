/**
 * E2E Test Entry Point
 *
 * This is the SINGLE spec file that Jest discovers. It boots both apps once
 * in beforeAll, then runs all suites in sequence. The other *.e2e.ts files
 * export suite factory functions rather than running describe() at module level,
 * so they're always executed within the shared app context.
 *
 * Why a single entry point?
 * - NestJS apps take ~2-3s each to start. Running N spec files × 2 apps = N×5s.
 * - A single bootstrap gives us a flat ~5s overhead regardless of suite count.
 * - State that persists across suites (the SQLite in-memory DB) is expected:
 *   each suite seeds its own data and reads its own state.
 *
 * Test isolation strategy:
 * - The HCM Mock is in-memory and stateful. Each suite calls manualSync() in
 *   its beforeAll to reset local DB state to the HCM mock's seed data.
 * - The HCM Mock does NOT reset between suites — its balance mutations are
 *   cumulative. Tests that mutate HCM state note the original value, mutate,
 *   assert, and implicitly leave the mock in a new state. Subsequent suites
 *   call manualSync() to re-anchor to whatever HCM now has.
 * - Chaos mode is always turned off in afterEach/afterAll within the chaos tests.
 */

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule as HcmMockAppModule } from '../apps/hcm-mock/src/app.module';
import { AppModule as TimeOffAppModule } from '../apps/time-off/src/app.module';
import { requestLifecycleSuite } from './suites/request-lifecycle.suite';
import { balanceSyncSuite } from './suites/balance-sync.suite';
import { guardRailsSuite } from './suites/guard-rails.suite';

// ─── Bootstrap ─────────────────────────────────────────────────────────────────

let timeOffApp: INestApplication;
let hcmMockApp: INestApplication;

beforeAll(async () => {
  // 1. HCM Mock
  const mockModule: TestingModule = await Test.createTestingModule({
    imports: [HcmMockAppModule],
  }).compile();

  hcmMockApp = mockModule.createNestApplication();
  hcmMockApp.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  await hcmMockApp.listen(3001);

  // 2. Time-Off Service
  process.env.HCM_BASE_URL = 'http://localhost:3001';
  process.env.HCM_RETRY_BASE_DELAY_MS = '0'; // Fast retries in tests

  const timeOffModule: TestingModule = await Test.createTestingModule({
    imports: [TimeOffAppModule],
  }).compile();

  timeOffApp = timeOffModule.createNestApplication();
  timeOffApp.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  await timeOffApp.init();
}, 30_000);

afterAll(async () => {
  await timeOffApp?.close();
  await hcmMockApp?.close();
});

// ─── Suites ────────────────────────────────────────────────────────────────────

requestLifecycleSuite(() => timeOffApp);
balanceSyncSuite(
  () => timeOffApp,
  () => hcmMockApp,
);
guardRailsSuite(
  () => timeOffApp,
  () => hcmMockApp,
);
