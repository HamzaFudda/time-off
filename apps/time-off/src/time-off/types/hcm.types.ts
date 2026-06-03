/**
 * HCM-related internal types used by HcmClientService and BalanceService.
 * These are TypeScript interface shapes — not enums, not entities.
 * Pattern: types are things the database doesn't know about; runtime shapes.
 */

export interface HcmBalanceResponse {
  employeeId: string;
  locationId: string;
  leaveTypeId: string;
  availableDays: number;
  asOfDate: string; // ISO date string from HCM
}

export interface HcmDeductionRequest {
  transactionId: string; // idempotency key
  employeeId: string;
  locationId: string;
  leaveTypeId: string;
  days: number;
}

export interface HcmDeductionResponse {
  transactionId: string;
  success: boolean;
  remainingBalance: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface HcmBatchBalanceItem {
  employeeId: string;
  locationId: string;
  leaveTypeId: string;
  availableDays: number;
}

export interface HcmBatchResponse {
  balances: HcmBatchBalanceItem[];
  generatedAt: string; // ISO datetime from HCM
}
