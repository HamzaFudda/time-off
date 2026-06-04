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

For the scope of this assessment, I am making some baseline assumptions for constants like cache TTL, pooling cron intervals, and retry budgets. In the real world, before writing any code, I would sit down with the HCM team to understand exactly how often their data is updated, the flows and protocols they follow, and their system's actual behavior. That conversation is what dictates these constants so we aren't making extra, unnecessary calls to their servers.

Here is what I have configured for this take-home, and how it would change in production:

**Balance cache TTL (4 hours)**
Right now, this is set to 4 hours. It's a middle ground to avoid hammering the HCM API while keeping balances relatively fresh. But in production, the TTL depends on the HCM's actual write cadence. If they only run a batch update at midnight, a 4-hour TTL is wasted overhead. If they process corrections continuously, we might drop it to 30 minutes.

**Cron batch sync interval (8 hours)**
The batch endpoint catches what webhooks miss. For the assessment, the pooling cron job runs every 8 hours. Realistically, if out-of-band updates (like anniversary bonuses) only happen at specific windows, I would schedule the cron to run right after those windows. Running a blind 8-hour loop when data only changes twice a year adds unnecessary server load to both systems.

**HTTP timeout (5 seconds)**
I set a standard 5-second Axios timeout for HCM calls. The actual value should be based on their response time. If they reliably respond in 300ms, I would tighten this down to 2 seconds to fail faster. If they have heavy legacy endpoints that take 8 seconds, 5 seconds will just trigger false failures.

**Retry attempts and backoff (3 retries, 100ms base)**
Retrying failed calls 3 times with exponential backoff makes sense on paper. But if the HCM's typical downtime is a 30-minute maintenance window rather than a split-second network drop, fast retries are useless. In that case, I'd configure it to drop the request into the `HCM_FAILED` state immediately and let a background worker pick it up later instead of hammering a down system.

**The HCM Team Conversation**
The actual values for these variables would be finalized by answering these questions with the HCM integration team:

* How often is data actually updated, and what flows/protocols do you follow for those updates?
* What is the latency for real-time balance checks?
* Do you natively support idempotency keys for POST requests, or do we handle deduplication?
* Are webhooks available, or are we strictly limited to polling?
* What are the hard API rate limits?
* When are the scheduled maintenance windows or known high-load periods?

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

Before I would ever stamp this as production-ready, we need to have a sit-down with both the Product team and the HCM integration team. I am not guessing on these variables. Here is exactly what needs to be answered:

### HCM Integration Specs

1. Does the HCM natively support idempotency keys on deduction POST requests? If they don't, we have to build our own deduplication layer in the NestJS service to guarantee we don't double-charge vacation days on a network retry.

2. What exact dimensions does the HCM API require? I built the schema assuming location_id and leave_type, but if they also strictly require cost centers or pay groups to process a deduction, our data model needs an update.

3. Can the HCM push webhook events to us when a balance changes out-of-band, or are we strictly stuck polling them?

4. What are the hard API rate limits? I need to know the ceiling before I configure how aggressively the background workers can run.

### HCM Reliability & Telemetry

5. What is the real latency on their real-time balance GET endpoint? I need actual metrics to set a defensive HTTP timeout, otherwise we'll just be guessing and either failing too early or hanging our own threads.

6. Do they publish a reliable maintenance window schedule? If we know when they go down, we can pause the sync worker instead of pointlessly slamming a dead server and filling our logs with noise.

7. Does their API historically choke during peak seasons? If so, we need a plan to dial back our polling frequency during those windows to avoid causing a cascade failure.

### Product & Business Rules

8. Realistically, how often do HR admins or automated scripts change balances directly in the HCM? If it's twice a year, an 8-hour batch sync is overkill. If they are making manual corrections constantly, 8 hours is way too slow.

9. What is Product's actual tolerance for stale data on the UI? I currently have the cache TTL set to 4 hours. Is it acceptable to the business if an employee looks at a balance that is 3.5 hours out of date, knowing that we will hard-verify the true number before the manager can actually approve it?
