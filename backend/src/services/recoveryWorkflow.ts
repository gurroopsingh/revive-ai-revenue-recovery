import { getDb } from '../db/database';
import { recoveryAgent } from '../agent/recoveryAgent';
import { policyEngine } from '../policies/policyEngine';
import { auditService } from './auditService';
import { razorpayAdapter } from '../integrations/razorpay/razorpayAdapter';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import type {
  RecoveryOpportunity, Customer, PaymentEvent,
  AgentDecisionRow, RecoveryAction
} from '../types/models';

/**
 * RECOVERY WORKFLOW ORCHESTRATOR
 * Coordinates the full pipeline:
 * DETECT → DIAGNOSE → DECIDE → POLICY → EXECUTE → VERIFY → AUDIT
 *
 * Every decision and its outcome is persisted for evaluation.
 */
export class RecoveryWorkflow {

  async processOpportunity(opportunityId: string): Promise<{
    opportunityId: string;
    status: string;
    action?: string;
    blocked?: boolean;
    blockedReason?: string;
    requiresApproval?: boolean;
    recoveredAmount?: number;
    isFallback?: boolean;
  }> {
    const db = getDb();
    const now = new Date().toISOString();

    const opportunity = db.prepare(
      'SELECT * FROM recovery_opportunities WHERE id = ?'
    ).get(opportunityId) as RecoveryOpportunity | undefined;
    if (!opportunity) throw new Error(`Opportunity ${opportunityId} not found`);

    if (opportunity.status !== 'pending') {
      return { opportunityId, status: opportunity.status };
    }

    db.prepare('UPDATE recovery_opportunities SET status = ?, updated_at = ? WHERE id = ?')
      .run('in_progress', now, opportunityId);

    await auditService.log({
      opportunity_id: opportunityId,
      event_type: 'opportunity_detected',
      description: `[SYSTEM] Opportunity detected. Amount: ₹${opportunity.amount.toLocaleString('en-IN')}`,
      data: { is_ai_decision: false, priority: opportunity.priority_score, type: opportunity.opportunity_type },
    });

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(opportunity.customer_id) as Customer | undefined;
    if (!customer) throw new Error(`Customer ${opportunity.customer_id} not found`);

    const event = opportunity.payment_event_id
      ? db.prepare('SELECT * FROM payment_events WHERE id = ?').get(opportunity.payment_event_id) as PaymentEvent | undefined
      : undefined;

    // Build rich customer history for AI context
    const histRow = db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successes,
             AVG(amount) as avg_amount
      FROM payment_events WHERE customer_id = ?
    `).get(customer.id) as { total: number; successes: number; avg_amount: number };

    const recentFailures = (db.prepare(`
      SELECT failure_reason FROM payment_events
      WHERE customer_id = ? AND status = 'failed' ORDER BY occurred_at DESC LIMIT 5
    `).all(customer.id) as { failure_reason: string }[]).map(r => r.failure_reason).filter(Boolean);

    const recoveryHistory = (db.prepare(`
      SELECT ra.action_type, CASE WHEN ra.outcome_amount > 0 THEN 1 ELSE 0 END as recovered
      FROM recovery_actions ra
      JOIN recovery_opportunities ro ON ro.id = ra.opportunity_id
      WHERE ro.customer_id = ? LIMIT 20
    `).all(customer.id) as { action_type: string; recovered: number }[])
      .map(r => ({ action: r.action_type, recovered: r.recovered === 1 }));

    const previousInterventions = (db.prepare(`
      SELECT ra.action_type, ra.outcome, ra.executed_at
      FROM recovery_actions ra JOIN recovery_opportunities ro ON ro.id = ra.opportunity_id
      WHERE ro.customer_id = ? ORDER BY ra.executed_at DESC LIMIT 10
    `).all(customer.id) as { action_type: string; outcome: string; executed_at: string }[])
      .map(r => ({ action: r.action_type, outcome: r.outcome || 'pending', date: r.executed_at || now }));

    // ===== STEP 1: AI DIAGNOSIS =====
    logger.info(`[AI] Analyzing opportunity ${opportunityId.slice(0, 8)}...`);
    const { decision, isFallback } = await recoveryAgent.analyzeOpportunity({
      opportunity, customer, event,
      customerHistory: {
        totalAttempts: histRow.total || 0,
        successRate: histRow.total > 0 ? (histRow.successes || 0) / histRow.total : 0.5,
        recentFailures,
        avgAmount: histRow.avg_amount || opportunity.amount,
        recoveryHistory,
      },
      previousInterventions,
    });

    // ===== STEP 2: PERSIST DECISION =====
    const decisionId = uuidv4();
    db.prepare(`
      INSERT INTO agent_decisions
        (id, opportunity_id, diagnosis, root_cause_category, recommended_action, rejected_actions,
         confidence, expected_recovery, reasoning, policy_requirements, stopping_condition,
         risk_level, baseline_action, baseline_reasoning, status, is_fallback, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      decisionId, opportunityId, decision.diagnosis, decision.root_cause_category,
      decision.recommended_action, JSON.stringify(decision.rejected_actions),
      decision.confidence,
      // Expected recovery is ESTIMATED from opportunity data, not from LLM
      Math.round(opportunity.estimated_recoverable * decision.confidence * 100) / 100,
      decision.reasoning, JSON.stringify(decision.policy_requirements),
      decision.stopping_condition, decision.risk_level,
      decision.baseline_action, decision.baseline_reasoning,
      isFallback ? 1 : 0, now
    );

    await auditService.log({
      opportunity_id: opportunityId,
      decision_id: decisionId,
      event_type: 'agent_decision_created',
      description: `${isFallback ? '[FALLBACK]' : '[AI]'} Recommended: ${decision.recommended_action} | Confidence: ${(decision.confidence * 100).toFixed(0)}%`,
      data: { is_ai_decision: !isFallback, action: decision.recommended_action, confidence: decision.confidence, isFallback, root_cause: decision.root_cause_category },
    });

    // ===== STEP 3: POLICY ENGINE (deterministic) =====
    const decisionRow = db.prepare('SELECT * FROM agent_decisions WHERE opportunity_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(opportunityId) as unknown as AgentDecisionRow;
    const policyResult = await policyEngine.evaluate({ decision: decisionRow, opportunity, customer });

    if (!policyResult.passed) {
      db.prepare('UPDATE agent_decisions SET status = ? WHERE id = ?').run('blocked', decisionId);
      db.prepare('UPDATE recovery_opportunities SET status = ?, updated_at = ? WHERE id = ?')
        .run('blocked', now, opportunityId);

      await auditService.log({
        opportunity_id: opportunityId,
        decision_id: decisionId,
        event_type: 'action_blocked',
        description: `[POLICY] Action blocked: ${policyResult.blocked_reason}`,
        data: { is_ai_decision: decisionRow.is_fallback === 0, checks: policyResult.checks, blocked_reason: policyResult.blocked_reason },
      });

      logger.warn(`[POLICY] Opportunity ${opportunityId.slice(0, 8)} BLOCKED — ${policyResult.blocked_reason}`);
      return { opportunityId, status: 'blocked', action: decision.recommended_action, blocked: true, blockedReason: policyResult.blocked_reason, isFallback };
    }

    // ===== STEP 4: HUMAN APPROVAL CHECK =====
    const needsApproval = policyEngine.requiresHumanApproval(decisionRow);
    const idempotencyKey = `${opportunityId}:${decision.recommended_action}:${now.slice(0, 13)}`;

    const actionId = uuidv4();
    db.prepare(`
      INSERT INTO recovery_actions
        (id, decision_id, opportunity_id, action_type, status, requires_approval, idempotency_key, is_demo_replay, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(actionId, decisionId, opportunityId, decision.recommended_action,
      needsApproval ? 'awaiting_approval' : 'pending', needsApproval ? 1 : 0, idempotencyKey, now);

    if (needsApproval) {
      db.prepare('UPDATE agent_decisions SET status = ? WHERE id = ?').run('awaiting_approval', decisionId);
      db.prepare('UPDATE recovery_opportunities SET status = ?, updated_at = ? WHERE id = ?').run('in_progress', now, opportunityId);

      await auditService.log({
        opportunity_id: opportunityId, decision_id: decisionId, action_id: actionId,
        event_type: 'awaiting_human_approval',
        description: `[SYSTEM] Human approval required — confidence ${(decision.confidence * 100).toFixed(0)}% or risk=${decision.risk_level}`,
        data: { is_ai_decision: !isFallback },
      });

      return { opportunityId, status: 'awaiting_approval', action: decision.recommended_action, requiresApproval: true, isFallback };
    }

    // ===== STEP 5: EXECUTE =====
    return await this.executeAction(actionId, opportunityId, decisionId, decision.recommended_action, isFallback);
  }

  async executeAction(
    actionId: string, opportunityId: string, decisionId: string, actionType: string, isFallback = false
  ): Promise<{
    opportunityId: string; status: string; action?: string;
    blocked?: boolean; blockedReason?: string; requiresApproval?: boolean;
    recoveredAmount?: number; isFallback?: boolean;
    executionMode?: string; razorpayLinkUrl?: string;
  }> {
    const db = getDb();
    const now = new Date().toISOString();

    const opportunity = db.prepare('SELECT * FROM recovery_opportunities WHERE id = ?')
      .get(opportunityId) as unknown as RecoveryOpportunity;
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?')
      .get(opportunity.customer_id) as unknown as Customer;

    const isRazorpayMode = actionType === 'send_recovery_message' && razorpayAdapter.isTestModeAvailable();
    const modeLabel = isRazorpayMode ? '[RAZORPAY TEST MODE]' : '[SIMULATION]';

    db.prepare('UPDATE recovery_actions SET status = ?, executed_at = ? WHERE id = ?').run('executing', now, actionId);
    await auditService.log({
      opportunity_id: opportunityId, decision_id: decisionId, action_id: actionId,
      event_type: 'action_executing',
      description: `${modeLabel} Executing: ${actionType}`,
      data: { is_ai_decision: !isFallback, execution_mode: isRazorpayMode ? 'RAZORPAY_TEST_MODE' : 'SIMULATION' },
    });

    const result = await this.executeWithAdapter(actionType, opportunityId, customer, opportunity);
    const finalModeLabel = result.executionMode === 'RAZORPAY_TEST_MODE' ? '[RAZORPAY TEST MODE]'
      : result.executionMode === 'SIMULATION_FALLBACK' ? '[SIMULATION FALLBACK]' : '[SIMULATION]';

    // For Razorpay payment links, recovery is pending (customer must pay the link)
    const effectiveStatus = result.executionMode === 'RAZORPAY_TEST_MODE' && result.success
      ? 'in_progress'   // Link created; awaiting customer payment
      : result.success ? 'recovered' : 'failed';

    db.prepare('UPDATE recovery_actions SET status = ?, outcome = ?, outcome_amount = ?, error_message = ? WHERE id = ?')
      .run(result.success ? 'success' : 'failed', result.outcome, result.recoveredAmount || 0, result.error || null, actionId);
    db.prepare('UPDATE agent_decisions SET status = ? WHERE id = ?')
      .run(result.success ? 'executed' : 'failed', decisionId);
    db.prepare('UPDATE recovery_opportunities SET status = ?, updated_at = ? WHERE id = ?')
      .run(effectiveStatus, now, opportunityId);
    db.prepare('UPDATE recovery_opportunities SET previous_interventions = previous_interventions + 1 WHERE id = ?')
      .run(opportunityId);

    const successDesc = result.executionMode === 'RAZORPAY_TEST_MODE'
      ? `${finalModeLabel} ✓ Payment link created: ${result.razorpayLinkUrl}`
      : `${finalModeLabel} ✓ Recovered ₹${result.recoveredAmount?.toFixed(2)}`;

    await auditService.log({
      opportunity_id: opportunityId, decision_id: decisionId, action_id: actionId,
      event_type: result.success ? 'action_success' : 'action_failed',
      description: result.success ? successDesc : `${finalModeLabel} ✗ Failed: ${result.error}`,
      data: {
        is_ai_decision: !isFallback,
        execution_mode: result.executionMode,
        razorpay_link_id: result.razorpayLinkId,
        razorpay_link_url: result.razorpayLinkUrl,
        ...result,
      },
    });

    return {
      opportunityId, status: effectiveStatus, action: actionType,
      recoveredAmount: result.recoveredAmount, isFallback,
      executionMode: result.executionMode,
      razorpayLinkUrl: result.razorpayLinkUrl,
    };
  }

  /**
   * Executes the action. For `send_recovery_message`, attempts Razorpay
   * test-mode payment link creation when credentials are configured.
   * All other actions use simulation. Falls back gracefully on any error.
   *
   * Execution path:
   *   Policy Engine → THIS → Razorpay Adapter (if applicable) → Audit
   */
  private async executeWithAdapter(
    actionType: string,
    opportunityId: string,
    customer: Customer,
    opportunity: RecoveryOpportunity,
  ): Promise<{
    success: boolean;
    outcome: string;
    recoveredAmount?: number;
    error?: string;
    executionMode: 'RAZORPAY_TEST_MODE' | 'SIMULATION' | 'SIMULATION_FALLBACK';
    razorpayLinkId?: string;
    razorpayLinkUrl?: string;
  }> {
    // ── RAZORPAY TEST MODE: send_recovery_message ────────────────────────────
    if (actionType === 'send_recovery_message' && razorpayAdapter.isTestModeAvailable()) {
      // Amount in paise (Razorpay requires integer paise)
      const amountPaise = Math.round(opportunity.estimated_recoverable * 100);

      const adapterResult = await razorpayAdapter.createPaymentLink({
        amount: amountPaise,
        currency: 'INR',
        reference_id: `revive_${opportunityId.slice(0, 16)}`,
        description: `Payment recovery — Ref: ${opportunityId.slice(0, 8)}`,
        customer: {
          name: customer.name,
          email: customer.email,
          contact: customer.phone,
        },
      });

      if (adapterResult.success && adapterResult.paymentLinkUrl) {
        logger.info(
          `[Razorpay TEST MODE] Payment link sent to ${customer.email}: ${adapterResult.paymentLinkUrl}`
        );
        return {
          success: true,
          outcome: 'payment_link_created',
          recoveredAmount: 0, // Actual recovery depends on customer paying the link
          executionMode: 'RAZORPAY_TEST_MODE',
          razorpayLinkId: adapterResult.paymentLinkId,
          razorpayLinkUrl: adapterResult.paymentLinkUrl,
        };
      }

      // Adapter failed — DO NOT falsely simulate success. Fail explicitly with SIMULATION_FALLBACK mode.
      logger.warn(
        `[Razorpay] Adapter error (${adapterResult.error}), falling back to safe failure mode`
      );
      
      return {
        success: false,
        outcome: 'payment_link_failed',
        error: `Razorpay API error: ${adapterResult.error}`,
        executionMode: 'SIMULATION_FALLBACK' as any,
      };
    }

    // ── SIMULATION (all other actions, or fallback if NO credentials exist) ───
    return { ...(await this.simulateExecution(actionType, opportunityId)), executionMode: 'SIMULATION' };

  }

  /**
   * Simulated execution with realistic success rates per action type.
   * In production: replace with real Razorpay API calls per action.
   * send_recovery_message → already replaced by Razorpay adapter above.
   */
  private async simulateExecution(actionType: string, opportunityId: string): Promise<{
    success: boolean; outcome: string; recoveredAmount?: number; error?: string;
  }> {
    const db = getDb();
    const opportunity = db.prepare('SELECT * FROM recovery_opportunities WHERE id = ?').get(opportunityId) as unknown as RecoveryOpportunity;

    // Simulated success rates derived from real-world recovery literature
    const successRates: Record<string, number> = {
      retry_payment: 0.60,
      schedule_retry: 0.50,
      send_recovery_message: 0.35,
      escalate_to_human: 0.72,
      stop_ignore: 0.0,
      change_strategy: 0.45,
    };

    const rate = successRates[actionType] ?? 0.45;
    if (actionType === 'stop_ignore') {
      return { success: false, outcome: 'ignored', error: 'No action taken — marked as unrecoverable' };
    }

    const success = Math.random() < rate;
    if (success) {
      const recoveredAmount = Math.round(opportunity.estimated_recoverable * (0.82 + Math.random() * 0.18) * 100) / 100;
      return { success: true, outcome: `${actionType}_succeeded`, recoveredAmount };
    }
    const errors = ['payment_gateway_timeout', 'bank_declined_again', 'customer_not_reachable', 'retry_limit_at_bank'];
    return { success: false, outcome: `${actionType}_failed`, error: errors[Math.floor(Math.random() * errors.length)] };
  }

  async approveAction(actionId: string, approvedBy: string): Promise<void> {
    const db = getDb();
    const now = new Date().toISOString();
    const action = db.prepare('SELECT * FROM recovery_actions WHERE id = ?').get(actionId) as RecoveryAction | undefined;
    if (!action) throw new Error(`Action ${actionId} not found`);
    if (action.status !== 'awaiting_approval') throw new Error('Action is not awaiting approval');

    db.prepare('UPDATE recovery_actions SET status = ?, approved_by = ?, approved_at = ? WHERE id = ?')
      .run('pending', approvedBy, now, actionId);

    await auditService.log({
      opportunity_id: action.opportunity_id, decision_id: action.decision_id, action_id: actionId,
      event_type: 'action_approved',
      description: `[HUMAN] Action approved: ${action.action_type}`,
      data: { is_ai_decision: false, approved_by: approvedBy },
    });

    await this.executeAction(actionId, action.opportunity_id, action.decision_id, action.action_type);
  }
}

export const recoveryWorkflow = new RecoveryWorkflow();
