/**
 * Error Message Constants — Time-Off Microservice
 *
 * All user-facing error message strings live here, organized by module.
 * Internal/technical errors (DbError, OptimisticLockError) are NOT here.
 *
 * Pattern mirrors Allia's shared/constants/error-messages.const.ts:
 * - Grouped by module as `as const` objects
 * - Dynamic messages are functions, not template literals inlined elsewhere
 * - Import the specific group you need, don't import the whole file
 */

// ============================================================================
// TIME-OFF REQUEST ERRORS
// ============================================================================

export const TIME_OFF_REQUEST_ERRORS = {
  // Not Found
  REQUEST_NOT_FOUND: 'Time-off request not found',

  // State Machine Violations
  CANNOT_APPROVE_NOT_PENDING: 'Only pending requests can be approved',
  CANNOT_REJECT_NOT_PENDING: 'Only pending requests can be rejected',
  CANNOT_CANCEL_TERMINAL:
    'This request is already completed or cancelled and cannot be modified',
  CANNOT_RETRY_NOT_FAILED: 'Only failed HCM submissions can be retried',

  // Authorization
  NOT_YOUR_REQUEST: 'You are not authorized to modify this request',
  NOT_THE_MANAGER:
    'Only the assigned manager can approve or reject this request',

  // Date Validation
  END_BEFORE_START: 'End date must be on or after start date',
  START_DATE_IN_PAST: 'Start date cannot be in the past',
  ZERO_DAYS_REQUESTED: 'Requested period results in zero working days',

  // Dynamic
  REQUEST_NOT_FOUND_FOR_ID: (id: string) => `Time-off request ${id} not found`,
} as const;

// ============================================================================
// BALANCE ERRORS
// ============================================================================

export const BALANCE_ERRORS = {
  // Not Found
  BALANCE_NOT_FOUND: 'No balance record found for this employee and leave type',
  BALANCE_NOT_FOUND_FOR_DIMENSIONS: (
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
  ) =>
    `No balance found for employee ${employeeId} at location ${locationId} for leave type ${leaveTypeId}`,

  // Insufficient Balance
  INSUFFICIENT_BALANCE: 'Insufficient leave balance for this request',
  INSUFFICIENT_BALANCE_DETAIL: (requested: number, available: number) =>
    `Requested ${requested} day(s) but only ${available} day(s) are available`,

  // Balance Integrity
  NEGATIVE_BALANCE_BLOCKED:
    'Request blocked: approving this would result in a negative balance. Pre-flight check failed.',
  POST_SUBMISSION_MISMATCH:
    'HCM acknowledged the deduction but the resulting balance does not match expectations. Request flagged for audit.',
} as const;

// ============================================================================
// HCM SYNC ERRORS
// ============================================================================

export const HCM_ERRORS = {
  // Availability
  HCM_UNAVAILABLE: 'HCM is temporarily unavailable. Please try again shortly.',
  HCM_TIMEOUT:
    'HCM did not respond in time. The request will be retried automatically.',

  // Submission Failures
  HCM_REJECTED_DEDUCTION:
    'HCM rejected the leave deduction. Please check the balance and try again.',
  HCM_INVALID_DIMENSIONS:
    'HCM does not recognise this combination of employee, location, and leave type.',

  // Sync Failures
  BATCH_SYNC_FAILED:
    'Batch sync from HCM failed. Balances may be stale — retrying on the next schedule cycle.',
  REALTIME_SYNC_FAILED:
    'Real-time balance refresh failed. Cached balance shown — may not be current.',
} as const;

// ============================================================================
// GENERAL VALIDATION ERRORS
// ============================================================================

export const VALIDATION_ERRORS = {
  EMPLOYEE_ID_REQUIRED: 'Employee ID is required',
  LOCATION_ID_REQUIRED: 'Location ID is required',
  LEAVE_TYPE_ID_REQUIRED: 'Leave type ID is required',
  START_DATE_REQUIRED: 'Start date is required (YYYY-MM-DD)',
  END_DATE_REQUIRED: 'End date is required (YYYY-MM-DD)',
  INVALID_DATE_FORMAT: (field: string) =>
    `${field} must be a valid date in YYYY-MM-DD format`,
  MANAGER_ID_REQUIRED: 'Manager ID is required',
} as const;

// Convenience re-export — used by tests that import from a single location
export const ERROR_MESSAGES = {
  ...TIME_OFF_REQUEST_ERRORS,
  ...BALANCE_ERRORS,
  ...HCM_ERRORS,
  ...VALIDATION_ERRORS,
} as const;
