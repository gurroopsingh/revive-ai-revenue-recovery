/**
 * Integration test for the complete recovery workflow
 * Tests the full pipeline: Detect → Diagnose → Guard → Execute → Audit
 */
import { initDatabase, getDb } from '../src/db/database';
import { riskDetector } from '../src/services/riskDetector';
import { recoveryWorkflow } from '../src/services/recoveryWorkflow';
import { auditService } from '../src/services/auditService';
import { v4 as uuidv4 } from 'uuid';

process.env.DATABASE_PATH = ':memory:';
process.env.GEMINI_API_KEY = 'test_key'; // Will use fallback decision

beforeAll(() => {
  initDatabase();
});

afterEach(() => {
  const db = getDb();
  db.exec(`
    DELETE FROM audit_log;
    DELETE FROM recovery_actions;
    DELETE FROM policy_checks;
    DELETE FROM agent_decisions;
    DELETE FROM recovery_opportunities;
    DELETE FROM payment_events;
    DELETE FROM customers;
  `);
});

function setupTestCustomer(riskScore = 0.3) {
  const db = getDb();
  const custId = uuidv4();
  db.prepare(`
    INSERT INTO customers (id, name, email, risk_score, lifetime_value, total_transactions, successful_transactions, created_at, metadata)
    VALUES (?, 'Test', 'test@example.com', ?, 50000, 20, 18, ?, '{}')
  `).run(custId, riskScore, new Date().toISOString());
  return custId;
}

function setupTestEvent(custId: string, failureReason = 'upi_timeout', amount = 5000) {
  const db = getDb();
  const eventId = uuidv4();
  db.prepare(`
    INSERT INTO payment_events (id, customer_id, merchant_id, event_type, amount, currency, status, payment_method, failure_reason, occurred_at, metadata)
    VALUES (?, ?, 'merchant_test', 'payment_failed', ?, 'INR', 'failed', 'upi', ?, ?, '{}')
  `).run(eventId, custId, amount, failureReason, new Date().toISOString());
  return eventId;
}

describe('Full Recovery Workflow Integration', () => {
  it('detects opportunity from payment event', () => {
    const custId = setupTestCustomer();
    setupTestEvent(custId, 'upi_timeout', 10000);

    const { created, totalAtRisk } = riskDetector.detectOpportunities(10);

    expect(created).toBeGreaterThan(0);
    expect(totalAtRisk).toBeGreaterThan(0);

    const db = getDb();
    const opp = db.prepare("SELECT * FROM recovery_opportunities WHERE customer_id = ?").get(custId) as any;
    expect(opp).toBeDefined();
    expect(opp.status).toBe('pending');
    expect(opp.amount).toBe(10000);
  });

  it('processes opportunity through full pipeline', async () => {
    const custId = setupTestCustomer(0.2);
    const eventId = setupTestEvent(custId, 'upi_timeout', 5000);

    riskDetector.detectOpportunities(1);

    const db = getDb();
    const opp = db.prepare("SELECT id FROM recovery_opportunities WHERE customer_id = ? LIMIT 1").get(custId) as { id: string };
    expect(opp).toBeDefined();

    const result = await recoveryWorkflow.processOpportunity(opp.id);
    expect(result.opportunityId).toBe(opp.id);
    expect(['recovered', 'failed', 'blocked', 'awaiting_approval']).toContain(result.status);
  }, 15000);

  it('creates audit trail entries', async () => {
    const custId = setupTestCustomer(0.25);
    setupTestEvent(custId, 'upi_timeout', 3000);

    riskDetector.detectOpportunities(1);

    const db = getDb();
    const opp = db.prepare("SELECT id FROM recovery_opportunities WHERE customer_id = ? LIMIT 1").get(custId) as { id: string };

    await recoveryWorkflow.processOpportunity(opp.id);

    const trail = auditService.getTrail(opp.id);
    expect(trail.length).toBeGreaterThan(0);

    const eventTypes = (trail as Array<{ event_type: string }>).map(e => e.event_type);
    expect(eventTypes).toContain('opportunity_detected');
  }, 15000);

  it('does not create duplicate opportunities for same event', () => {
    const custId = setupTestCustomer();
    setupTestEvent(custId, 'insufficient_funds', 8000);

    const result1 = riskDetector.detectOpportunities(10);
    const result2 = riskDetector.detectOpportunities(10); // Should find nothing new

    expect(result1.created).toBe(1);
    expect(result2.created).toBe(0); // Idempotent
  });

  it('skips already-processed opportunities', async () => {
    const custId = setupTestCustomer(0.2);
    setupTestEvent(custId, 'upi_timeout', 4000);

    riskDetector.detectOpportunities(1);

    const db = getDb();
    const opp = db.prepare("SELECT id FROM recovery_opportunities WHERE customer_id = ? LIMIT 1").get(custId) as { id: string };

    // Mark as already recovered
    db.prepare("UPDATE recovery_opportunities SET status = 'recovered' WHERE id = ?").run(opp.id);

    const result = await recoveryWorkflow.processOpportunity(opp.id);
    expect(result.status).toBe('recovered'); // Returns current status, no double-processing
  }, 5000);

  it('handles malformed opportunity gracefully', async () => {
    await expect(recoveryWorkflow.processOpportunity('nonexistent-id')).rejects.toThrow();
  });
});
