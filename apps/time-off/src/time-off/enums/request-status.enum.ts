/**
 * RequestStatusEnum — drives the saga state machine for a time-off request.
 *
 * Valid transitions:
 *   DRAFT            → PENDING_APPROVAL  (employee submits)
 *   PENDING_APPROVAL → APPROVED          (manager approves)
 *   PENDING_APPROVAL → REJECTED          (manager rejects)
 *   APPROVED         → HCM_SUBMITTING    (approval triggers HCM call)
 *   HCM_SUBMITTING   → HCM_SUBMITTED     (HCM confirmed deduction)
 *   HCM_SUBMITTING   → HCM_FAILED        (HCM rejected or unreachable)
 *   HCM_FAILED       → HCM_SUBMITTING    (retry)
 *   HCM_SUBMITTED    → CANCELLED         (employee cancels; triggers HCM reversal)
 *   PENDING_APPROVAL → CANCELLED         (employee cancels before approval; no HCM call)
 *   APPROVED         → CANCELLED         (employee cancels before HCM submission; no HCM call)
 */
export enum RequestStatusEnum {
  DRAFT = 'draft',
  PENDING_APPROVAL = 'pending_approval',
  APPROVED = 'approved',
  HCM_SUBMITTING = 'hcm_submitting',
  HCM_SUBMITTED = 'hcm_submitted',
  HCM_FAILED = 'hcm_failed',
  CANCELLED = 'cancelled',
  REJECTED = 'rejected',
}
