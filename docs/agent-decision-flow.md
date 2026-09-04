# REVIVE AI — Agent Decision Pipeline

This document precisely describes what the LLM is trusted and not trusted to do.

## Data Flow

```
Payment Event (failed/abandoned)
  │
  ▼
RISK DETECTOR (deterministic)
  • Classifies event type (payment_failure, subscription_failure, etc.)
  • Estimates recoverability per failure category (static rates)
  • Scores priority (amount × recoverability × urgency decay)
  • Creates recovery_opportunity record (split=train|dev|test)
  │
  ▼
CONTEXT BUILDER (deterministic)
  • Loads customer record (risk_score, lifetime_value, history)
  • Loads last 5 recent failures for this customer
  • Loads prior interventions and their outcomes
  • Loads payment event (method, gateway_error_code)
  • NO test-split outcome is ever included here
  │
  ▼
AI AGENT — Gemini 1.5 Flash (reasoning only)
  • Receives: opportunity context + customer signals + prior interventions
  • Produces: structured JSON matching AgentDecisionSchema (Zod)
  • Validated by Zod before any downstream use
  • If invalid/timeout/error → deterministic fallback activates
  │
  ▼
ZOD SCHEMA VALIDATION (deterministic)
  • All 11 required fields validated
  • opportunity_id must match (prevents hallucination)
  • Invalid schema → fallback decision, is_fallback=1 logged
  │
  ▼
POLICY ENGINE (deterministic — FINAL AUTHORIZATION BOUNDARY)
  • Kill switch check
  • Max retry count (per opportunity)
  • Cooldown period (time since last action)
  • Transaction amount limit (> ₹5L requires human)
  • Confidence threshold (< 0.6 for retry_payment → block)
  • Contact frequency limit (messages per week)
  • Idempotency key (same action in same hour window → block)
  • High-risk customer escalation (risk > 0.8 + retry → block)
  • All checks persisted to policy_checks table
  │
  ▼ (if any check fails → BLOCKED, no action executes)
  │
  ▼
HUMAN APPROVAL CHECK (deterministic)
  • confidence < 0.40 OR risk_level = 'critical' → awaiting_approval
  │
  ▼
EXECUTION (simulated in demo; Razorpay test-mode in production)
  • action_type, idempotency_key, executed_at persisted
  • outcome_amount = 0 on failure
  │
  ▼
AUDIT LOG (immutable append-only)
  • Every stage creates an audit_log entry
  • is_ai_decision=1 for AI-generated events, 0 for system events
  • Timestamps, actor, description at every step
```

## What the LLM is NOT Trusted to Decide

| Decision | Why It's Forbidden | Who Decides |
|---|---|---|
| Monetary amounts | LLM can hallucinate numbers | Backend calculates from `estimated_recoverable × confidence` |
| Retry limits | Must be merchant-configurable | Policy Engine (config table) |
| Authorization | Cannot be delegated to probabilistic model | Policy Engine (all-or-nothing) |
| Idempotency | Requires guaranteed uniqueness | Backend generates idempotency key |
| Policy thresholds | Must be auditable | MerchantConfig table |
| Whether an action is safe | LLM output is untrusted | Policy Engine is the final gate |
| Test set outcomes | Would leak information | Outcomes never shown to agent |

## Fallback Behavior

When Gemini is unavailable (timeout, 4xx, 5xx, invalid JSON, schema failure):

1. `isFallback = true` logged to agent_decisions
2. Deterministic rule applied: failure_category → safe action
3. High prior interventions (≥2) → escalate_to_human
4. High value → escalate_to_human  
5. Fraud risk → stop_ignore
6. Output still passes full Policy Engine validation

The fallback is not a bypass. The same Zod schema and policy checks apply.
