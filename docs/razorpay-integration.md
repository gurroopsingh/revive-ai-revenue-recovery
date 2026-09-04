# REVIVE AI — Razorpay Integration

## What Was Integrated

**Capability:** Razorpay Test Mode Payment Link Creation  
**API:** `POST https://api.razorpay.com/v1/payment_links`  
**Auth:** HTTP Basic Auth (`RAZORPAY_KEY_ID:RAZORPAY_KEY_SECRET`, Base64-encoded)  
**Triggered by:** `send_recovery_message` action after Policy Engine approval

---

## What Is Real vs Simulated

| Component | Status |
|---|---|
| Payment Link creation (`POST /v1/payment_links`) | ✅ **REAL** — Razorpay Test Mode API |
| Payment Link status fetch (`GET /v1/payment_links/:id`) | ✅ **REAL** — Razorpay Test Mode API |
| Webhook signature verification (HMAC-SHA256) | ✅ **REAL** — verified against Razorpay spec |
| Customer payment of the link | ⚠️ **Simulated** — requires human to click link in test checkout |
| `payment_link.paid` webhook event | ⚠️ **Simulated** — can be triggered manually via Razorpay dashboard |
| `retry_payment`, `schedule_retry`, other actions | ⚠️ **Simulated** — success rates from literature |

---

## Request Flow

```
Failed Payment Event
    │
    ▼
Risk Detector (deterministic)
    │
    ▼
AI Agent / EV Fallback
    │  → recommended_action: 'send_recovery_message'
    ▼
Zod Schema Validation
    │
    ▼
Policy Engine (8 deterministic rules — FINAL AUTHORIZATION BOUNDARY)
    │  Policy passes
    ▼
RazorpayAdapter.createPaymentLink()          ← THIS IS THE REAL CALL
    │
    │  POST https://api.razorpay.com/v1/payment_links
    │  Authorization: Basic <base64(KEY_ID:KEY_SECRET)>
    │  Body: { amount (paise), currency, reference_id, customer, expire_by }
    │
    ▼
Razorpay Test Mode API
    │  Returns: { id, short_url, status: 'created' }
    ▼
Audit Log (execution_mode: 'RAZORPAY_TEST_MODE', link_id, link_url)
    │
    ▼
Opportunity status → 'in_progress' (awaiting customer payment)
```

---

## Authentication

Razorpay uses HTTP Basic Auth. No SDK is used — the adapter makes direct HTTPS calls using Node.js `https` module to keep dependencies minimal.

```
Authorization: Basic base64(RAZORPAY_KEY_ID + ":" + RAZORPAY_KEY_SECRET)
```

Credentials are read exclusively from `process.env`. They are never hardcoded, never logged, and never included in audit trail data.

---

## Webhook Verification

**Endpoint:** `POST /api/razorpay/webhook`

Razorpay signs webhook payloads with HMAC-SHA256 using your webhook secret.

Verification process:
1. Capture raw request body (before JSON parsing) — required for signature validity
2. Compute `HMAC-SHA256(rawBody, RAZORPAY_WEBHOOK_SECRET)`
3. Compare using `crypto.timingSafeEqual` to prevent timing attacks
4. Reject with HTTP 400 if signature is missing or invalid
5. On `payment_link.paid` event — mark opportunity as `recovered` and log to audit trail

The `reference_id` field (`revive_<opportunityId[:16]>`) links the Razorpay event back to the REVIVE opportunity.

---

## Failure Handling

| Failure | Behaviour |
|---|---|
| Missing credentials | Falls back to SIMULATION silently — workflow continues unaffected |
| Invalid KEY_ID format (not `rzp_test_`) | `isTestModeAvailable()` returns false — SIMULATION used |
| HTTP 401 / 403 (bad credentials) | Error classified as `INVALID_CREDENTIALS` → SIMULATION fallback |
| HTTP timeout (> 10 seconds) | Error classified as `API_TIMEOUT` → SIMULATION fallback |
| DNS failure / connection refused | Error classified as `API_UNAVAILABLE` → SIMULATION fallback |
| Duplicate request from Razorpay | Error classified as `DUPLICATE_REQUEST` → SIMULATION fallback |
| Webhook missing signature header | HTTP 400 returned immediately |
| Webhook signature mismatch | HTTP 400 returned — event silently dropped |
| Webhook with no matching opportunity | Warning logged — no state change |

All failures produce a graceful fallback. The recovery pipeline **never crashes** due to Razorpay unavailability.

---

## Safety Boundary

The Policy Engine is always evaluated **before** the Razorpay adapter is called. The adapter cannot:

- Be invoked without a prior Policy Engine `pass`
- Override retry limits, cooldowns, or risk thresholds
- Bypass idempotency checks
- Execute on fraud-flagged customers
- Act without human approval for high-value transactions (> ₹5L)

---

## Environment Variables

Add to `backend/.env`:

```env
# Razorpay Test Mode (get keys from https://dashboard.razorpay.com/app/keys)
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...

# Optional: for webhook signature verification
RAZORPAY_WEBHOOK_SECRET=...
```

**KEY_ID must start with `rzp_test_`** — the adapter will refuse to operate in test mode if it detects a live key.

---

## Running the Live Integration Test

```bash
# Set credentials first
export RAZORPAY_KEY_ID=rzp_test_your_key
export RAZORPAY_KEY_SECRET=your_secret

# Run live test (makes REAL API calls to Razorpay test mode)
cd backend && npm run test:razorpay
```

This test:
1. Verifies credential detection works correctly
2. Creates a real payment link via `POST /v1/payment_links`
3. Fetches its status via `GET /v1/payment_links/:id`
4. Prints the link URL — you can open it in a browser and complete a test payment

No real money is involved. Razorpay test mode uses synthetic card/UPI flows.

---

## Running Standard Tests (No Credentials Required)

```bash
cd backend && npm test
```

The mock-based integration tests in `tests/razorpay.test.ts` use Jest mocks for the `https` module. They validate:
- Credential detection logic
- Amount validation (integer paise enforcement)
- SIMULATION mode fallback when credentials are absent
- RAZORPAY_TEST_MODE response shape on mock success
- Webhook HMAC-SHA256 signature verification logic

---

## Files Added / Modified

| File | Change |
|---|---|
| `backend/src/integrations/razorpay/razorpayAdapter.ts` | **NEW** — Razorpay adapter (isolated) |
| `backend/src/routes/razorpayWebhook.ts` | **NEW** — Webhook route with HMAC verification |
| `backend/src/services/recoveryWorkflow.ts` | Modified — `executeWithAdapter()` replaces `simulateExecution()` for `send_recovery_message` |
| `backend/src/routes/index.ts` | Modified — webhook route mounted |
| `backend/src/index.ts` | Modified — rawBody capture middleware, `razorpay_mode` in `/health` |
| `backend/package.json` | Modified — `test:razorpay` script added |
| `backend/tests/razorpay.test.ts` | **NEW** — Mock-based unit tests |
| `backend/tests/razorpay.live.ts` | **NEW** — Live integration test (requires credentials) |
| `frontend/src/pages/Dashboard.tsx` | Modified — execution mode badge (`SIMULATION` / `RAZORPAY TEST MODE`) |
| `.env.example` | Modified — Razorpay variables documented |
| `docs/razorpay-integration.md` | **NEW** — This document |

---

## Limitations

1. Only `send_recovery_message` uses Razorpay test mode. All other actions (`retry_payment`, `schedule_retry`, etc.) remain simulated.
2. Payment link outcome (customer paying) requires a human to complete the Razorpay test checkout — it cannot be automated without a browser.
3. Webhook delivery requires configuring a public URL in the Razorpay dashboard (e.g., via `ngrok` for local testing).
4. The `payment_link.paid` webhook handler marks the opportunity as `recovered` based on `reference_id` matching — this is a prefix match on the first 16 characters of the opportunity UUID.
