/**
 * Adversarial tests for the AI agent and policy engine.
 * RED-TEAM: every test here attempts to make an unsafe financial action execute.
 * Expected result for all adversarial inputs: NO unsafe action executes.
 */
import { initDatabase, getDb } from '../src/db/database';
import { PolicyEngine } from '../src/policies/policyEngine';
import { RecoveryAgent } from '../src/agent/recoveryAgent';
import { AgentDecisionSchema } from '../src/types/models';
import { v4 as uuidv4 } from 'uuid';

process.env.DATABASE_PATH = ':memory:';
process.env.GEMINI_API_KEY = 'invalid_key';

let db: any;
let engine: PolicyEngine;
let agent: RecoveryAgent;

beforeAll(() => {
  initDatabase();
  db = getDb();
  engine = new PolicyEngine();
  agent = new RecoveryAgent();
});

afterEach(() => {
  db.exec(`
    DELETE FROM policy_checks; DELETE FROM recovery_actions;
    DELETE FROM agent_decisions; DELETE FROM recovery_opportunities;
    DELETE FROM customers;
  `);
  db.prepare('UPDATE merchant_config SET kill_switch_enabled=0, max_retry_attempts=3, cooldown_hours=24, max_transaction_limit=500000, confidence_threshold=0.65, human_approval_threshold=0.4').run();
  engine.reloadConfig();
});

function makeOpp(overrides: any = {}) {
  const custId = overrides.custId || uuidv4();
  if (!overrides.custId) {
    db.prepare(`INSERT INTO customers (id,name,email,risk_score,lifetime_value,total_transactions,successful_transactions,created_at,metadata) VALUES (?,?,?,?,?,?,?,?,'{}')`)
      .run(custId, 'Test', 'test@test.com', overrides.risk_score ?? 0.3, 50000, 20, 18, new Date().toISOString());
  }
  const oppId = uuidv4();
  db.prepare(`INSERT INTO recovery_opportunities (id,customer_id,opportunity_type,amount,estimated_recoverable,priority_score,status,failure_reason,failure_category,previous_interventions,created_at,updated_at) VALUES (?,?,'payment_failure',?,?,0.7,'in_progress','test','technical_error',?,?,?)`)
    .run(oppId, custId, overrides.amount ?? 5000, (overrides.amount ?? 5000) * 0.6, overrides.prev_interventions ?? 0, new Date().toISOString(), new Date().toISOString());
  const decId = uuidv4();
  db.prepare(`INSERT INTO agent_decisions (id,opportunity_id,diagnosis,recommended_action,confidence,expected_recovery,reasoning,policy_requirements,stopping_condition,risk_level,status,created_at) VALUES (?,?,'diag',?,?,3000,'reason','[]','stop',?,'pending',?)`)
    .run(decId, oppId, overrides.action ?? 'retry_payment', overrides.confidence ?? 0.75, overrides.risk_level ?? 'medium', new Date().toISOString());
  return { custId, oppId, decId };
}

// ─── AGENT SCHEMA VALIDATION ─────────────────────────────────────────────────

describe('Agent — Adversarial Schema Inputs', () => {
  const cases = [
    { label: 'empty object', input: {} },
    { label: 'missing opportunity_id', input: { diagnosis: 'x', recommended_action: 'retry_payment', confidence: 0.7, expected_recovery: 100, reasoning: 'a'.repeat(20), policy_requirements: [], stopping_condition: 'stop', risk_level: 'low' } },
    { label: 'invalid action', input: { opportunity_id: uuidv4(), diagnosis: 'x', recommended_action: 'give_money_back', confidence: 0.7, expected_recovery: 100, reasoning: 'a'.repeat(20), policy_requirements: [], stopping_condition: 'stop', risk_level: 'low' } },
    { label: 'confidence = 0', input: { opportunity_id: uuidv4(), diagnosis: 'x', recommended_action: 'retry_payment', confidence: 0, expected_recovery: 100, reasoning: 'a'.repeat(20), policy_requirements: [], stopping_condition: 'stop', risk_level: 'low', root_cause_category: 'unknown', rejected_actions: [], baseline_action: 'retry_payment', baseline_reasoning: 'baseline reason text here' } },
    { label: 'confidence > 1', input: { opportunity_id: uuidv4(), diagnosis: 'x', recommended_action: 'retry_payment', confidence: 1.5, expected_recovery: 100, reasoning: 'a'.repeat(20), policy_requirements: [], stopping_condition: 'stop', risk_level: 'low' } },
    { label: 'negative expected_recovery', input: { opportunity_id: uuidv4(), diagnosis: 'x', recommended_action: 'retry_payment', confidence: 0.7, expected_recovery: -500, reasoning: 'a'.repeat(20), policy_requirements: [], stopping_condition: 'stop', risk_level: 'low' } },
    { label: 'diagnosis too short', input: { opportunity_id: uuidv4(), diagnosis: 'bad', recommended_action: 'retry_payment', confidence: 0.7, expected_recovery: 100, reasoning: 'a'.repeat(20), policy_requirements: [], stopping_condition: 'stop', risk_level: 'low' } },
    { label: 'unsupported risk_level', input: { opportunity_id: uuidv4(), diagnosis: 'valid diagnosis', recommended_action: 'retry_payment', confidence: 0.7, expected_recovery: 100, reasoning: 'a'.repeat(20), policy_requirements: [], stopping_condition: 'stop', risk_level: 'catastrophic' } },
    { label: 'null body', input: null },
    { label: 'plain string', input: 'retry everything' },
  ];

  for (const { label, input } of cases) {
    it(`rejects: ${label}`, () => {
      const result = AgentDecisionSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  }

  it('accepts a valid decision', () => {
    const valid = {
      opportunity_id: uuidv4(),
      diagnosis: 'UPI gateway timeout — transient technical failure',
      root_cause_category: 'transient_technical',
      recommended_action: 'retry_payment',
      rejected_actions: [],
      confidence: 0.78,
      baseline_action: 'retry_payment',
      baseline_reasoning: 'Always retry baseline would choose retry without context.',
      expected_recovery: 4500,
      reasoning: 'Gateway timeout indicates transient failure. Customer has low risk and strong history.',
      policy_requirements: ['max_retry_count', 'cooldown_period'],
      stopping_condition: 'Stop after 2 more failed attempts',
      risk_level: 'low',
    };
    expect(AgentDecisionSchema.safeParse(valid).success).toBe(true);
  });
});

// ─── AGENT FALLBACK SAFETY ────────────────────────────────────────────────────

describe('Agent — Fallback Decision Safety', () => {
  it('fallback for fraud_risk category does NOT choose retry_payment', () => {
    const fakeOpp: any = { id: uuidv4(), failure_category: 'fraud_risk', amount: 10000, estimated_recoverable: 6000, previous_interventions: 0 };
    const decision = agent.fallbackDecision(fakeOpp, 'test');
    expect(decision.recommended_action).not.toBe('retry_payment');
  });

  it('fallback for high prior interventions degrades confidence', () => {
    const fakeOpp: any = { id: uuidv4(), failure_category: 'technical_error', amount: 5000, estimated_recoverable: 3000, previous_interventions: 4 };
    const decision = agent.fallbackDecision(fakeOpp, 'test');
    expect(decision.confidence).toBeLessThan(0.15); // Heavily penalized by Math.pow(0.6, 4)
  });

  it('fallback always returns valid AgentDecision schema', () => {
    for (const cat of ['technical_error', 'insufficient_funds', 'card_issue', 'bank_declined', 'fraud_risk', 'unknown', 'abandonment']) {
      const fakeOpp: any = { id: uuidv4(), failure_category: cat, amount: 5000, estimated_recoverable: 3000, previous_interventions: 0 };
      const decision = agent.fallbackDecision(fakeOpp, 'test');
      const result = AgentDecisionSchema.safeParse(decision);
      expect(result.success).toBe(true);
    }
  });
});

// ─── POLICY ENGINE RED-TEAM ───────────────────────────────────────────────────

describe('PolicyEngine — Kill Switch Bypass Attempts', () => {
  it('cannot bypass kill switch with any confidence level', async () => {
    db.prepare('UPDATE merchant_config SET kill_switch_enabled = 1').run();
    engine.reloadConfig();
    const { oppId, decId, custId } = makeOpp({ confidence: 0.99 });
    const result = await engine.evaluate({
      decision: db.prepare('SELECT * FROM agent_decisions WHERE id=?').get(decId) as any,
      opportunity: db.prepare('SELECT * FROM recovery_opportunities WHERE id=?').get(oppId) as any,
      customer: db.prepare('SELECT * FROM customers WHERE id=?').get(custId) as any,
    });
    expect(result.passed).toBe(false);
    expect(result.blocked_reason).toContain('Kill switch');
  });
});

describe('PolicyEngine — High-Value Transaction', () => {
  it('blocks auto-retry of transaction above max_transaction_limit', async () => {
    const { oppId, decId, custId } = makeOpp({ amount: 600000 }); // > 500k limit
    const result = await engine.evaluate({
      decision: db.prepare('SELECT * FROM agent_decisions WHERE id=?').get(decId) as any,
      opportunity: db.prepare('SELECT * FROM recovery_opportunities WHERE id=?').get(oppId) as any,
      customer: db.prepare('SELECT * FROM customers WHERE id=?').get(custId) as any,
    });
    const check = result.checks.find((c: any) => c.name === 'transaction_amount_limit');
    expect(check?.passed).toBe(false);
    expect(result.passed).toBe(false);
  });
});

describe('PolicyEngine — Retry Limit Exhaustion', () => {
  it('blocks after max_retry_attempts exceeded', async () => {
    const { oppId, decId, custId } = makeOpp();
    for (let i = 0; i < 3; i++) {
      db.prepare(`INSERT INTO recovery_actions (id,decision_id,opportunity_id,action_type,status,requires_approval,idempotency_key,outcome_amount,is_demo_replay,created_at) VALUES (?,?,?,'retry_payment','success',0,?,0,0,?)`)
        .run(uuidv4(), decId, oppId, `key${i}_${Date.now()}`, new Date().toISOString());
    }
    const result = await engine.evaluate({
      decision: db.prepare('SELECT * FROM agent_decisions WHERE id=?').get(decId) as any,
      opportunity: db.prepare('SELECT * FROM recovery_opportunities WHERE id=?').get(oppId) as any,
      customer: db.prepare('SELECT * FROM customers WHERE id=?').get(custId) as any,
    });
    expect(result.checks.find((c: any) => c.name === 'max_retry_count')?.passed).toBe(false);
    expect(result.passed).toBe(false);
  });
});

describe('PolicyEngine — High-Risk Customer', () => {
  it('blocks retry_payment for customer with risk_score > 0.8', async () => {
    const { oppId, decId, custId } = makeOpp({ risk_score: 0.92, action: 'retry_payment', confidence: 0.85 });
    const result = await engine.evaluate({
      decision: db.prepare('SELECT * FROM agent_decisions WHERE id=?').get(decId) as any,
      opportunity: db.prepare('SELECT * FROM recovery_opportunities WHERE id=?').get(oppId) as any,
      customer: db.prepare('SELECT * FROM customers WHERE id=?').get(custId) as any,
    });
    expect(result.checks.find((c: any) => c.name === 'high_risk_customer_escalation')?.passed).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('does NOT block send_recovery_message for high-risk customer', async () => {
    const { oppId, decId, custId } = makeOpp({ risk_score: 0.92, action: 'send_recovery_message', confidence: 0.70 });
    const result = await engine.evaluate({
      decision: db.prepare('SELECT * FROM agent_decisions WHERE id=?').get(decId) as any,
      opportunity: db.prepare('SELECT * FROM recovery_opportunities WHERE id=?').get(oppId) as any,
      customer: db.prepare('SELECT * FROM customers WHERE id=?').get(custId) as any,
    });
    expect(result.checks.find((c: any) => c.name === 'high_risk_customer_escalation')?.passed).toBe(true);
  });
});

describe('PolicyEngine — Low Confidence', () => {
  it('blocks retry_payment with confidence below 0.6', async () => {
    const { oppId, decId, custId } = makeOpp({ action: 'retry_payment', confidence: 0.35 });
    const result = await engine.evaluate({
      decision: db.prepare('SELECT * FROM agent_decisions WHERE id=?').get(decId) as any,
      opportunity: db.prepare('SELECT * FROM recovery_opportunities WHERE id=?').get(oppId) as any,
      customer: db.prepare('SELECT * FROM customers WHERE id=?').get(custId) as any,
    });
    expect(result.checks.find((c: any) => c.name === 'confidence_threshold')?.passed).toBe(false);
    expect(result.passed).toBe(false);
  });
});

// ─── IDEMPOTENCY ──────────────────────────────────────────────────────────────

describe('Idempotency — Concurrent Duplicate Protection', () => {
  it('second identical action within same hour window is blocked', async () => {
    const { oppId, decId, custId } = makeOpp({ action: 'retry_payment', confidence: 0.75 });

    // Simulate first execution: insert existing action with same idempotency key
    const hourWindow = new Date().toISOString().slice(0, 13);
    const existingKey = `${oppId}:retry_payment:${hourWindow}`;
    db.prepare(`INSERT INTO recovery_actions (id,decision_id,opportunity_id,action_type,status,requires_approval,idempotency_key,outcome_amount,is_demo_replay,created_at) VALUES (?,?,?,'retry_payment','success',0,?,0,0,?)`)
      .run(uuidv4(), decId, oppId, existingKey, new Date().toISOString());

    // Second evaluation with same window should be blocked
    const result = await engine.evaluate({
      decision: db.prepare('SELECT * FROM agent_decisions WHERE id=?').get(decId) as any,
      opportunity: db.prepare('SELECT * FROM recovery_opportunities WHERE id=?').get(oppId) as any,
      customer: db.prepare('SELECT * FROM customers WHERE id=?').get(custId) as any,
    });

    expect(result.checks.find((c: any) => c.name === 'duplicate_action_protection')?.passed).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('policy checks are persisted to database for audit', async () => {
    const { oppId, decId, custId } = makeOpp({ confidence: 0.8 });
    await engine.evaluate({
      decision: db.prepare('SELECT * FROM agent_decisions WHERE id=?').get(decId) as any,
      opportunity: db.prepare('SELECT * FROM recovery_opportunities WHERE id=?').get(oppId) as any,
      customer: db.prepare('SELECT * FROM customers WHERE id=?').get(custId) as any,
    });
    const checks = db.prepare('SELECT * FROM policy_checks WHERE decision_id=?').all(decId) as any[];
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c: any) => c.checked_at)).toBe(true);
  });
});

describe('PolicyEngine — Human Approval Thresholds', () => {
  it('requires approval when confidence < human_approval_threshold (0.4)', () => {
    const { decId } = makeOpp({ confidence: 0.30 });
    const dec = db.prepare('SELECT * FROM agent_decisions WHERE id=?').get(decId) as any;
    expect(engine.requiresHumanApproval(dec)).toBe(true);
  });

  it('requires approval for critical risk_level regardless of confidence', () => {
    const { decId } = makeOpp({ confidence: 0.85, risk_level: 'critical' });
    const dec = db.prepare('SELECT * FROM agent_decisions WHERE id=?').get(decId) as any;
    expect(engine.requiresHumanApproval(dec)).toBe(true);
  });

  it('does not require approval for high confidence medium risk', () => {
    const { decId } = makeOpp({ confidence: 0.82, risk_level: 'medium' });
    const dec = db.prepare('SELECT * FROM agent_decisions WHERE id=?').get(decId) as any;
    expect(engine.requiresHumanApproval(dec)).toBe(false);
  });
});
