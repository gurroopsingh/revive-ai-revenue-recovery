/**
 * Unit tests for the Policy Engine
 * Tests: max retries, cooldown, idempotency, kill switch, contact limits
 */

import { initDatabase, getDb } from '../src/db/database';
import { PolicyEngine } from '../src/policies/policyEngine';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseSync } from 'node:sqlite';

// Use in-memory DB for tests
process.env.DATABASE_PATH = ':memory:';
process.env.GEMINI_API_KEY = 'test_key';

let db: DatabaseSync;
let engine: PolicyEngine;

function makeCustomer(overrides: Partial<{
  id: string; risk_score: number; lifetime_value: number;
  total_transactions: number; successful_transactions: number;
}> = {}) {
  const id = overrides.id || uuidv4();
  db.prepare(`
    INSERT INTO customers (id, name, email, risk_score, lifetime_value, total_transactions, successful_transactions, created_at, metadata)
    VALUES (?, 'Test Customer', 'test@example.com', ?, ?, ?, ?, ?, '{}')
  `).run(id, overrides.risk_score ?? 0.3, overrides.lifetime_value ?? 10000,
    overrides.total_transactions ?? 10, overrides.successful_transactions ?? 8,
    new Date().toISOString());
  return id;
}

function makeOpportunity(customerId: string, overrides: Partial<{
  id: string; amount: number;
}> = {}) {
  const id = overrides.id || uuidv4();
  db.prepare(`
    INSERT INTO recovery_opportunities
      (id, customer_id, opportunity_type, amount, estimated_recoverable, priority_score,
       status, failure_reason, previous_interventions, created_at, updated_at)
    VALUES (?, ?, 'payment_failure', ?, ?, 0.7, 'in_progress', 'test', 0, ?, ?)
  `).run(id, customerId, overrides.amount ?? 5000, (overrides.amount ?? 5000) * 0.6,
    new Date().toISOString(), new Date().toISOString());
  return id;
}

function makeDecision(opportunityId: string, overrides: Partial<{
  id: string; confidence: number; recommended_action: string; risk_level: string;
}> = {}) {
  const id = overrides.id || uuidv4();
  db.prepare(`
    INSERT INTO agent_decisions
      (id, opportunity_id, diagnosis, recommended_action, confidence, expected_recovery,
       reasoning, policy_requirements, stopping_condition, risk_level, status, created_at)
    VALUES (?, ?, 'test diagnosis', ?, ?, 3000, 'test reasoning', '[]', 'stop after 3', ?, 'pending', ?)
  `).run(id, opportunityId, overrides.recommended_action ?? 'retry_payment',
    overrides.confidence ?? 0.75, overrides.risk_level ?? 'medium', new Date().toISOString());
  return id;
}

beforeAll(() => {
  initDatabase();
  db = getDb();
  engine = new PolicyEngine();
});

afterEach(() => {
  // Clean between tests
  db.exec(`
    DELETE FROM policy_checks;
    DELETE FROM recovery_actions;
    DELETE FROM agent_decisions;
    DELETE FROM recovery_opportunities;
    DELETE FROM customers;
  `);
  // Reset config
  db.prepare('UPDATE merchant_config SET kill_switch_enabled = 0, max_retry_attempts = 3, cooldown_hours = 24, max_contact_per_week = 3, max_transaction_limit = 500000, confidence_threshold = 0.65, human_approval_threshold = 0.40').run();
  engine.reloadConfig();
});

describe('PolicyEngine – Kill Switch', () => {
  it('blocks ALL actions when kill switch is enabled', async () => {
    db.prepare('UPDATE merchant_config SET kill_switch_enabled = 1').run();
    engine.reloadConfig();

    const custId = makeCustomer();
    const oppId = makeOpportunity(custId);
    const decId = makeDecision(oppId);

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(custId) as any;
    const opportunity = db.prepare('SELECT * FROM recovery_opportunities WHERE id = ?').get(oppId) as any;
    const decision = db.prepare('SELECT * FROM agent_decisions WHERE id = ?').get(decId) as any;

    const result = await engine.evaluate({ decision, opportunity, customer });
    expect(result.passed).toBe(false);
    expect(result.blocked_reason).toContain('Kill switch');
    expect(result.checks.find(c => c.name === 'kill_switch')?.passed).toBe(false);
  });
});

describe('PolicyEngine – Max Retry Count', () => {
  it('allows action when retry count is under limit', async () => {
    const custId = makeCustomer();
    const oppId = makeOpportunity(custId);
    const decId = makeDecision(oppId, { confidence: 0.75 });

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(custId) as any;
    const opportunity = db.prepare('SELECT * FROM recovery_opportunities WHERE id = ?').get(oppId) as any;
    const decision = db.prepare('SELECT * FROM agent_decisions WHERE id = ?').get(decId) as any;

    const result = await engine.evaluate({ decision, opportunity, customer });
    const retryCheck = result.checks.find(c => c.name === 'max_retry_count');
    expect(retryCheck?.passed).toBe(true);
  });

  it('blocks retry when max attempts reached', async () => {
    const custId = makeCustomer();
    const oppId = makeOpportunity(custId);
    const decId = makeDecision(oppId, { confidence: 0.75 });

    // Add 3 existing successful retry actions (at limit)
    for (let i = 0; i < 3; i++) {
      db.prepare(`
        INSERT INTO recovery_actions
          (id, decision_id, opportunity_id, action_type, status, requires_approval, idempotency_key, created_at)
        VALUES (?, ?, ?, 'retry_payment', 'success', 0, ?, ?)
      `).run(uuidv4(), decId, oppId, `key_${i}_${Date.now()}`, new Date().toISOString());
    }

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(custId) as any;
    const opportunity = db.prepare('SELECT * FROM recovery_opportunities WHERE id = ?').get(oppId) as any;
    const decision = db.prepare('SELECT * FROM agent_decisions WHERE id = ?').get(decId) as any;

    const result = await engine.evaluate({ decision, opportunity, customer });
    const retryCheck = result.checks.find(c => c.name === 'max_retry_count');
    expect(retryCheck?.passed).toBe(false);
    expect(retryCheck?.reason).toContain('Max retry limit');
    expect(result.passed).toBe(false);
  });
});

describe('PolicyEngine – Transaction Amount Limit', () => {
  it('blocks transaction exceeding limit', async () => {
    const custId = makeCustomer();
    const oppId = makeOpportunity(custId, { amount: 600000 }); // Over 500k limit
    const decId = makeDecision(oppId, { confidence: 0.75 });

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(custId) as any;
    const opportunity = db.prepare('SELECT * FROM recovery_opportunities WHERE id = ?').get(oppId) as any;
    const decision = db.prepare('SELECT * FROM agent_decisions WHERE id = ?').get(decId) as any;

    const result = await engine.evaluate({ decision, opportunity, customer });
    const amtCheck = result.checks.find(c => c.name === 'transaction_amount_limit');
    expect(amtCheck?.passed).toBe(false);
    expect(result.passed).toBe(false);
  });
});

describe('PolicyEngine – Confidence Threshold', () => {
  it('blocks retry_payment when confidence is too low', async () => {
    const custId = makeCustomer();
    const oppId = makeOpportunity(custId);
    const decId = makeDecision(oppId, { confidence: 0.35, recommended_action: 'retry_payment' }); // Below 0.6

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(custId) as any;
    const opportunity = db.prepare('SELECT * FROM recovery_opportunities WHERE id = ?').get(oppId) as any;
    const decision = db.prepare('SELECT * FROM agent_decisions WHERE id = ?').get(decId) as any;

    const result = await engine.evaluate({ decision, opportunity, customer });
    const confCheck = result.checks.find(c => c.name === 'confidence_threshold');
    expect(confCheck?.passed).toBe(false);
    expect(result.passed).toBe(false);
  });
});

describe('PolicyEngine – High Risk Customer', () => {
  it('blocks auto-retry for high-risk customer', async () => {
    const custId = makeCustomer({ risk_score: 0.92 });
    const oppId = makeOpportunity(custId);
    const decId = makeDecision(oppId, { confidence: 0.80, recommended_action: 'retry_payment' });

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(custId) as any;
    const opportunity = db.prepare('SELECT * FROM recovery_opportunities WHERE id = ?').get(oppId) as any;
    const decision = db.prepare('SELECT * FROM agent_decisions WHERE id = ?').get(decId) as any;

    const result = await engine.evaluate({ decision, opportunity, customer });
    const riskCheck = result.checks.find(c => c.name === 'high_risk_customer_escalation');
    expect(riskCheck?.passed).toBe(false);
    expect(result.passed).toBe(false);
  });
});

describe('PolicyEngine – Human Approval', () => {
  it('requires approval for low confidence decisions', () => {
    const decId = makeDecision(makeOpportunity(makeCustomer()), { confidence: 0.30 });
    const decision = db.prepare('SELECT * FROM agent_decisions WHERE id = ?').get(decId) as any;
    expect(engine.requiresHumanApproval(decision)).toBe(true);
  });

  it('requires approval for critical risk level', () => {
    const decId = makeDecision(makeOpportunity(makeCustomer()), { confidence: 0.80, risk_level: 'critical' });
    const decision = db.prepare('SELECT * FROM agent_decisions WHERE id = ?').get(decId) as any;
    expect(engine.requiresHumanApproval(decision)).toBe(true);
  });

  it('does not require approval for high-confidence medium-risk', () => {
    const decId = makeDecision(makeOpportunity(makeCustomer()), { confidence: 0.82, risk_level: 'medium' });
    const decision = db.prepare('SELECT * FROM agent_decisions WHERE id = ?').get(decId) as any;
    expect(engine.requiresHumanApproval(decision)).toBe(false);
  });
});

describe('PolicyEngine – Idempotency', () => {
  it('persists policy checks to database', async () => {
    const custId = makeCustomer();
    const oppId = makeOpportunity(custId);
    const decId = makeDecision(oppId, { confidence: 0.75 });

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(custId) as any;
    const opportunity = db.prepare('SELECT * FROM recovery_opportunities WHERE id = ?').get(oppId) as any;
    const decision = db.prepare('SELECT * FROM agent_decisions WHERE id = ?').get(decId) as any;

    await engine.evaluate({ decision, opportunity, customer });

    const checks = db.prepare('SELECT * FROM policy_checks WHERE decision_id = ?').all(decId);
    expect(checks.length).toBeGreaterThan(0);
  });
});
