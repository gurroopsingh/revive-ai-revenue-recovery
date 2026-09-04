import { Router } from 'express';
import { getDb } from '../db/database';
import { v4 as uuidv4 } from 'uuid';
import { riskDetector } from '../services/riskDetector';
import { recoveryWorkflow } from '../services/recoveryWorkflow';
import { logger } from '../utils/logger';

export const simulationRouter = Router();

// Used by Demo Control Center to trigger specific hardened scenarios
simulationRouter.post('/run-scenario', async (req, res, next) => {
  try {
    const db = getDb();
    const { scenario } = req.body;
    
    if (scenario === 'load_demo_data') {
      // Simulate new events coming in
      const customers = db.prepare('SELECT id FROM customers ORDER BY RANDOM() LIMIT 20').all() as { id: string }[];
      if (customers.length === 0) return res.status(400).json({ error: 'Run seed first' });
      
      const insert = db.prepare(`
        INSERT INTO payment_events
          (id, customer_id, merchant_id, event_type, amount, currency, status, payment_method, failure_reason, occurred_at)
        VALUES (?, ?, 'merchant_demo', 'payment_failed', ?, 'INR', 'failed', 'upi', 'upi_timeout', ?)
      `);
      
      db.exec('BEGIN');
      for (let i = 0; i < 20; i++) {
        insert.run(uuidv4(), customers[i%customers.length].id, Math.round(1000 + Math.random()*5000), new Date().toISOString());
      }
      db.exec('COMMIT');
      return res.json({ success: true, message: 'Loaded 20 events' });
    }

    if (scenario === 'detect_opportunities') {
      const detection = riskDetector.detectOpportunities(20);
      return res.json({ success: true, detection });
    }

    // For specific scenarios, we create a specialized event/opportunity to guarantee the outcome
    let customerQuery = 'SELECT id FROM customers ORDER BY RANDOM() LIMIT 1';
    let amount = 2500;
    let failure_reason = 'upi_timeout';
    let risk_score_override: number | null = null;
    let is_high_value = false;
    let duplicate = false;

    if (scenario === 'policy_block_high_risk') {
      customerQuery = 'SELECT id FROM customers WHERE risk_score > 0.8 LIMIT 1';
      failure_reason = 'fraud_suspected';
      amount = 85000;
    } else if (scenario === 'high_value_approval') {
      amount = 600000; // > 5L requires approval
    } else if (scenario === 'duplicate_idempotency') {
      duplicate = true;
    }

    let customer = db.prepare(customerQuery).get() as { id: string } | undefined;
    if (!customer && scenario === 'policy_block_high_risk') {
      const custId = uuidv4();
      db.prepare(`
        INSERT INTO customers (id, name, email, risk_score, lifetime_value, total_transactions, successful_transactions, created_at, metadata)
        VALUES (?, 'High-Risk Customer', 'highrisk@example.com', 0.92, 50000, 20, 5, ?, '{}')
      `).run(custId, new Date().toISOString());
      customer = { id: custId };
    }
    
    if (!customer) return res.status(400).json({ error: 'No suitable customer found' });

    const eventId = uuidv4();
    db.prepare(`
      INSERT INTO payment_events
        (id, customer_id, merchant_id, event_type, amount, currency, status, payment_method, failure_reason, occurred_at)
      VALUES (?, ?, 'merchant_demo', 'payment_failed', ?, 'INR', 'failed', 'card', ?, ?)
    `).run(eventId, customer.id, amount, failure_reason, new Date().toISOString());

    riskDetector.detectOpportunities(1);

    const opp = db.prepare('SELECT id FROM recovery_opportunities WHERE payment_event_id = ? LIMIT 1').get(eventId) as { id: string } | undefined;
    if (!opp) return res.status(500).json({ error: 'Failed to detect opportunity' });

    if (scenario === 'ai_failure_fallback') {
      // Force fallback path by injecting an error to Gemini or bypassing
      // We can do this by letting the agent process, but the fallback logic handles it natively if we mock it, 
      // but easier: just call the workflow which has resilient fallback.
      // Wait, to guarantee fallback, we can temporarily sabotage the API key in the agent, or just rely on the fallback logic
      const originalKey = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = 'invalid_key_for_demo';
      const result = await recoveryWorkflow.processOpportunity(opp.id);
      process.env.GEMINI_API_KEY = originalKey;
      return res.json({ success: true, opportunity_id: opp.id, result });
    }

    if (duplicate) {
      // Run it twice concurrently
      const p1 = recoveryWorkflow.processOpportunity(opp.id).catch(e => ({ error: e.message }));
      const p2 = recoveryWorkflow.processOpportunity(opp.id).catch(e => ({ error: e.message }));
      const [res1, res2] = await Promise.all([p1, p2]);
      return res.json({ success: true, opportunity_id: opp.id, runs: [res1, res2], note: 'Second run should be blocked by idempotency or status check' });
    }

    const result = await recoveryWorkflow.processOpportunity(opp.id);
    res.json({ success: true, opportunity_id: opp.id, result });
    
  } catch (err: any) {
    next(err);
  }
});
