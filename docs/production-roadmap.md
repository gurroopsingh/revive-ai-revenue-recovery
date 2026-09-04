# REVIVE AI — Production Roadmap

This document honestly describes what would change to deploy REVIVE in a real Razorpay environment.

**Current state:** Controlled buildathon prototype. Payment Links are real in Razorpay Test Mode, but full production deployment requires additional infrastructure.

## What Changes for Production

### 1. Razorpay API Integration
**Now:** `send_recovery_message` is implemented with a real Razorpay Test Mode adapter (`POST /v1/payment_links`) and a verified webhook (`payment_link.paid`). Other actions use `simulateExecution()` with realistic probabilities.  
**Production:** Expand integration for all recovery actions (e.g., `POST /v1/payments/{id}/capture` for payment capture) and use live credentials for actual financial processing.
- All credentials via environment variables, never committed.

### 2. Database
**Now:** SQLite (node:sqlite, single file).  
**Production:** PostgreSQL with:
- Read replicas for analytics queries
- Connection pooling (PgBouncer)
- Row-level locking for idempotency (SELECT FOR UPDATE)
- Partitioned tables for payment_events by date

### 3. Distributed Idempotency
**Now:** SQLite UNIQUE constraint on idempotency_key (race condition possible in concurrent multi-process).  
**Production:** Redis-based distributed lock with TTL. Acquire lock before policy evaluation, release after execution.

### 4. Secrets Management
**Now:** `.env` file, GEMINI_API_KEY in environment.  
**Production:** HashiCorp Vault or AWS Secrets Manager. Keys rotated automatically. No key in source.

### 5. Authentication & Authorization
**Now:** No auth on API endpoints.  
**Production:**
- Merchant JWT tokens for API access
- Role-based access: `merchant_viewer`, `merchant_operator`, `merchant_admin`
- Human approval actions require `merchant_admin` role
- Audit log tied to authenticated user identity

### 6. Webhook Ingestion
**Now:** Razorpay webhook endpoint handles `payment_link.paid` with full HMAC-SHA256 signature verification and idempotency logic. Other events are synthetically injected.  
**Production:** Expand webhook handler for all possible payment and subscription outcome events:
- Dead letter queue for failed processing
- Event replay capabilities

### 7. Observability
**Now:** Winston logs to console.  
**Production:**
- Structured JSON logs → Datadog/Grafana Loki
- Metrics: recovery_rate, agent_latency, policy_block_rate, api_error_rate
- Alerts: kill_switch activation, error rate spike, recovery rate drop
- Trace IDs across detection → decision → execution → verification

### 8. Human Approval Workflow
**Now:** Approve button in UI, no auth.  
**Production:**
- Merchant notification (email/Slack) when approval required
- Time-limited approval tokens
- Automatic escalation if not approved within SLA
- Mobile-friendly approval flow

### 9. Model Monitoring
**Now:** Not monitored.  
**Production:**
- Log all LLM inputs and outputs (redacted PII)
- Track decision distribution drift (are recommended actions changing?)
- Confidence score calibration validation
- Fallback rate monitoring (high fallback rate = model issues)
- Weekly human review of 100 random decisions

### 10. Rollback Strategy
**Now:** Kill switch in merchant_config.  
**Production:**
- Feature flags per merchant
- Gradual rollout (1% → 5% → 25% → 100% of merchants)
- Automatic kill switch if error rate > threshold
- Circuit breaker on Gemini API calls

## What Is Already Production-Quality

- Policy engine architecture (deterministic, auditable)
- Schema validation (Zod) before any action
- Idempotency concept (key structure, UNIQUE constraint)
- Audit trail design (immutable append-only)
- Train/dev/test split discipline
- Evaluation pipeline methodology
- Fallback degradation path
