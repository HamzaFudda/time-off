```markdown
# Technical Requirements Document
## Time-Off Microservice — ExampleHR

---

## Table of Contents

1. [Background & Motivation](#1-background--motivation)
2. [The Core Problem](#2-the-core-problem)
3. [System Actors](#3-system-actors)
4. [Identified Problems & Analysis](#4-identified-problems--analysis)
5. [Proposed Architecture](#5-proposed-architecture)
6. [Data Model](#6-data-model)
7. [API Design](#7-api-design)
8. [Sync Strategy](#8-sync-strategy)
9. [Configuration Assumptions (Assessment Scope)](#9-configuration-assumptions-assessment-scope)
10. [Failure Modes & Mitigations](#10-failure-modes--mitigations)
11. [Alternatives Considered](#11-alternatives-considered)
12. [Non-Goals](#12-non-goals)
13. [Open Questions](#13-open-questions)

---

## 1. Background & Motivation

ExampleHR handles the UI for employees requesting time off, but the actual source of truth for their leave balance lives in an external Human Capital Management (HCM) system like Workday or SAP. 

At its core, this is a classic distributed data consistency problem. We have to give employees a fast, accurate view of their balances and let them request time off, while making sure the HCM—which we don't control and which will inevitably experience downtime—always stays perfectly in sync with our local state.

I've outlined the edge cases I've identified, the architecture I'm proposing to handle them, and the tradeoffs involved. Dual-write distributed systems fail in weird ways, and I want our failure states to be explicit engineering choices rather than accidents we discover in production.

---

## 2. The Core Problem

The main issue that puts us in a tight spot: **we are the user-facing app, but we don't own the source of truth.**

If we treat the HCM as the only database and make synchronous API calls for every click, the app will be slow, and whenever the HCM goes down, ExampleHR goes down with it. 

If we only trust our local database, we're going to end up serving stale data. The HCM can change an employee's balance at any time (e.g., HR manually fixing a record, or an automated work anniversary bonus) without notifying us. If an employee submits a request against a stale local balance, the HCM will reject it, or worse, put their balance in the negative.

Neither option works. The pragmatic approach is a **locally-cached, defensively-validated, HCM-reconciled** system. We keep a local database for fast reads and high availability, but any action that actually *commits* data (like a manager approving leave) requires hard confirmation from the HCM.

---

## 3. System Actors

| Actor | Description |
|---|---|
| **Employee** | Wants to see their real balance and get instant feedback on time-off requests. |
| **Manager** | Approves/rejects requests. Needs a guarantee the request is valid before clicking approve. |
| **HCM System** | The slow, external source of truth. Provides real-time and batch APIs. |
| **Sync Worker** | Background cron job pulling updates from the HCM batch endpoint. |
| **Time-Off Microservice** | The NestJS backend we are building to sit between the users and the HCM. |

---

## 4. Identified Problems & Analysis

External APIs drop requests, networks timeout, and race conditions happen. Here is how we're handling the specific failure modes.

### 4.1 The Stale Balance Problem

**The scenario:** An employee checks their balance. We show them a cached 10 days. Overnight, an HR script in the HCM corrected their balance to 4 days. The employee requests 8 days. Our system thinks it's fine, but the HCM rejects it. 

**The fix:** Every balance record in our SQLite DB has a `last_synced_at` timestamp. If a user hits the `GET /balances` endpoint and the data is older than our TTL (say, 4 hours), we fire a background refresh to the HCM. 

More importantly: we never commit based on cached data. Right before a **manager approves** a request, the service pauses, makes a real-time GET call to the HCM to verify the balance, and only then processes the approval. 

### 4.2 The Race Condition

**The scenario:** An employee has 5 days left. They open two tabs and hit "Submit" on two different 4-day requests at the exact same millisecond. Both requests read a local balance of 5, both pass validation, and we accidentally let them overdraw.

**The fix:** 
1. **Optimistic Locking:** The `time_off_balances` table has a `version` column. When we deduct days, the update query includes `WHERE version = :current_version`. If the second request tries to update the same row, the database rejects it, and we surface an error.
2. **HCM as the final gatekeeper:** Even if we mess up locally, we pass idempotency keys to the HCM. It will reject the overdraw, and our state machine will mark the request as `HCM_FAILED`.

### 4.3 Out-of-Band Updates

**The scenario:** An employee hits a work anniversary and the HCM automatically credits them 3 extra days. ExampleHR has no idea this happened, so the employee can't use their earned time off.

**The fix:** 
1. **Cron Batch Sync:** A scheduled NestJS `@Cron` job hits the HCM batch endpoint every 8 hours to pull the entire company's balances and run bulk upserts. 
2. **Webhooks (If available):** We expose a `POST /sync/batch` endpoint. If the HCM supports it, they can push balance changes to us the second they happen. 

### 4.4 The Unreliable HCM Error Problem

**The scenario:** The spec mentions the HCM *should* return an error if we send an invalid request, but it's not guaranteed. If we ask to deduct 5 days from a 2-day balance, and the HCM replies with `200 OK` due to a bug on their end, the employee's balance is corrupted.

**The fix:** We don't trust the HCM blindly. 
1. **Pre-flight check:** We calculate `current_hcm_balance - requested_days`. If it drops below zero, we block the request locally. We don't even bother asking the HCM.
2. **Post-flight audit:** After the HCM returns a success response, we immediately fetch the balance again. If the math doesn't line up, we flag the request in the database as `HCM_AUDIT_REQUIRED` and fire an alert. 

### 4.5 The Double-Deduction (Idempotency)

**The scenario:** We send an approved deduction to the HCM. The HCM processes it, but the network drops before we get the HTTP response. Our system retries the request. The HCM processes it again. The employee just lost double the vacation days.

**The fix:** We generate a UUID `hcm_transaction_id` when the request is created. Every call to the HCM includes this ID. If our retry hits the HCM again, the HCM must recognize the ID and return the previous success response without deducting the balance twice.

### 4.6 The Partial Failure (State Machine)

**The scenario:** Manager approves the leave. We update local DB to `APPROVED`. We call the HCM, but the HCM is offline. Our system is now out of sync.

**The fix:** We run a strict state machine:
`PENDING` → `APPROVED_LOCALLY` → `HCM_SUBMITTING` → `HCM_CONFIRMED` (or `HCM_FAILED`).

If the HCM call fails, the request sits in `HCM_FAILED`. A background worker uses exponential backoff to retry sending it until the HCM wakes up and confirms it. 

---

## 5. Proposed Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                         ExampleHR UI                            │
└───────────────────────────────────┬─────────────────────────────┘
                                    │ REST
                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Time-Off Microservice (NestJS)               │
│                                                                  │
│  ┌──────────────────┐   ┌──────────────────┐                    │
│  │  RequestService   │   │  BalanceService   │                   │
│  │  (State Machine) │   │  (Sync + Cache)   │                   │
│  └────────┬─────────┘   └────────┬──────────┘                   │
│           │                      │                               │
│  ┌────────▼──────────────────────▼──────────┐                   │
│  │              HCM Client Service           │                   │
│  │    (Retry, Idempotency, Axios)            │                   │
│  └────────────────────┬──────────────────────┘                  │
│                       │                                          │
│  ┌────────────────────▼──────────────────────┐                  │
│  │               SQLite DB                    │                  │
│  │  time_off_requests | time_off_balances    │                  │
│  └───────────────────────────────────────────┘                  │
└─────────────────────────────────┬───────────────────────────────┘
                                  │ HTTP
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                        HCM System                               │
│  - Real-time balance GET                                        │
│  - Deduction POST (requires idempotency key)                    │
│  - Batch GET                                                    │
└─────────────────────────────────────────────────────────────────┘

```

---

## 6. Data Model

### `time_off_requests`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT (UUID) | PK |
| `employee_id` | TEXT |  |
| `location_id` | TEXT | Used for HCM dimension |
| `leave_type` | TEXT | Used for HCM dimension (e.g., 'SICK') |
| `start_date` | DATE |  |
| `end_date` | DATE |  |
| `requested_days` | REAL |  |
| `status` | TEXT | PENDING, APPROVED_LOCALLY, HCM_CONFIRMED, HCM_FAILED |
| `hcm_transaction_id` | TEXT | Idempotency key |

### `time_off_balances`

| Column | Type | Notes |
| --- | --- | --- |
| `employee_id` | TEXT | PK Part 1 |
| `location_id` | TEXT | PK Part 2 |
| `leave_type` | TEXT | PK Part 3 |
| `available_days` | REAL |  |
| `version` | INTEGER | For optimistic locking |
| `last_synced_at` | TIMESTAMP |  |

---

## 7. API Design

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/time-off/requests` | Submit a request (creates local record) |
| `GET` | `/time-off/requests` | List requests |
| `PATCH` | `/time-off/requests/:id/approve` | Manager approval (triggers sync & deduction) |
| `GET` | `/time-off/balances/:employeeId` | Fetches local balance (checks TTL for refresh) |
| `POST` | `/time-off/webhook/hcm-batch` | Endpoint for HCM to push new data to us |

---

## 8. Sync Strategy

We use three safety nets to keep data accurate:

1. **Real-time Check:** Triggered right before a manager approves a request. Slowest, but guarantees we don't commit bad data.
2. **Webhooks:** Expose an endpoint so the HCM can actively tell us when a batch update happens (like year-start resets).
3. **Polling Worker:** A cron job that blindly asks the HCM for the latest batch data every 8 hours, catching anything the webhooks missed.

---

## 9. Configuration Assumptions (Assessment Scope)

Several constants in this design — the cache TTL, the cron interval, the retry budget — are not arbitrary, but they *are* assumed for the purposes of this assessment. In a real engagement, every one of these numbers would be a conversation with the HCM team before I wrote a single line of code.

Here's what I've hardcoded and why it needs a real answer in production:

**Balance cache TTL — currently 4 hours**

I picked 4 hours as a reasonable middle ground: long enough to avoid hammering the HCM API on every employee page load, short enough that most balance changes show up within half a working day. But this number is meaningless without answering: *How frequently does the HCM actually update balances?* If the HCM only runs a payroll batch once a day at midnight, a 4-hour TTL is wasted calls. If they process corrections continuously throughout the day, we might want 30 minutes. The right TTL is derived from HCM's actual write cadence — not a gut feeling.

**Cron batch sync interval — currently every 8 hours**

Same logic. The batch endpoint is the safety net that catches everything the webhooks miss. If the HCM team tells me that out-of-band updates (anniversary bonuses, year-start resets) only happen at defined windows — say, 2am on January 1st and on each employee's hire date anniversary — I'd schedule the cron to run slightly after those known windows instead of on a dumb 8-hour loop. Running a full company-wide batch sync every 8 hours when balances only meaningfully change twice a year is just unnecessary load on both systems.

**HTTP timeout — currently 5 seconds**

I set 5 seconds as the Axios timeout for HCM calls. That's a standard defensive value, but it's not based on anything real. The HCM team would tell me what their p95 response time looks like. If their real-time balance endpoint reliably responds in 300ms, I can tighten this to 2 seconds and fail faster on real outages. If they're a SOAP-over-HTTPS legacy system that occasionally takes 8 seconds under load, a 5-second timeout would cause false failures.

**Retry attempts and backoff — currently 3 retries, 100ms base delay**

Retrying a failed HCM call 3 times with exponential backoff is sensible, but the right numbers depend on the HCM's failure characteristics. Is it usually a transient blip that clears in under a second? Or is it maintenance windows that last 30 minutes? If it's the former, 3 fast retries makes sense. If it's the latter, we're better off with 1 retry and then putting the request into a `HCM_FAILED` queue to be picked up when HCM comes back — rather than hammering a system that's clearly down for a while.

**The conversation I'd have with the HCM team:**

Before going to production, I'd sit down with the HCM integration team and work through these specific questions:

- What is your API's p50/p95/p99 response time for the real-time balance endpoint?
- How often do you run batch processes that update employee balances? Are these scheduled (daily/weekly) or event-driven?
- Do you support idempotency keys on deduction requests natively, or do we need to build that ourselves?
- Do you support webhooks for push notifications, or are we polling-only?
- What are your rate limits? (Tells me how aggressive the cron can be.)
- What does your maintenance window schedule look like, and do you publish it?
- Are there known high-traffic periods where your API degrades? (e.g., year-start, open enrollment)

The answers to these questions directly drive the constants. The architecture I've designed is flexible enough to accommodate any reasonable answers — the TTLs, cron schedules, and timeouts are all config values, not hard-coded assumptions baked into logic. Changing them is a `.env` update, not a code change.

---

## 10. Failure Modes & Mitigations

| If this happens... | Here is how we handle it |
| --- | --- |
| **HCM is down when checking balance** | Return the local SQLite balance but flag it in the UI as "last synced X mins ago". |
| **HCM is down during approval** | Update local state to `HCM_FAILED` and let a background queue retry the HTTP call with exponential backoff. |
| **HCM silently accepts bad data** | Calculate expected balance post-approval. If it doesn't match the HCM's number, lock the record for manual review. |
| **Two requests fired at once** | SQLite optimistic locking blocks the second write. |

---

## 11. Alternatives Considered

**Two-Phase Commit (2PC):** Locking both our database and the HCM database simultaneously.
*Why I rejected it:* Good luck getting a vendor like Workday to hold a database lock for a third-party app. Nobody uses 2PC for external HTTP APIs; it kills performance.

**Event Sourcing:** Storing every single transaction (additions/deductions) and calculating the balance on the fly instead of storing a hard number.
*Why I rejected it:* Event sourcing only makes sense if *you* are the definitive source of truth. We aren't. We are basically a smart cache. Building an event store here is overkill and introduces unnecessary complexity.

---

## 12. Non-Goals

* **Authentication:** Assuming `employeeId` is provided via standard JWT/Auth headers.
* **Leave Overlap:** We aren't checking if an employee requested two overlapping vacations in this service. We are relying on the balance deduction math.

---

## 13. Open Questions

These are the questions I'd need answered before calling this production-ready. Some affect architecture; most affect configuration.

**HCM Integration**
1. Do you support idempotency keys on deduction POST requests natively? If not, we build a deduplication layer on our side.
2. What dimensions does your balance API require? (`locationId` + `leaveTypeId` is what I'm assuming — are there additional axes like cost center or pay group?)
3. Do you support webhook callbacks for balance change events, or are we polling-only?
4. What is your rate limit policy on the real-time balance and batch endpoints?

**HCM Performance & Reliability**
5. What are your p50/p95 response times on the real-time balance GET endpoint? This drives our HTTP timeout config.
6. Do you publish a maintenance window schedule? This lets us avoid scheduling our cron right when you're down.
7. Are there known peak periods where your API degrades (year-start, open enrollment)? We'd want to reduce polling frequency during those windows.

**Business Rules**
8. How often do out-of-band balance changes happen in practice? (anniversary bonuses, HR corrections) — this directly determines whether an 8-hour batch sync is appropriate or if we need to tighten it.
9. Should the balance TTL for *display purposes* be different from the TTL that *gates approval*? Product decision, but it affects UX.
10. What is the acceptable staleness window for an employee's balance view? (currently assuming 4 hours — is that OK with Product?)

