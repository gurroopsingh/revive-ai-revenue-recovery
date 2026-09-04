import { z } from 'zod';

// ===== ENUMS =====
export const EventTypeEnum = z.enum([
  'payment_failed',
  'checkout_abandoned',
  'subscription_failed',
  'receivable_overdue',
  'payment_success',
  'refund_issued',
]);

export const ActionTypeEnum = z.enum([
  'retry_payment',        // Immediate retry – transient technical failures
  'schedule_retry',       // Scheduled retry – timing-dependent (e.g. funds available later)
  'send_recovery_message',// Customer outreach – card issues, abandonment
  'escalate_to_human',    // Human review – high-value, complex, repeat failures
  'stop_ignore',          // No action – unrecoverable, fraud risk
  'change_strategy',      // Switch recovery approach based on new context
]);

export const RiskLevelEnum = z.enum(['low', 'medium', 'high', 'critical']);
export const OpportunityStatusEnum = z.enum([
  'pending', 'in_progress', 'recovered', 'failed', 'blocked', 'ignored', 'escalated',
]);
export const ActionStatusEnum = z.enum([
  'pending', 'awaiting_approval', 'approved', 'executing', 'success', 'failed', 'blocked',
]);

// ===== REJECTED ACTION (why alternatives were not chosen) =====
export const RejectedActionSchema = z.object({
  action: ActionTypeEnum,
  reason: z.string().min(5).max(300),
});

// ===== DECISION OBJECT (validated before execution) =====
// The LLM produces this. The Policy Engine validates it. The Executor acts on it.
// The LLM NEVER determines monetary amounts, retry limits, or auth.
export const AgentDecisionSchema = z.object({
  opportunity_id: z.string().uuid(),
  // Root cause analysis
  diagnosis: z.string().min(10).max(500),
  root_cause_category: z.enum([
    'transient_technical',  // Gateway/network blip – highly retryable
    'insufficient_funds',   // NSF – timing-sensitive
    'card_issue',           // Expired/blocked card – needs customer action
    'bank_declined',        // Bank policy decline – alternative method suggested
    'customer_initiated',   // Intentional – low recoverability
    'fraud_risk',           // Fraud signal – do not retry
    'unknown',              // Insufficient context
  ]),
  // Recommended action and alternatives
  recommended_action: ActionTypeEnum,
  rejected_actions: z.array(RejectedActionSchema).max(5),
  // Confidence and expected value (ranges only – exact amounts computed by backend)
  confidence: z.number().min(0).max(1),
  // Counterfactual: what the baseline would do
  baseline_action: ActionTypeEnum,
  baseline_reasoning: z.string().min(10).max(300),
  // Reasoning
  reasoning: z.string().min(20).max(2000),
  policy_requirements: z.array(z.string()),
  stopping_condition: z.string().min(5).max(300),
  risk_level: RiskLevelEnum,
});

export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

// ===== DEMO REPLAY SCENARIO =====
export type DemoScenarioType =
  | 'success_upi_retry'
  | 'policy_block_high_risk'
  | 'ai_failure_fallback'
  | 'duplicate_idempotency'
  | 'high_value_approval';

// ===== DB MODELS =====
export interface Customer {
  id: string;
  name: string;
  email: string;
  phone?: string;
  risk_score: number;
  lifetime_value: number;
  total_transactions: number;
  successful_transactions: number;
  created_at: string;
  metadata: string;
}

export interface PaymentEvent {
  id: string;
  customer_id: string;
  merchant_id: string;
  event_type: string;
  amount: number;
  currency: string;
  status: string;
  payment_method?: string;
  failure_reason?: string;
  gateway_error_code?: string;
  occurred_at: string;
  metadata: string;
}

export interface RecoveryOpportunity {
  id: string;
  customer_id: string;
  payment_event_id?: string;
  opportunity_type: string;
  amount: number;
  estimated_recoverable: number;
  priority_score: number;
  status: string;
  failure_reason?: string;
  failure_category?: string;
  previous_interventions: number;
  created_at: string;
  updated_at: string;
  split: string; // 'train' | 'dev' | 'test'
}

export interface AgentDecisionRow {
  id: string;
  opportunity_id: string;
  diagnosis: string;
  root_cause_category: string;
  recommended_action: string;
  rejected_actions: string; // JSON
  confidence: number;
  expected_recovery: number;
  reasoning: string;
  policy_requirements: string;
  stopping_condition: string;
  risk_level: string;
  baseline_action: string;
  baseline_reasoning: string;
  status: string;
  is_fallback: number; // 1 if AI was unavailable
  created_at: string;
}

export interface PolicyCheck {
  id: string;
  decision_id: string;
  check_name: string;
  passed: number;
  reason?: string;
  checked_at: string;
}

export interface RecoveryAction {
  id: string;
  decision_id: string;
  opportunity_id: string;
  action_type: string;
  status: string;
  requires_approval: number;
  approved_by?: string;
  approved_at?: string;
  executed_at?: string;
  outcome?: string;
  outcome_amount: number;
  error_message?: string;
  idempotency_key: string;
  is_demo_replay: number;
  created_at: string;
}

export interface AuditLog {
  id: string;
  opportunity_id?: string;
  decision_id?: string;
  action_id?: string;
  event_type: string;
  actor: string;
  is_ai_decision: number; // 0 = deterministic system, 1 = AI-generated
  description: string;
  data: string;
  timestamp: string;
}

export interface MerchantConfig {
  id: string;
  max_retry_attempts: number;
  cooldown_hours: number;
  max_contact_per_week: number;
  max_transaction_limit: number;
  confidence_threshold: number;
  human_approval_threshold: number;
  kill_switch_enabled: number;
  updated_at: string;
}
