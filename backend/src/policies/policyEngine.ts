import { getDb } from '../db/database';
import type {
  MerchantConfig, AgentDecisionRow, RecoveryAction,
  RecoveryOpportunity, Customer, AuditLog, PolicyCheck
} from '../types/models';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

/**
 * POLICY ENGINE – deterministic enforcement of merchant rules.
 * LLM decisions are NEVER executed without passing all applicable checks.
 */

export interface PolicyResult {
  passed: boolean;
  blocked_reason?: string;
  checks: Array<{ name: string; passed: boolean; reason?: string }>;
}

export class PolicyEngine {
  private config: MerchantConfig | null = null;

  constructor() {
    // Lazy init – don't call loadConfig() here; DB may not be ready yet
  }

  private loadConfig(): MerchantConfig {
    const db = getDb();
    const config = db.prepare('SELECT * FROM merchant_config WHERE id = ?').get('default') as MerchantConfig | undefined;
    if (!config) throw new Error('Merchant config not found');
    return config;
  }

  reloadConfig(): void {
    this.config = this.loadConfig();
  }

  private ensureConfig(): MerchantConfig {
    if (!this.config) this.config = this.loadConfig();
    return this.config;
  }

  getConfig(): MerchantConfig {
    return this.ensureConfig();
  }

  /**
   * Run all policy checks against a proposed agent decision.
   * Returns PASS or FAIL with reasons. Deterministic – no AI involvement.
   */
  async evaluate(params: {
    decision: AgentDecisionRow;
    opportunity: RecoveryOpportunity;
    customer: Customer;
  }): Promise<PolicyResult> {
    const { decision, opportunity, customer } = params;
    const db = getDb();
    const checks: Array<{ name: string; passed: boolean; reason?: string }> = [];
    const config = this.ensureConfig();

    // 1. Kill switch
    if (config.kill_switch_enabled) {
      checks.push({ name: 'kill_switch', passed: false, reason: 'Kill switch is active – all recovery actions halted' });
      return this.buildResult(checks, decision.id);
    }
    checks.push({ name: 'kill_switch', passed: true });

    // 2. Maximum retry count
    const actionCount = (db.prepare(`
      SELECT COUNT(*) as cnt FROM recovery_actions
      WHERE opportunity_id = ? AND action_type = 'retry_payment' AND status IN ('success','executing','pending')
    `).get(opportunity.id) as { cnt: number }).cnt;
    const maxRetries = config.max_retry_attempts;
    const retryOk = actionCount < maxRetries;
    checks.push({
      name: 'max_retry_count',
      passed: retryOk,
      reason: retryOk ? undefined : `Max retry limit (${maxRetries}) reached for this opportunity`,
    });

    // 3. Cooldown period
    const lastAction = db.prepare(`
      SELECT executed_at FROM recovery_actions
      WHERE opportunity_id = ? ORDER BY executed_at DESC LIMIT 1
    `).get(opportunity.id) as { executed_at: string } | undefined;

    if (lastAction?.executed_at) {
      const hoursSince = (Date.now() - new Date(lastAction.executed_at).getTime()) / 3_600_000;
      const cooldownOk = hoursSince >= config.cooldown_hours;
      checks.push({
        name: 'cooldown_period',
        passed: cooldownOk,
        reason: cooldownOk
          ? undefined
          : `Cooldown period not elapsed (${hoursSince.toFixed(1)}h < ${config.cooldown_hours}h required)`,
      });
    } else {
      checks.push({ name: 'cooldown_period', passed: true });
    }

    // 4. Transaction amount limit
    const amountOk = opportunity.amount <= config.max_transaction_limit;
    checks.push({
      name: 'transaction_amount_limit',
      passed: amountOk,
      reason: amountOk
        ? undefined
        : `Amount ₹${opportunity.amount} exceeds limit ₹${config.max_transaction_limit} – requires manual review`,
    });

    // 5. Confidence threshold (action-specific)
    const minConfidence = decision.recommended_action === 'retry_payment' ? 0.6 : 0.4;
    const confOk = decision.confidence >= minConfidence;
    checks.push({
      name: 'confidence_threshold',
      passed: confOk,
      reason: confOk
        ? undefined
        : `Confidence ${(decision.confidence * 100).toFixed(0)}% below required ${(minConfidence * 100).toFixed(0)}%`,
    });

    // 6. Customer contact frequency (past 7 days)
    const weekAgo = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
    const contactCount = (db.prepare(`
      SELECT COUNT(*) as cnt FROM recovery_actions
      WHERE opportunity_id IN (
        SELECT id FROM recovery_opportunities WHERE customer_id = ?
      )
      AND action_type = 'send_recovery_message'
      AND created_at > ?
    `).get(customer.id, weekAgo) as { cnt: number }).cnt;

    const contactOk = contactCount < config.max_contact_per_week;
    checks.push({
      name: 'contact_frequency_limit',
      passed: contactOk || decision.recommended_action !== 'send_recovery_message',
      reason: contactOk
        ? undefined
        : `Customer contacted ${contactCount}x this week (limit: ${config.max_contact_per_week})`,
    });

    // 7. Duplicate action protection (idempotency)
    const idempKey = `${opportunity.id}:${decision.recommended_action}:${new Date().toISOString().slice(0, 13)}`;
    const dupCheck = db.prepare(`
      SELECT id FROM recovery_actions WHERE idempotency_key = ?
    `).get(idempKey);
    const noDuplicate = !dupCheck;
    checks.push({
      name: 'duplicate_action_protection',
      passed: noDuplicate,
      reason: noDuplicate ? undefined : 'Duplicate action detected within same hour window',
    });

    // 8. High-risk customer escalation rule
    if (customer.risk_score > 0.8 && decision.recommended_action === 'retry_payment') {
      checks.push({
        name: 'high_risk_customer_escalation',
        passed: false,
        reason: `Customer risk score ${(customer.risk_score * 100).toFixed(0)}% is too high for auto-retry`,
      });
    } else {
      checks.push({ name: 'high_risk_customer_escalation', passed: true });
    }

    return this.buildResult(checks, decision.id);
  }

  private buildResult(
    checks: Array<{ name: string; passed: boolean; reason?: string }>,
    decisionId: string
  ): PolicyResult {
    const db = getDb();
    const now = new Date().toISOString();

    // Persist policy checks
    const insertCheck = db.prepare(`
      INSERT INTO policy_checks (id, decision_id, check_name, passed, reason, checked_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const c of checks) {
      insertCheck.run(uuidv4(), decisionId, c.name, c.passed ? 1 : 0, c.reason || null, now);
    }

    const failedChecks = checks.filter(c => !c.passed);
    const passed = failedChecks.length === 0;

    return {
      passed,
      blocked_reason: passed ? undefined : failedChecks.map(c => c.reason).join('; '),
      checks,
    };
  }

  /**
   * Check if an action requires human approval (below confidence threshold or high risk).
   */
  requiresHumanApproval(decision: AgentDecisionRow): boolean {
    const config = this.ensureConfig();
    return decision.confidence < config.human_approval_threshold || decision.risk_level === 'critical';
  }
}

export const policyEngine = new PolicyEngine();
